// Playground API, served by the Vite dev/preview server.
//
//   GET  /api/pg/info                  validator, deployer balance, head
//   POST /api/pg/deploy                { route, scopes, modes, owner | pkSeed+pkRoot } -> a reserved, funded address; the first tx creates the account
//   GET  /api/pg/account?address=0x..  that account's live config, owner and balance
//   GET  /api/pg/accounts?owner=a,b    every account this playground deployed for those owners
//                                      (wallet addresses, or SPHINCS pkRoots for post-quantum accounts)
//   POST /api/pg/deploy-paymaster     {} -> a Paymaster, funded; it pays for whatever reaches it
//   GET  /api/pg/paymasters            every open paymaster this playground deployed; anyone may use any
//   POST /api/pg/prepare               { account, frames } -> typed data and digest for the owner
//   POST /api/pg/send                  { account, verify, frames, signature, nonce, payer? } -> simulate, submit
//   GET  /api/pg/receipt?hash=0x..     the type-0x06 receipt, or null
//
// Accounts are ERC8286FrameAccount clones on ethrex's
// Hegota testnet (chain 8141), each owned by a visitor's wallet. The browser signs the typed
// data from /prepare and passes the signature to /send; this server never signs for an account.
// A Paymaster pays for an account that only approves execution; it checks nothing.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  hashTypedData,
  hexToBytes,
  http,
  keccak256,
  parseEther,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  Frame,
  FrameMode,
  FrameTx,
  KEYED_NONCE_STATE_GAS,
  authTypedData,
  nonceManagerFor,
  nonceSlot,
} from "../../scripts/lib/frametx";
import { FRAME_MODES, type FrameModeName } from "../../scripts/lib/policy";

const CHAIN_ID = 8141;
const ATOMIC_FLAG = 0x04;
const FUND = parseEther("0.01");
// Explicit gas on the deployer's own transactions: ethrex's eth_estimateGas simulates with the
// block gas limit (200M) and refuses once balance < 200M * gasPrice, long before funds run out.
const DEPLOY_TX_GAS = 6_000_000n;
const FUND_TX_GAS = 400_000n;
const FUND_PAYMASTER = parseEther("0.05");
const MODE_BATCH = "0x0100000000000000000000000000000000000000000000000000000000000000" as const;
/** ECDSAFrameValidator's ERC-7201 slot: the owner lives here, in the account's storage. */
const OWNER_SLOT = "0x27aa2c0bccf1b67327dd8bf7c4c5cb600687106028be01b120c11c42f5ff9d00" as const;
/** SphincsFrameValidator's ERC-7201 slot: pkSeed here, pkRoot in the next slot. */
const PQ_SLOT = "0x13be87145d8918acf8bd0fe085758eda945ae7d6045ca14ce964e4eef4fbcf00" as const;
const PQ_ROOT_SLOT = "0x13be87145d8918acf8bd0fe085758eda945ae7d6045ca14ce964e4eef4fbcf01" as const;
/** A sphincs-g signature, the only payload SphincsFrameValidator accepts. */
const SPHINCS_SIG_LEN = 6176;
// The validation prefix (deploy frame, VERIFY, pay frame) may declare at most 500k gas and
// 500k state gas in total. Measured on Hegota: a SPHINCS VERIFY frame uses about 402k gas,
// an ECDSA one about 35k, the pay frame 10k, the deploy frame 23k. The nonce slot takes
// 97,920 state gas; a clone deploy 316,710 (wallet) or 335,070 (post-quantum).
// The open paymaster's pay frame checks nothing and costs about 5k.
const VERIFY_GAS: Record<Signer, number> = { wallet: 50_000, pq: 455_000 };
const PAY_GAS = 15_000;
const DEPLOY_GAS = 25_000;
const DEPLOY_STATE_GAS: Record<Signer, number> = { wallet: 320_000, pq: 340_000 };
/** EIP-1167 runtime prefix; the configuration follows the 45-byte clone (LibCloneConfig). */
const CLONE_PREFIX = "0x363d3d373d3d3d363d73";
const CLONE_CODE_LEN = 45;
const MODE_BIT: Record<FrameModeName, number> = { single: 1, "single-atomic": 2, batch: 4, "batch-atomic": 8 };
const FACTORY_ABI = [
  { type: "function", name: "createAccount", inputs: [{ type: "address" }, { type: "bytes" }, { type: "bytes32" }], outputs: [{ type: "address" }], stateMutability: "nonpayable" },
  { type: "function", name: "predict", inputs: [{ type: "address" }, { type: "bytes" }, { type: "bytes32" }], outputs: [{ type: "address" }], stateMutability: "view" },
] as const;

