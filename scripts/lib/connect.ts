import { readFileSync, writeFileSync } from "node:fs";
import {
  createClient,
  custom,
  defineChain,
  publicActions,
  rpcSchema,
  walletActions,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { network } from "hardhat";
import { config, type Env } from "./env.js";

export const HEGOTA_CHAIN_ID = 3151908;

/**
 * The devnet, for viem's benefit: fee handling and local signing need a chain id.
 *
 * `rpcUrls` is decorative -- the transport is Hardhat's connection, so `--network` is still
 * what picks the endpoint (see hardhat.config.ts, which reads DEVNET_RPC).
 */
export const hegota = defineChain({
  id: HEGOTA_CHAIN_ID,
  name: "Hegota EIP-8141 devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc1.hegota.ethrex.xyz"] } },
});

/** One frame's outcome, as ethrex reports it. */
export interface FrameResult {
  gasUsed: string;
  succeeded: boolean;
}

/** Response of `ethrex_simulateFrameTransaction`. */
export interface FrameSimulation {
  valid: boolean;
  prefixShape: string | null;
  payer: string | null;
  maxCost: string | null;
  violation: string | null;
  gasUsed: string | null;
  frames: FrameResult[] | null;
  executionStatus: string | null;
  executionError: string | null;
}

export interface FrameReceipt {
  status: string;
  gasUsed: string;
  logs: unknown[];
}

/** A type-0x06 receipt: the standard fields plus the frame-transaction ones. */
export interface TypedReceipt {
  blockNumber: string;
  type: string;
  status: string;
  payer?: string;
  frameReceipts?: FrameReceipt[];
}

/**
 * The RPC this project issues by hand, declared so `client.request` is typed.
 *
 * `eth_call` cannot represent a frame transaction, so ethrex exposes a dry-run that takes
 * the exact bytes `eth_sendRawTransaction` would. The receipt is fetched raw as well:
 * viem's formatter knows nothing of `payer`/`frameReceipts`, so the frame-shaped receipt is
 * declared here instead. Everything else goes through the ordinary viem actions.
 */
type EthrexRpcSchema = [
  {
    Method: "ethrex_simulateFrameTransaction";
    Parameters: [raw: Hex, block: string];
    ReturnType: FrameSimulation;
  },
  {
    Method: "eth_getTransactionReceipt";
    Parameters: [hash: Hex];
    ReturnType: TypedReceipt | null;
  },
];

/** Hardhat's EIP-1193 provider, as much of it as the transport needs. */
type Eip1193 = {
  request: (args: { method: string; params?: readonly unknown[] | object }) => Promise<unknown>;
};

function makeClient(provider: Eip1193, account: PrivateKeyAccount) {
  return createClient({
    account,
    chain: hegota,
    // Hardhat's provider is EIP-1193, so viem can drive it directly; the cast is only
    // because viem types `params` as `unknown` where Hardhat wants an array or object.
    transport: custom({
      request: ({ method, params }) =>
        provider.request({ method, params: params as readonly unknown[] | undefined }),
    }),
    rpcSchema: rpcSchema<EthrexRpcSchema>(),
  })
    .extend(publicActions)
    .extend(walletActions);
}

export type HegotaClient = ReturnType<typeof makeClient>;

export interface Connection {
  env: Env;
  client: HegotaClient;
  account: PrivateKeyAccount;
  chainId: number;
}

/**
 * A client on the network `--network` selected, plus the parsed .env.devnet.
 *
 * Hardhat supplies the transport (so `--network hegota` is what picks the endpoint) and
 * .env.devnet supplies the key. Deploying and funding here are ordinary type-2
 * transactions; only the frame transactions themselves are hand-encoded.
 */
export async function connect(): Promise<Connection> {
  const env = config(".env.devnet");
  const key = env.DEVNET_PRIVATE_KEY;
  if (key === undefined) {
    throw new Error("DEVNET_PRIVATE_KEY missing from .env.devnet");
  }

  const connection = await network.getOrCreate();
  const account = privateKeyToAccount(key as Hex);
  const client = makeClient(connection.provider, account);
  const chainId = await client.getChainId();
  if (chainId !== HEGOTA_CHAIN_ID) {
    throw new Error(
      `unexpected chain id ${chainId} (want ${HEGOTA_CHAIN_ID} -- pass --network hegota)`,
    );
  }

  return { env, client, account, chainId };
}

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

/** Reads a compiled artifact from Hardhat's output. */
export function artifact(contract: string): Artifact {
  const path = `artifacts/src/reference/${contract}.sol/${contract}.json`;
  return JSON.parse(readFileSync(path, "utf8")) as Artifact;
}

/** Appends (or replaces) a KEY=value line in .env.devnet. */
export function saveEnv(key: string, value: string): void {
  const lines = readFileSync(".env.devnet", "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const kept = lines.filter((l) => !l.startsWith(`${key}=`));
  kept.push(`${key}=${value}`);
  writeFileSync(".env.devnet", `${kept.join("\n")}\n`);
}

/** Required environment variable, with a message that says how to produce it. */
export function need(env: Env, key: string, hint: string): string {
  const value = env[key];
  if (value === undefined) throw new Error(`${key} missing from .env.devnet -- ${hint}`);
  return value;
}
