import { readFileSync, writeFileSync } from "node:fs";
import { BrowserProvider, Wallet, type InterfaceAbi } from "ethers";
import { network } from "hardhat";
import { config, type Env } from "./env.js";

export const HEGOTA_CHAIN_ID = 3151908;

export interface Connection {
  env: Env;
  provider: BrowserProvider;
  wallet: Wallet;
  chainId: number;
}

/**
 * A wallet on the network `--network` selected, plus the parsed .env.devnet.
 *
 * Hardhat supplies the connection (so `--network hegota` is what picks the endpoint) and
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
  const provider = new BrowserProvider(connection.provider);
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== HEGOTA_CHAIN_ID) {
    throw new Error(
      `unexpected chain id ${chainId} (want ${HEGOTA_CHAIN_ID} -- pass --network hegota)`,
    );
  }

  return { env, provider, wallet: new Wallet(key, provider), chainId };
}

export interface Artifact {
  abi: InterfaceAbi;
  bytecode: string;
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