/** How an account is signed for: an ECDSA wallet, or a post-quantum (SPHINCS) key in the browser. */
type Signer = "wallet" | "pq";

const VERIFY_ABI = [{ type: "function", name: "verify", inputs: [{ type: "bytes" }], outputs: [] }] as const;
const PAY_ABI = [{ type: "function", name: "pay", inputs: [], outputs: [] }] as const;
// Account settings are onlySelf, so a SENDER frame targeting the account changes them.
const SETTINGS_ABI = [
  { type: "function", name: "setApprovalScopes", inputs: [{ type: "uint8" }], outputs: [] },
  { type: "function", name: "setExecutionMode", inputs: [{ type: "bytes32" }, { type: "bool" }], outputs: [] },
] as const;
const EXECUTE_ABI = [
  { type: "function", name: "execute", inputs: [{ type: "bytes32" }, { type: "bytes" }], outputs: [], stateMutability: "payable" },
] as const;
const EXECUTIONS = [
  { type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] },
] as const;
const READ_ABI = [
  { type: "function", name: "isValidatorInstalled", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "approvalScopes", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "executionRoute", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "isExecutionModeSupported", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }], stateMutability: "view" },
] as const;

interface Env {
  rpc: string;
  key: Hex;
  validator: Hex;
  /** SphincsFrameValidator, when deployed. */
  pqValidator: Hex | null;
  pqVerifier: Hex | null;
  factory: Hex;
  /** The clone implementation; the execution route is per account, in its configuration. */
  impl: Hex;
}

function loadEnv(): Env | null {
  const path = process.env.FRAME_ENV ?? resolve(process.cwd(), "../.env.hegota-testnet");
  if (!existsSync(path)) return null;
  const kv: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    kv[t.slice(0, t.indexOf("="))] = t.slice(t.indexOf("=") + 1);
  }
  const need = ["DEVNET_PRIVATE_KEY", "ECDSAFRAMEVALIDATOR_ADDRESS", "ERC8286ACCOUNTFACTORY_ADDRESS", "ERC8286FRAMEACCOUNT_ADDRESS"];
  if (need.some((k) => !kv[k])) return null;
  return {
    rpc: kv.DEVNET_RPC ?? "https://rpc1.privacy.ethrex.xyz",
    key: kv.DEVNET_PRIVATE_KEY as Hex,
    validator: getAddress(kv.ECDSAFRAMEVALIDATOR_ADDRESS!),
    pqValidator: kv.SPHINCSFRAMEVALIDATOR_ADDRESS ? getAddress(kv.SPHINCSFRAMEVALIDATOR_ADDRESS) : null,
    pqVerifier: kv.SPHINCSVERIFIER_ADDRESS ? getAddress(kv.SPHINCSVERIFIER_ADDRESS) : null,
    factory: getAddress(kv.ERC8286ACCOUNTFACTORY_ADDRESS!),
    impl: getAddress(kv.ERC8286FRAMEACCOUNT_ADDRESS!),
  };
}

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  return JSON.parse(readFileSync(resolve(process.cwd(), `../artifacts/src/${name}.sol/${name}.json`), "utf8"));
}

function clients(env: Env) {
  const chain = defineChain({
    id: CHAIN_ID,
    name: "Hegota testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [env.rpc] } },
  });
  const account = privateKeyToAccount(env.key);
  return {
    deployer: account,
    pub: createPublicClient({ chain, transport: http(env.rpc) }),
    wallet: createWalletClient({ chain, account, transport: http(env.rpc) }),
  };
}

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

/** Frame-tx gossip is best-effort, so the same bytes also go to the sibling RPCs. */
function peers(url: string): string[] {
  const m = /^(https?:\/\/)rpc(\d)\.(.+)$/.exec(url);
  return m ? ["1", "2", "3"].filter((i) => i !== m[2]).map((i) => `${m[1]}rpc${i}.${m[3]}`) : [];
}

// ---------------------------------------------------------------- input

const MODE_NAMES = Object.keys(FRAME_MODES) as FrameModeName[];
type FrameIn =
  | { kind: "transfer"; target: Hex; valueWei: bigint; atomic: boolean }
  | { kind: "execute"; calls: { target: Hex; valueWei: bigint }[]; atomic: boolean }
  | { kind: "setScopes"; scopes: 1 | 2 | 3; atomic: boolean }
  | { kind: "setMode"; mode: FrameModeName; supported: boolean; atomic: boolean };

function value(v: unknown): bigint {
  const n = BigInt(String(v ?? "0"));
  // No cap: a transfer the account cannot afford is a failed frame, which is worth seeing.
  if (n < 0n) throw new Error("value out of range");
  return n;
}
/** An owner key in the record: a wallet address, or a SPHINCS pkRoot (bytes32). */
function ownerKey(v: unknown): string {
  if (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();
  return address(v, "owner");
}
function word(v: unknown, what: string): Hex {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${what} must be 32 bytes`);
  return v.toLowerCase() as Hex;
}

function address(v: unknown, what = "address"): Hex {
  const s = String(v ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error(`not an ${what}: ${s.slice(0, 20)}`);
  return getAddress(s);
}
function parseFrames(v: unknown): FrameIn[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 4) throw new Error("1 to 4 SENDER frames");
  return v.map((f: Record<string, unknown>) => {
    if (f.kind === "transfer") return { kind: "transfer", target: address(f.target), valueWei: value(f.valueWei), atomic: f.atomic === true };
    if (f.kind === "execute") {
      const calls = Array.isArray(f.calls) ? f.calls : [];
      if (calls.length < 1 || calls.length > 3) throw new Error("1 to 3 calls per execute");
      return { kind: "execute", calls: calls.map((c: Record<string, unknown>) => ({ target: address(c.target), valueWei: value(c.valueWei) })), atomic: f.atomic === true };
    }
    if (f.kind === "setScopes") {
      const scopes = Number(f.scopes);
      if (scopes !== 1 && scopes !== 2 && scopes !== 3) throw new Error("scopes must be 1, 2 or 3");
      return { kind: "setScopes", scopes, atomic: f.atomic === true };
    }
    if (f.kind === "setMode") {
      if (!MODE_NAMES.includes(f.mode as FrameModeName)) throw new Error("unknown frame shape");
      return { kind: "setMode", mode: f.mode as FrameModeName, supported: f.supported === true, atomic: f.atomic === true };
    }
    throw new Error("unknown frame kind");
  });
}

// ---------------------------------------------------------------- deployed accounts

const ACCOUNTS_FILE = resolve(process.cwd(), "../.playground-accounts.json");

/** How a clone is (or will be) created: enough to deploy it, or to deploy it inside its first transaction. */
interface CloneSpec {
  implementation: Hex;
  args: Hex;
  salt: Hex;
}
interface AccountRecord {
  /** A wallet address, or the pkRoot of a post-quantum key. */
  owner: string;
  /** Absent for accounts deployed with their constructor (earlier playground versions). */
  clone?: CloneSpec;
}
interface Record_ {
  accounts: Record<string, AccountRecord>;
  /** paymaster -> "open" (earlier versions recorded a sponsor; those paymasters are ignored) */
  paymasters: Record<string, string>;
}
function loadRecord(): Record_ {
  try {
    if (!existsSync(ACCOUNTS_FILE)) return { accounts: {}, paymasters: {} };
    const raw = JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8")) as Record<string, unknown>;
    // The first version of the file was a bare account -> owner map; the second had string owners.
    const accountsRaw = ("accounts" in raw ? raw.accounts : raw) as Record<string, string | AccountRecord>;
    const accounts = Object.fromEntries(Object.entries(accountsRaw).map(([a, v]) => [a, typeof v === "string" ? { owner: v } : v]));
    return { accounts, paymasters: ("accounts" in raw ? (raw.paymasters ?? {}) : {}) as Record<string, string> };
  } catch {
    return { accounts: {}, paymasters: {} };
  }
}
const record = loadRecord();
const ours = new Map<string, AccountRecord>(Object.entries(record.accounts));
const paymasters = new Map<string, string>(Object.entries(record.paymasters));
function save(): void {
  writeFileSync(ACCOUNTS_FILE, JSON.stringify({ accounts: Object.fromEntries(ours), paymasters: Object.fromEntries(paymasters) }, null, 2) + "\n");
}
function remember(account: Hex, rec: AccountRecord): void {
  ours.set(account, rec);
  save();
}
function rememberPaymaster(paymaster: Hex, sponsor: string): void {
  paymasters.set(paymaster, sponsor);
  save();
}

// ---------------------------------------------------------------- chain reads

const sending = new Map<string, Promise<unknown>>();
let deploying: Promise<unknown> | null = null;

/** The validator an account of this kind selects through nonce_keys[0]. */
function validatorFor(env: Env, signer: Signer): Hex {
  if (signer === "wallet") return env.validator;
  if (!env.pqValidator) throw new Error("SPHINCSFRAMEVALIDATOR_ADDRESS missing: run npm run deploy:pq:testnet");
  return env.pqValidator;
}

async function keyedNonce(env: Env, account: Hex, signer: Signer): Promise<number> {
  const stored = await rpc<Hex>(env.rpc, "eth_getStorageAt", [nonceManagerFor(CHAIN_ID), nonceSlot(account, BigInt(validatorFor(env, signer))), "latest"]);
  return Number(BigInt(stored ?? "0x0"));
}

async function ownerOf(env: Env, account: Hex): Promise<Hex> {
  const word = await rpc<Hex>(env.rpc, "eth_getStorageAt", [account, OWNER_SLOT, "latest"]);
  return getAddress(`0x${word.slice(-40)}`);
}

async function pqKeyOf(env: Env, account: Hex): Promise<{ pkSeed: Hex; pkRoot: Hex }> {
  const [pkSeed, pkRoot] = await Promise.all([
    rpc<Hex>(env.rpc, "eth_getStorageAt", [account, PQ_SLOT, "latest"]),
    rpc<Hex>(env.rpc, "eth_getStorageAt", [account, PQ_ROOT_SLOT, "latest"]),
  ]);
  return { pkSeed: pkSeed.toLowerCase() as Hex, pkRoot: pkRoot.toLowerCase() as Hex };
}

/** Which current validator an account has installed, if any. */
async function signerOf(env: Env, account: Hex): Promise<Signer | null> {
  const { pub } = clients(env);
  const installed = (v: Hex) => pub.readContract({ address: account, abi: READ_ABI, functionName: "isValidatorInstalled", args: [v] });
  const [ecdsa, pq] = await Promise.all([installed(env.validator), env.pqValidator ? installed(env.pqValidator) : false]);
  return ecdsa ? "wallet" : pq ? "pq" : null;
}

/** A clone's configuration: validator (20) || scopes (1) || modeBits (1) || route (1) || initData. */
interface CloneConfig {
  validator: Hex;
  scopes: number;
  modeBits: number;
  route: number;
  initData: Hex;
}
const CONFIG_HEADER = 23;
function parseConfig(args: Hex): CloneConfig {
  const b = hexToBytes(args);
  if (b.length < CONFIG_HEADER) throw new Error("configuration too short");
  return { validator: getAddress(bytesToHex(b.slice(0, 20))), scopes: b[20]!, modeBits: b[21]!, route: b[22]!, initData: bytesToHex(b.slice(CONFIG_HEADER)) };
}
/** The configuration appended to a clone's runtime code, or null if the code is not a clone. */
function configFromCode(code: Hex): Hex | null {
  if (!code.toLowerCase().startsWith(CLONE_PREFIX) || (code.length - 2) / 2 < CLONE_CODE_LEN + CONFIG_HEADER) return null;
  return `0x${code.slice(2 + CLONE_CODE_LEN * 2)}` as Hex;
}
/** Who a configuration belongs to: the wallet address, or the post-quantum key expanded to its two words. */
function ownerFromConfig(env: Env, cfg: CloneConfig): { signer: Signer | null; owner: string; pkSeed: Hex | null } {
  if (cfg.validator === env.validator) return { signer: "wallet", owner: getAddress(`0x${cfg.initData.slice(2, 42)}`), pkSeed: null };
  if (env.pqValidator && cfg.validator === env.pqValidator) {
    const seed = cfg.initData.slice(2, 34);
    const root = cfg.initData.slice(34, 66);
    return { signer: "pq", owner: `0x${root}${"0".repeat(32)}`, pkSeed: `0x${seed}${"0".repeat(32)}` };
  }
  return { signer: null, owner: "0x", pkSeed: null };
}

interface AccountView {
  address: Hex;
  balance: bigint;
  nonce: number;
  signer: Signer;
  owner: string;
  pkSeed: Hex | null;
  stale: boolean;
  /** False for an account that will be created by its first transaction. */
  deployed: boolean;
  scopes: number;
  route: number;
  modes: Record<string, boolean>;
}

async function readAccount(env: Env, addr: Hex): Promise<AccountView> {
  const { pub } = clients(env);
  const rec = ours.get(addr);
  const code = (await pub.getCode({ address: addr })) ?? "0x";
  const deployed = code.length > 2;
  const argsHex = deployed ? configFromCode(code) : (rec?.clone?.args ?? null);
  if (!argsHex) return readLegacyAccount(env, addr);
  const cfg = parseConfig(argsHex);
  const who = ownerFromConfig(env, cfg);
  const signer: Signer = who.signer ?? "wallet";
  const read = <T>(functionName: "approvalScopes" | "executionRoute") => pub.readContract({ address: addr, abi: READ_ABI, functionName }) as Promise<T>;
  const [balance, nonce] = await Promise.all([pub.getBalance({ address: addr }), who.signer ? keyedNonce(env, addr, signer) : 0]);
  // Settings may have been changed since creation, so a deployed account is asked; an
  // undeployed one can only have what its configuration says.
  const [scopes, route, ...modes] = deployed
    ? await Promise.all([
        read<number>("approvalScopes"),
        read<number>("executionRoute"),
        ...MODE_NAMES.map((n) => pub.readContract({ address: addr, abi: READ_ABI, functionName: "isExecutionModeSupported", args: [FRAME_MODES[n]] })),
      ])
    : [cfg.scopes, cfg.route, ...MODE_NAMES.map((n) => (cfg.modeBits & MODE_BIT[n]) !== 0)];
  return {
    address: addr,
    balance,
    nonce,
    signer,
    owner: who.owner,
    pkSeed: who.pkSeed,
    // Configured for an earlier validator: not usable from this playground.
    stale: who.signer === null,
    deployed,
    scopes: Number(scopes),
    route: Number(route),
    modes: Object.fromEntries(MODE_NAMES.map((n, i) => [n, modes[i] as boolean])),
  };
}

/** An account from before clones: configured in storage by its constructor. */
async function readLegacyAccount(env: Env, addr: Hex): Promise<AccountView> {
  const { pub } = clients(env);
  const read = <T>(functionName: "approvalScopes" | "executionRoute") => pub.readContract({ address: addr, abi: READ_ABI, functionName }) as Promise<T>;
  const installed = await signerOf(env, addr);
  const signer: Signer = installed ?? "wallet";
  const [balance, nonce, owner, pq, scopes, route, ...modes] = await Promise.all([
    pub.getBalance({ address: addr }),
    installed ? keyedNonce(env, addr, signer) : 0,
    signer === "wallet" ? ownerOf(env, addr) : pqKeyOf(env, addr).then((k) => k.pkRoot),
    signer === "pq" ? pqKeyOf(env, addr) : null,
    read<number>("approvalScopes"),
    read<number>("executionRoute"),
    ...MODE_NAMES.map((n) => pub.readContract({ address: addr, abi: READ_ABI, functionName: "isExecutionModeSupported", args: [FRAME_MODES[n]] })),
  ]);
  return {
    address: addr,
    balance,
    nonce,
    signer,
    owner,
    pkSeed: pq?.pkSeed ?? null,
    // Deployed against an earlier validator: its digest differs and it is not the nonce key
    // this playground uses, so verify() would revert. Such accounts are shown but not usable.
    stale: installed === null,
    deployed: true,
    scopes: Number(scopes),
    route: Number(route),
    modes: Object.fromEntries(MODE_NAMES.map((n, i) => [n, modes[i] as boolean])),
  };
}

// ---------------------------------------------------------------- deploy

async function deploy(env: Env, body: Record<string, unknown>) {
  const route = Number(body.route) === 1 ? 1 : 0;
  const scopes = Number(body.scopes);
  if (scopes !== 1 && scopes !== 2 && scopes !== 3) throw new Error("scopes must be 1, 2 or 3");
  const names = (Array.isArray(body.modes) ? body.modes : []).filter((m): m is FrameModeName => MODE_NAMES.includes(m as FrameModeName));
  if (names.length === 0) throw new Error("pick at least one frame shape");

  const { pub, wallet } = clients(env);
  // The configuration goes into the clone's code: a post-quantum account names
  // SphincsFrameValidator and its packed public key, a wallet account names
  // ECDSAFrameValidator and the wallet address.
  const signer: Signer = body.signer === "pq" ? "pq" : "wallet";
  let owner: string;
  let initData: Hex;
  if (signer === "pq") {
    const pkSeed = word(body.pkSeed, "pkSeed");
    const pkRoot = word(body.pkRoot, "pkRoot");
    if (!/^0x[0-9a-f]{32}0{32}$/.test(pkSeed) || !/^0x[0-9a-f]{32}0{32}$/.test(pkRoot) || BigInt(pkRoot) === 0n) throw new Error("malformed SPHINCS public key");
    owner = pkRoot;
    initData = `0x${pkSeed.slice(2, 34)}${pkRoot.slice(2, 34)}`;
  } else {
    owner = address(body.owner, "owner address");
    initData = owner as Hex;
  }
  const modeBits = names.reduce((n, m) => n | MODE_BIT[m], 0);
  const args = encodePacked(["address", "uint8", "uint8", "uint8", "bytes"], [validatorFor(env, signer), scopes, modeBits, route, initData]);
  const salt = keccak256(encodePacked(["uint256", "bytes"], [BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)), args]));
  const implementation = env.impl;
  const addr = getAddress(await pub.readContract({ address: env.factory, abi: FACTORY_ABI, functionName: "predict", args: [implementation, args, salt] }));
  const clone: CloneSpec = { implementation, args, salt };

  // Counterfactual only: the address is known and funded now; the code arrives with the
  // account's first transaction, in its deploy frame.
  const fund = await wallet.sendTransaction({ to: addr, value: FUND, gas: FUND_TX_GAS });
  await pub.waitForTransactionReceipt({ hash: fund });
  remember(addr, { owner, clone });
  return await readAccount(env, addr);
}

const OPEN = "open";
const openPaymasters = () => [...paymasters.entries()].filter(([, v]) => v === OPEN).map(([a]) => a as Hex);

async function readPaymaster(env: Env, addr: Hex) {
  const { pub } = clients(env);
  return { address: addr, balance: await pub.getBalance({ address: addr }) };
}

/** Paymaster: pays for whatever reaches it. The deployer can take the balance back. */
async function deployPaymaster(env: Env) {
  const { pub, wallet, deployer } = clients(env);
  const { abi, bytecode } = artifact("Paymaster");
  const hash = await wallet.deployContract({ abi, bytecode, args: [deployer.address], gas: DEPLOY_TX_GAS });
  const { contractAddress } = await pub.waitForTransactionReceipt({ hash });
  if (!contractAddress) throw new Error("deployment mined without an address");
  const fund = await wallet.sendTransaction({ to: contractAddress, value: FUND_PAYMASTER, gas: FUND_TX_GAS });
  await pub.waitForTransactionReceipt({ hash: fund });
  const addr = getAddress(contractAddress);
  rememberPaymaster(addr, OPEN);
  return { ...(await readPaymaster(env, addr)), deployTx: hash };
}

// ---------------------------------------------------------------- build and sign

function senderFrames(account: Hex, frames: FrameIn[]): Frame[] {
  return frames.map((f) => {
    const flags = f.atomic ? ATOMIC_FLAG : 0;
    if (f.kind === "transfer") {
      return new Frame({ mode: FrameMode.SENDER, flags, target: f.target, gasLimit: 40_000, stateGasLimit: 200_000, value: f.valueWei });
    }
    if (f.kind === "setScopes" || f.kind === "setMode") {
      const data =
        f.kind === "setScopes"
          ? encodeFunctionData({ abi: SETTINGS_ABI, functionName: "setApprovalScopes", args: [f.scopes] })
          : encodeFunctionData({ abi: SETTINGS_ABI, functionName: "setExecutionMode", args: [FRAME_MODES[f.mode], f.supported] });
      // One SSTORE, possibly a fresh slot: 64 state bytes at 1530 gas.
      return new Frame({ mode: FrameMode.SENDER, flags, target: account, gasLimit: 60_000, stateGasLimit: 120_000, data });
    }
    const batch = encodeAbiParameters(EXECUTIONS, [f.calls.map((c) => ({ target: c.target, value: c.valueWei, callData: "0x" as Hex }))]);
    return new Frame({
      mode: FrameMode.SENDER,
      flags,
      target: account,
      gasLimit: 60_000 + 40_000 * f.calls.length,
      stateGasLimit: 200_000 * f.calls.length,
      data: encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [MODE_BATCH, batch] }),
    });
  });
}

/** What the owner signs: a wallet gets the typed data, a post-quantum key the digest. */
async function prepare(env: Env, account: Hex, signer: Signer, frames: FrameIn[]) {
  const nonce = await keyedNonce(env, account, signer);
  const input = { chainId: CHAIN_ID, nonce, sender: account, nonceKeys: [BigInt(validatorFor(env, signer))], senderFrames: senderFrames(account, frames) };
  // Wallets want domain.chainId as a number; every other bigint is fine as a decimal string.
  const forWallet = (acct: Hex) => {
    const td = authTypedData({ ...input, account: acct });
    return { ...td, domain: { ...td.domain, chainId: CHAIN_ID } };
  };
  const typedData = forWallet(account);
  // The same message both validators check: the SPHINCS signer signs this hash directly.
  const digest = hashTypedData(typedData as Parameters<typeof hashTypedData>[0]);
  return { nonce, signer, typedData, digest };
}

/** Refuses an account configured for a validator this playground does not sign for. */
async function assertCurrent(env: Env, account: Hex): Promise<AccountView> {
  const view = await readAccount(env, account);
  if (view.stale) throw new Error("this account was deployed with an earlier validator; deploy a new one");
  return view;
}

/** The DEFAULT frame that creates a counterfactual account, first in the transaction. */
function deployFrame(env: Env, clone: CloneSpec, signer: Signer): Frame {
  return new Frame({
    mode: FrameMode.DEFAULT,
    flags: 0,
    target: env.factory,
    gasLimit: DEPLOY_GAS,
    stateGasLimit: DEPLOY_STATE_GAS[signer],
    data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "createAccount", args: [clone.implementation, clone.args, clone.salt] }),
  });
}

function parsePayer(v: unknown): Hex | null {
  if (v === undefined || v === null || v === "") return null;
  const addr = address(v, "paymaster address");
  if (paymasters.get(addr) !== OPEN) throw new Error("not a playground paymaster");
  return addr;
}

function tampered(signature: Hex): Hex {
  const bytes = hexToBytes(signature);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff; // ecrecover yields someone else; SPHINCS's R no longer matches
  return bytesToHex(bytes);
}

async function send(env: Env, body: Record<string, unknown>) {
  const account = address(body.account, "account");
  if (!ours.has(account)) throw new Error("not a playground account");
  const v = (body.verify ?? {}) as Record<string, unknown>;
  const scope = Number(v.scope);
  if (scope !== 1 && scope !== 2 && scope !== 3) throw new Error("scope must be 1, 2 or 3");
  const frames = parseFrames(body.frames);
  const payer = parsePayer(body.payer);
  // With a payer, the account approves execution only: APPROVE(0x3) would make it the payer
  // itself and the paymaster's APPROVE(0x1) would then revert.
  if (payer && scope !== 2) throw new Error("with a paymaster the account's allowed scope must be 0x2");

  const view = await assertCurrent(env, account);
  const signer = view.signer;
  const { nonce } = await prepare(env, account, signer, frames);
  const clone = ours.get(account)?.clone;
  if (!view.deployed && !clone) throw new Error("this account has no code and no way to get it");

  // The owner signed the message from /prepare over a nonce; if a block moved it since,
  // the signature is for a different transaction and must be redone.
  const sigLen = signer === "pq" ? SPHINCS_SIG_LEN : 65;
  if (typeof body.signature !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${sigLen * 2}}$`).test(body.signature)) throw new Error(`signature must be ${sigLen} bytes`);
  if (Number(body.nonce) !== nonce) throw new Error(`nonce moved to ${nonce}; sign again`);
  let signature = body.signature as Hex;
  if (v.tamper === true) signature = tampered(signature);
  const verifyGas = VERIFY_GAS[signer];

  const block = await rpc<{ baseFeePerGas?: Hex }>(env.rpc, "eth_getBlockByNumber", ["latest", false]);
  const maxPriorityFee = 1_000_000_000n;
  const maxFee = BigInt(block.baseFeePerGas ?? "0x0") * 2n + maxPriorityFee;
  const tx = new FrameTx({
    chainId: CHAIN_ID,
    nonceKeys: [BigInt(validatorFor(env, signer))],
    nonceSeq: nonce,
    sender: account,
    frames: [
      ...(!view.deployed && clone ? [deployFrame(env, clone, signer)] : []),
      new Frame({
        mode: FrameMode.VERIFY,
        flags: scope,
        target: account,
        gasLimit: verifyGas,
        // Approving payment bumps the sender's nonce, and that slot's state gas is charged
        // to whichever frame approves payment.
        stateGasLimit: payer ? 0 : KEYED_NONCE_STATE_GAS,
        data: encodeFunctionData({ abi: VERIFY_ABI, functionName: "verify", args: [signature] }),
      }),
      ...(payer
        ? [
            new Frame({
              mode: FrameMode.VERIFY,
              flags: 1,
              target: payer,
              gasLimit: PAY_GAS,
              stateGasLimit: KEYED_NONCE_STATE_GAS,
              data: encodeFunctionData({ abi: PAY_ABI, functionName: "pay" }),
            }),
          ]
        : []),
      ...senderFrames(account, frames),
    ],
    signatures: [],
    maxPriorityFee,
    maxFee,
  });
  const raw = tx.raw();

  let sim: Record<string, unknown>;
  try {
    sim = await rpc<Record<string, unknown>>(env.rpc, "ethrex_simulateFrameTransaction", [raw, "latest"]);
  } catch (e) {
    // The node rejected the envelope outright (static checks): that is a result, not an error.
    sim = { valid: false, violation: e instanceof Error ? e.message : String(e) };
  }
  if (!sim.valid) return { sim, nonce, hash: null };
  const hash = await rpc<Hex>(env.rpc, "eth_sendRawTransaction", [raw]);
  await Promise.allSettled(peers(env.rpc).map((u) => rpc(u, "eth_sendRawTransaction", [raw])));
  return { sim, nonce, signer, hash, account, payer, deploys: !view.deployed, gasLimits: tx.frames.map((f) => Number(f.gasLimit)) };
}

// ---------------------------------------------------------------- http

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 65536) throw new Error("body too large"); // a SPHINCS signature is 12 KB of hex
  }
  return data ? JSON.parse(data) : {};
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
}

/** Holds the account's send lock until its keyed nonce moves past `nonce` (or 40s). */
function holdUntilMined(env: Env, account: Hex, signer: Signer, nonce: number): void {
  const start = Date.now();
  void (async () => {
    while (Date.now() - start < 40_000) {
      if ((await keyedNonce(env, account, signer).catch(() => nonce)) > nonce) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    sending.delete(account);
  })();
}

async function handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
  const url = new URL(req.url ?? "/", "http://local");
  if (!url.pathname.startsWith("/api/pg/")) return next();
  const env = loadEnv();
  if (!env) return reply(res, 503, { error: "Missing ../.env.hegota-testnet" });

  try {
    if (url.pathname === "/api/pg/info" && req.method === "GET") {
      const { deployer, pub } = clients(env);
      const [balance, head] = await Promise.all([pub.getBalance({ address: deployer.address }), pub.getBlockNumber()]);
      return reply(res, 200, { chainId: CHAIN_ID, rpc: env.rpc, validator: env.validator, pqValidator: env.pqValidator, factory: env.factory, deployer: deployer.address, balance, head });
    }

    if (url.pathname === "/api/pg/account" && req.method === "GET") {
      return reply(res, 200, await readAccount(env, address(url.searchParams.get("address"), "account")));
    }

    if (url.pathname === "/api/pg/accounts" && req.method === "GET") {
      const owners = new Set((url.searchParams.get("owner") ?? "").split(",").filter(Boolean).map(ownerKey));
      const mine = [...ours.entries()].filter(([, r]) => owners.has(r.owner.length === 66 ? r.owner.toLowerCase() : r.owner)).map(([a]) => a as Hex);
      const results = await Promise.allSettled(mine.map((a) => readAccount(env, a)));
      return reply(res, 200, { accounts: results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])).reverse() });
    }

    if (url.pathname === "/api/pg/paymasters" && req.method === "GET") {
      const results = await Promise.allSettled(openPaymasters().map((a) => readPaymaster(env, a)));
      return reply(res, 200, { paymasters: results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])).reverse() });
    }

    if (url.pathname === "/api/pg/deploy-paymaster" && req.method === "POST") {
      if (deploying) return reply(res, 429, { error: "Another deployment is in progress." });
      deploying = deployPaymaster(env);
      try {
        return reply(res, 200, await deploying);
      } finally {
        deploying = null;
      }
    }

    if (url.pathname === "/api/pg/receipt" && req.method === "GET") {
      const hash = url.searchParams.get("hash") ?? "";
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return reply(res, 400, { error: "bad hash" });
      return reply(res, 200, { receipt: await rpc<unknown>(env.rpc, "eth_getTransactionReceipt", [hash]) });
    }

    if (url.pathname === "/api/pg/deploy" && req.method === "POST") {
      if (deploying) return reply(res, 429, { error: "Another account is being deployed." });
      deploying = deploy(env, await readJson(req));
      try {
        return reply(res, 200, await deploying);
      } finally {
        deploying = null;
      }
    }

    if (url.pathname === "/api/pg/prepare" && req.method === "POST") {
      const body = await readJson(req);
      const account = address(body.account, "account");
      if (!ours.has(account)) throw new Error("not a playground account");
      const view = await assertCurrent(env, account);
      return reply(res, 200, await prepare(env, account, view.signer, parseFrames(body.frames)));
    }

    if (url.pathname === "/api/pg/send" && req.method === "POST") {
      const body = await readJson(req);
      const account = address(body.account, "account");
      if (sending.has(account)) return reply(res, 429, { error: "This account's last transaction is still on its way." });
      const work = send(env, body);
      sending.set(account, work);
      try {
        const out = await work;
        if (out.hash) holdUntilMined(env, account, out.signer, out.nonce);
        else sending.delete(account);
        return reply(res, 200, out);
      } catch (e) {
        sending.delete(account);
        throw e;
      }
    }
    return reply(res, 404, { error: "not found" });
  } catch (e) {
    // viem puts the useful part ("Details: ...") on a later line.
    const lines = e instanceof Error ? e.message.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("Version:") && !l.startsWith("Docs:")) : [String(e)];
    return reply(res, 502, { error: [lines[0], lines.find((l) => l.startsWith("Details:"))].filter(Boolean).join(" ") });
  }
}

export function frameApi(): Plugin {
  type Mw = { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void };
  const mount = (mw: Mw) => {
    mw.use((req, res, next) => void handle(req, res, next));
  };
  return {
    name: "erc8286-playground-api",
    // Block bodies on purpose: a function returned from these hooks is run as a post-hook.
    configureServer(server) {
      mount(server.middlewares);
    },
    configurePreviewServer(server) {
      mount(server.middlewares);
    },
  };
}
