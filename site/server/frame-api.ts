// Playground API, served by the Vite dev/preview server.
//
//   GET  /api/pg/info                  validators, factory, paymaster, head
//   POST /api/pg/deploy                { route, scopes, modes, pkSeed, pkRoot } -> a reserved address; the first tx creates the account
//   GET  /api/pg/account?address=0x..  that account's live config, owner (pkRoot) and balance
//   GET  /api/pg/paymaster             the common Paymaster (address, balance, low); pays for whatever reaches it
//   POST /api/pg/prepare               { account, verify, frames, payer? } -> nonce, fees, and sig_hash, which the key signs
//   POST /api/pg/send                  { account, verify, frames, payer?, nonce, fees, signature } -> simulate, submit
//   GET  /api/pg/receipt?hash=0x..     the type-0x06 receipt, or null
//   GET  /api/pg/history?address=0x..  the account's transactions, newest first: blocks from the explorer, transactions from the node
//
// Accounts are ERC8286FrameAccount clones on ethrex's Hegota testnet (chain 8141), each owned
// by a post-quantum (SPHINCS) key made in the visitor's browser and checked by
// SphincsFrameValidator. The browser signs sig_hash from /prepare and passes the signature to
// /send, which puts it in an EIP-8141 ARBITRARY signature entry; this server never signs for
// an account.
// A Paymaster pays for an account that only approves execution; it checks nothing.

import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
  bytesToHex,
  createPublicClient,
  decodeAbiParameters,
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  hexToBytes,
  http,
  keccak256,
  parseEther,
  toHex,
  type Hex,
} from "viem";
import {
  Frame,
  FrameMode,
  FrameTx,
  KEYED_NONCE_STATE_GAS,
  nonceManagerFor,
  nonceSlot,
  witnessRef,
  witnessSig,
} from "../../scripts/lib/frametx.js";
import { FRAME_MODES, type FrameModeName } from "../../scripts/lib/policy.js";

const CHAIN_ID = 8141;
const ATOMIC_FLAG = 0x04;
/** Below this the paymaster is reported as running low; a person refills it at the faucet. */
const PAYMASTER_LOW = parseEther("0.02");
const MODE_BATCH = "0x0100000000000000000000000000000000000000000000000000000000000000" as const;
/** SphincsFrameValidator's ERC-7201 slot: pkSeed here, pkRoot in the next slot. */
const PQ_SLOT = "0x13be87145d8918acf8bd0fe085758eda945ae7d6045ca14ce964e4eef4fbcf00" as const;
const PQ_ROOT_SLOT = "0x13be87145d8918acf8bd0fe085758eda945ae7d6045ca14ce964e4eef4fbcf01" as const;
/** A sphincs-g signature, the only payload SphincsFrameValidator accepts. */
const SPHINCS_SIG_LEN = 6176;
// The validation prefix (deploy frame, VERIFY, pay frame) may declare at most 500k gas and
// 500k state gas in total. Measured on Hegota: a SPHINCS VERIFY frame uses about 402k gas,
// the pay frame 10k, the deploy frame 23k. The nonce slot takes 97,920 state gas, a clone
// deploy 335,070. The open paymaster's pay frame checks nothing and costs about 5k.
const VERIFY_GAS = 455_000;
const PAY_GAS = 15_000;
const DEPLOY_GAS = 25_000;
const DEPLOY_STATE_GAS = 340_000;
/** EIP-1167 runtime prefix; the configuration follows the 45-byte clone (LibCloneConfig). */
const CLONE_PREFIX = "0x363d3d373d3d3d363d73";
const CLONE_CODE_LEN = 45;
const MODE_BIT: Record<FrameModeName, number> = { single: 1, "single-atomic": 2, batch: 4, "batch-atomic": 8 };
const FACTORY_ABI = [
  { type: "function", name: "createAccount", inputs: [{ type: "address" }, { type: "bytes" }, { type: "bytes32" }], outputs: [{ type: "address" }], stateMutability: "nonpayable" },
  { type: "function", name: "predict", inputs: [{ type: "address" }, { type: "bytes" }, { type: "bytes32" }], outputs: [{ type: "address" }], stateMutability: "view" },
] as const;

const VERIFY_ABI = [{ type: "function", name: "verify", inputs: [{ type: "bytes" }], outputs: [] }] as const;
const PAY_ABI = [{ type: "function", name: "pay", inputs: [], outputs: [] }] as const;
// Account settings are onlySelf, so a SENDER frame targeting the account changes them.
const SETTINGS_ABI = [
  { type: "function", name: "setApprovalScopes", inputs: [{ type: "uint8" }], outputs: [] },
  { type: "function", name: "setExecutionMode", inputs: [{ type: "bytes32" }, { type: "bool" }], outputs: [] },
  { type: "function", name: "setExecutionRoute", inputs: [{ type: "uint8" }], outputs: [] },
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

// This server holds no key. It reads the chain, predicts addresses and relays signed frame
// transactions; every deployment and all funding happens through the repo's scripts and the
// faucet. Accounts and the paymaster are funded by people, not by the playground.
interface Env {
  rpc: string;
  /** SphincsFrameValidator: every playground account's validator, and its nonce key. */
  validator: Hex;
  pqVerifier: Hex | null;
  factory: Hex;
  /** The common paymaster, deployed by scripts/deploy-factory.ts. */
  paymaster: Hex;
  /** The clone implementation; the execution route is per account, in its configuration until the account switches it. */
  impl: Hex;
}

const ENV_KEYS = ["DEVNET_RPC", "SPHINCSFRAMEVALIDATOR_ADDRESS", "SPHINCSVERIFIER_ADDRESS", "ERC8286ACCOUNTFACTORY_ADDRESS", "ERC8286FRAMEACCOUNT_ADDRESS", "PAYMASTER_ADDRESS"] as const;

/** Addresses from the network's env file when developing, from the environment when deployed
 * (Vercel project settings); the environment wins. No key is read anywhere. */
function loadEnv(): Env | null {
  const kv: Record<string, string> = {};
  const path = process.env.FRAME_ENV ?? resolve(process.cwd(), "../.env.hegota-testnet");
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      kv[t.slice(0, t.indexOf("="))] = t.slice(t.indexOf("=") + 1);
    }
  }
  for (const k of ENV_KEYS) if (process.env[k]) kv[k] = process.env[k]!;
  const need = ["SPHINCSFRAMEVALIDATOR_ADDRESS", "ERC8286ACCOUNTFACTORY_ADDRESS", "ERC8286FRAMEACCOUNT_ADDRESS", "PAYMASTER_ADDRESS"];
  if (need.some((k) => !kv[k])) return null;
  return {
    rpc: kv.DEVNET_RPC ?? "https://rpc1.privacy.ethrex.xyz",
    validator: getAddress(kv.SPHINCSFRAMEVALIDATOR_ADDRESS!),
    pqVerifier: kv.SPHINCSVERIFIER_ADDRESS ? getAddress(kv.SPHINCSVERIFIER_ADDRESS) : null,
    factory: getAddress(kv.ERC8286ACCOUNTFACTORY_ADDRESS!),
    paymaster: getAddress(kv.PAYMASTER_ADDRESS!),
    impl: getAddress(kv.ERC8286FRAMEACCOUNT_ADDRESS!),
  };
}

function clients(env: Env) {
  const chain = defineChain({
    id: CHAIN_ID,
    name: "Hegota testnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [env.rpc] } },
  });
  return { pub: createPublicClient({ chain, transport: http(env.rpc) }) };
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
  | { kind: "setMode"; mode: FrameModeName; supported: boolean; atomic: boolean }
  | { kind: "setRoute"; route: 0 | 1; atomic: boolean };

function value(v: unknown): bigint {
  const n = BigInt(String(v ?? "0"));
  // No cap: a transfer the account cannot afford is a failed frame, which is worth seeing.
  if (n < 0n) throw new Error("value out of range");
  return n;
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
    if (f.kind === "setRoute") {
      const route = Number(f.route);
      if (route !== 0 && route !== 1) throw new Error("route must be 0 or 1");
      return { kind: "setRoute", route, atomic: f.atomic === true };
    }
    throw new Error("unknown frame kind");
  });
}

// ---------------------------------------------------------------- accounts

// The server keeps no record. The browser remembers the accounts it created, as an address
// plus the clone spec that produces it, and sends the spec back with each request; the server
// checks that the spec really predicts the address before trusting anything in it.

/** How a clone is (or will be) created: enough to deploy it, or to deploy it inside its first transaction. */
interface CloneSpec {
  implementation: Hex;
  args: Hex;
  salt: Hex;
}

function parseClone(v: unknown): CloneSpec | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const hex = (x: unknown, what: string) => {
    if (typeof x !== "string" || !/^0x[0-9a-fA-F]*$/.test(x)) throw new Error(`clone ${what} must be hex`);
    return x as Hex;
  };
  return { implementation: address(o.implementation, "clone implementation"), args: hex(o.args, "args"), salt: word(o.salt, "clone salt") };
}

/** The spec is trusted only if the factory would put this clone at this address. */
async function resolveClone(env: Env, account: Hex, clone: CloneSpec | null): Promise<CloneSpec | null> {
  if (!clone) return null;
  const { pub } = clients(env);
  if (clone.implementation !== env.impl) throw new Error("clone spec names another implementation");
  const predicted = getAddress(await pub.readContract({ address: env.factory, abi: FACTORY_ABI, functionName: "predict", args: [clone.implementation, clone.args, clone.salt] }));
  if (predicted !== account) throw new Error("clone spec does not produce this address");
  return clone;
}

// ---------------------------------------------------------------- chain reads

const sending = new Map<string, Promise<unknown>>();

/** The account's sequence under nonce key = the validator, which nonce_keys[0] selects. */
async function keyedNonce(env: Env, account: Hex): Promise<number> {
  const stored = await rpc<Hex>(env.rpc, "eth_getStorageAt", [nonceManagerFor(CHAIN_ID), nonceSlot(account, BigInt(env.validator)), "latest"]);
  return Number(BigInt(stored ?? "0x0"));
}

async function pqKeyOf(env: Env, account: Hex): Promise<{ pkSeed: Hex; pkRoot: Hex }> {
  const [pkSeed, pkRoot] = await Promise.all([
    rpc<Hex>(env.rpc, "eth_getStorageAt", [account, PQ_SLOT, "latest"]),
    rpc<Hex>(env.rpc, "eth_getStorageAt", [account, PQ_ROOT_SLOT, "latest"]),
  ]);
  return { pkSeed: pkSeed.toLowerCase() as Hex, pkRoot: pkRoot.toLowerCase() as Hex };
}

/** Whether the account has the playground's validator installed. */
async function hasValidator(env: Env, account: Hex): Promise<boolean> {
  const { pub } = clients(env);
  return pub.readContract({ address: account, abi: READ_ABI, functionName: "isValidatorInstalled", args: [env.validator] });
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
/** The post-quantum key a configuration belongs to, expanded to its two words; null for any
 * other validator (an ECDSA wallet account, or an earlier deployment). */
function ownerFromConfig(env: Env, cfg: CloneConfig): { owner: string; pkSeed: Hex } | null {
  if (cfg.validator !== env.validator) return null;
  const seed = cfg.initData.slice(2, 34);
  const root = cfg.initData.slice(34, 66);
  return { owner: `0x${root}${"0".repeat(32)}`, pkSeed: `0x${seed}${"0".repeat(32)}` };
}

interface AccountView {
  address: Hex;
  balance: bigint;
  nonce: number;
  owner: string;
  pkSeed: Hex | null;
  stale: boolean;
  /** False for an account that will be created by its first transaction. */
  deployed: boolean;
  /** What creates it; the browser keeps this and sends it back. */
  clone: CloneSpec | null;
  scopes: number;
  route: number;
  modes: Record<string, boolean>;
}

async function readAccount(env: Env, addr: Hex, clone: CloneSpec | null): Promise<AccountView> {
  const { pub } = clients(env);
  const code = (await pub.getCode({ address: addr })) ?? "0x";
  const deployed = code.length > 2;
  const argsHex = deployed ? configFromCode(code) : (clone?.args ?? null);
  if (!argsHex) {
    if (deployed) return readLegacyAccount(env, addr);
    throw new Error("this address has no code and no clone spec was given");
  }
  const cfg = parseConfig(argsHex);
  const who = ownerFromConfig(env, cfg);
  const read = <T>(functionName: "approvalScopes" | "executionRoute") => pub.readContract({ address: addr, abi: READ_ABI, functionName }) as Promise<T>;
  const [balance, nonce] = await Promise.all([pub.getBalance({ address: addr }), who ? keyedNonce(env, addr) : 0]);
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
    clone,
    balance,
    nonce,
    owner: who?.owner ?? "0x",
    pkSeed: who?.pkSeed ?? null,
    // Configured for another validator: not usable from this playground.
    stale: who === null,
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
  const installed = await hasValidator(env, addr);
  const [balance, nonce, pq, scopes, route, ...modes] = await Promise.all([
    pub.getBalance({ address: addr }),
    installed ? keyedNonce(env, addr) : 0,
    installed ? pqKeyOf(env, addr) : null,
    read<number>("approvalScopes"),
    read<number>("executionRoute"),
    ...MODE_NAMES.map((n) => pub.readContract({ address: addr, abi: READ_ABI, functionName: "isExecutionModeSupported", args: [FRAME_MODES[n]] })),
  ]);
  return {
    address: addr,
    balance,
    nonce,
    owner: pq?.pkRoot ?? "0x",
    pkSeed: pq?.pkSeed ?? null,
    // Deployed against another validator: it is not the nonce key this playground uses, so
    // verify() would revert. Such accounts are shown but not usable.
    stale: !installed,
    deployed: true,
    clone: null,
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

  const { pub } = clients(env);
  // The configuration goes into the clone's code: SphincsFrameValidator and the packed public
  // key, pkSeed || pkRoot, 16 bytes each.
  const pkSeed = word(body.pkSeed, "pkSeed");
  const pkRoot = word(body.pkRoot, "pkRoot");
  if (!/^0x[0-9a-f]{32}0{32}$/.test(pkSeed) || !/^0x[0-9a-f]{32}0{32}$/.test(pkRoot) || BigInt(pkRoot) === 0n) throw new Error("malformed SPHINCS public key");
  const initData: Hex = `0x${pkSeed.slice(2, 34)}${pkRoot.slice(2, 34)}`;
  const modeBits = names.reduce((n, m) => n | MODE_BIT[m], 0);
  const args = encodePacked(["address", "uint8", "uint8", "uint8", "bytes"], [env.validator, scopes, modeBits, route, initData]);
  const salt = keccak256(encodePacked(["uint256", "bytes"], [BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)), args]));
  const implementation = env.impl;
  const addr = getAddress(await pub.readContract({ address: env.factory, abi: FACTORY_ABI, functionName: "predict", args: [implementation, args, salt] }));
  const clone: CloneSpec = { implementation, args, salt };

  // Counterfactual only: the address is known now and the code arrives with the account's
  // first transaction, in its deploy frame. Funding is the person's: the faucet, or a
  // paymaster-paid first transaction. The browser keeps `clone`; nothing is stored here.
  return await readAccount(env, addr, clone);
}

// ---------------------------------------------------------------- the common paymaster

/** The one Paymaster everyone uses, deployed by the scripts. Refilled by a person at the faucet. */
async function readPaymaster(env: Env) {
  const { pub } = clients(env);
  const balance = await pub.getBalance({ address: env.paymaster });
  return { address: env.paymaster, balance, low: balance < PAYMASTER_LOW };
}

// ---------------------------------------------------------------- build and sign

function senderFrames(account: Hex, frames: FrameIn[]): Frame[] {
  return frames.map((f) => {
    const flags = f.atomic ? ATOMIC_FLAG : 0;
    if (f.kind === "transfer") {
      return new Frame({ mode: FrameMode.SENDER, flags, target: f.target, gasLimit: 40_000, stateGasLimit: 200_000, value: f.valueWei });
    }
    if (f.kind === "setScopes" || f.kind === "setMode" || f.kind === "setRoute") {
      // A frame that targets the account passes verify step 5, so these work on either route.
      const data =
        f.kind === "setScopes"
          ? encodeFunctionData({ abi: SETTINGS_ABI, functionName: "setApprovalScopes", args: [f.scopes] })
          : f.kind === "setMode"
            ? encodeFunctionData({ abi: SETTINGS_ABI, functionName: "setExecutionMode", args: [FRAME_MODES[f.mode], f.supported] })
            : encodeFunctionData({ abi: SETTINGS_ABI, functionName: "setExecutionRoute", args: [f.route] });
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

/** Everything that fixes the transaction besides nonce, fees and signature, read the same way
 * by /prepare and /send: the owner signs sig_hash, so both must build the same bytes. */
async function plan(env: Env, body: Record<string, unknown>) {
  const account = address(body.account, "account");
  const v = (body.verify ?? {}) as Record<string, unknown>;
  const scope = Number(v.scope);
  if (scope !== 1 && scope !== 2 && scope !== 3) throw new Error("scope must be 1, 2 or 3");
  const frames = parseFrames(body.frames);
  const payer = await parsePayer(env, body.payer);
  // With a payer, the account approves execution only: APPROVE(0x3) would make it the payer
  // itself and the paymaster's APPROVE(0x1) would then revert.
  if (payer && scope !== 2) throw new Error("with a paymaster the account's allowed scope must be 0x2");
  const view = await assertCurrent(env, account, parseClone(body.clone));
  if (!view.deployed && !view.clone) throw new Error("this account has no code and no way to get it");
  return { account, scope, frames, payer, view, tamper: v.tamper === true };
}
type Plan = Awaited<ReturnType<typeof plan>>;
interface Fees {
  maxFee: bigint;
  maxPriorityFee: bigint;
}

/** The fees a send signs over, from /prepare; anything else would move sig_hash. */
function parseFees(v: unknown): Fees {
  const o = (v ?? {}) as Record<string, unknown>;
  const n = (x: unknown, what: string) => {
    if (typeof x !== "string" || !/^\d{1,30}$/.test(x)) throw new Error(`${what} must be a decimal string of wei`);
    return BigInt(x);
  };
  const fees = { maxFee: n(o.maxFee, "maxFee"), maxPriorityFee: n(o.maxPriorityFee, "maxPriorityFee") };
  if (fees.maxPriorityFee > fees.maxFee) throw new Error("maxPriorityFee above maxFee");
  return fees;
}

/**
 * The frame transaction for `p`. The owner's signature rides in an ARBITRARY entry whose
 * bytes sig_hash elides, so the transaction without it has the hash the owner signs; the
 * VERIFY frame's data only names that entry.
 */
function buildTx(env: Env, p: Plan, nonce: number, fees: Fees, signature?: Hex): FrameTx {
  return new FrameTx({
    chainId: CHAIN_ID,
    nonceKeys: [BigInt(env.validator)],
    nonceSeq: nonce,
    sender: p.account,
    frames: [
      ...(!p.view.deployed && p.view.clone ? [deployFrame(env, p.view.clone)] : []),
      new Frame({
        mode: FrameMode.VERIFY,
        flags: p.scope,
        target: p.account,
        gasLimit: VERIFY_GAS,
        // Approving payment bumps the sender's nonce, and that slot's state gas is charged
        // to whichever frame approves payment.
        stateGasLimit: p.payer ? 0 : KEYED_NONCE_STATE_GAS,
        data: encodeFunctionData({ abi: VERIFY_ABI, functionName: "verify", args: [witnessRef()] }),
      }),
      ...(p.payer
        ? [
            new Frame({
              mode: FrameMode.VERIFY,
              flags: 1,
              target: p.payer,
              gasLimit: PAY_GAS,
              stateGasLimit: KEYED_NONCE_STATE_GAS,
              data: encodeFunctionData({ abi: PAY_ABI, functionName: "pay" }),
            }),
          ]
        : []),
      ...senderFrames(p.account, p.frames),
    ],
    signatures: [witnessSig(signature)],
    maxPriorityFee: fees.maxPriorityFee,
    maxFee: fees.maxFee,
  });
}

/** What the key signs: sig_hash. The nonce and fees come back to /send unchanged. */
async function prepare(env: Env, p: Plan) {
  const nonce = await keyedNonce(env, p.account);
  const block = await rpc<{ baseFeePerGas?: Hex }>(env.rpc, "eth_getBlockByNumber", ["latest", false]);
  const maxPriorityFee = 1_000_000_000n;
  const fees = { maxPriorityFee, maxFee: BigInt(block.baseFeePerGas ?? "0x0") * 2n + maxPriorityFee };
  const tx = buildTx(env, p, nonce, fees);
  return { nonce, digest: tx.sigHash(), fees: { maxFee: fees.maxFee.toString(), maxPriorityFee: fees.maxPriorityFee.toString() } };
}

/** Refuses an account configured for a validator this playground does not sign for. */
async function assertCurrent(env: Env, account: Hex, clone: CloneSpec | null): Promise<AccountView> {
  const view = await readAccount(env, account, await resolveClone(env, account, clone));
  if (view.stale) throw new Error("this account uses a validator the playground no longer signs for; create a new one");
  return view;
}

/** The DEFAULT frame that creates a counterfactual account, first in the transaction. */
function deployFrame(env: Env, clone: CloneSpec): Frame {
  return new Frame({
    mode: FrameMode.DEFAULT,
    flags: 0,
    target: env.factory,
    gasLimit: DEPLOY_GAS,
    stateGasLimit: DEPLOY_STATE_GAS,
    data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "createAccount", args: [clone.implementation, clone.args, clone.salt] }),
  });
}

async function parsePayer(env: Env, v: unknown): Promise<Hex | null> {
  if (v === undefined || v === null || v === "") return null;
  const addr = address(v, "paymaster address");
  if (addr !== env.paymaster) throw new Error("not the playground paymaster");
  return addr;
}

function tampered(signature: Hex): Hex {
  const bytes = hexToBytes(signature);
  bytes[0] = (bytes[0] ?? 0) ^ 0xff; // SPHINCS's R no longer matches, so the hypertree misses pkRoot
  return bytesToHex(bytes);
}

async function send(env: Env, body: Record<string, unknown>) {
  const p = await plan(env, body);
  const { account, payer, view } = p;
  const nonce = await keyedNonce(env, account);

  // The owner signed sig_hash over a nonce and fees; if a block moved the nonce since, the
  // signature is for a different transaction and must be redone.
  if (typeof body.signature !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${SPHINCS_SIG_LEN * 2}}$`).test(body.signature)) throw new Error(`signature must be ${SPHINCS_SIG_LEN} bytes`);
  if (Number(body.nonce) !== nonce) throw new Error(`nonce moved to ${nonce}; sign again`);
  let signature = body.signature as Hex;
  if (p.tamper) signature = tampered(signature);
  const tx = buildTx(env, p, nonce, parseFees(body.fees), signature);
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
  return { sim, nonce, hash, account, payer, deploys: !view.deployed, gasLimits: tx.frames.map((f) => Number(f.gasLimit)) };
}

// ---------------------------------------------------------------- history

const DORA = "https://dora.privacy.ethrex.xyz";

interface NodeFrame {
  mode: Hex;
  flags: Hex;
  to: Hex | null;
  value: Hex;
  data: Hex;
}
interface NodeTx {
  hash: Hex;
  from: Hex;
  to: Hex | null;
  value: Hex;
  type: Hex;
  frames?: NodeFrame[];
}
interface NodeReceipt {
  status: Hex;
  gasUsed: Hex;
  effectiveGasPrice: Hex;
  payer?: Hex;
  frameReceipts?: { status: Hex }[];
}

/** One call a SENDER frame made: straight to its target, or unpacked from execute(). */
interface HistoryCall {
  to: Hex;
  value: string;
  /** A change to the account's own settings rather than a call out. */
  settings: boolean;
  ok: boolean;
}
export interface HistoryItem {
  hash: Hex;
  block: number;
  time: number;
  /** frame: a frame transaction the account sent. in/out: a plain transaction to or from it. */
  kind: "frame" | "in" | "out";
  status: "ok" | "partial" | "failed";
  /** The other side of a plain transaction. */
  counterparty: Hex | null;
  /** Plain transactions: what moved. Frame transactions: the sum of their calls. */
  value: string;
  fee: string;
  /** Who paid the gas when it was not the account. */
  payer: Hex | null;
  /** Carried a deploy frame: this transaction created the account. */
  creates: boolean;
  calls: HistoryCall[];
}

/**
 * Blocks with transactions to or from the address, newest first, from the explorer's address
 * page (it has no JSON API for this). The explorer indexes frame transactions by sender but
 * hashes them differently from the node, so only its block numbers are used; the transactions
 * themselves are read from the node.
 */
async function historyBlocks(account: Hex, limit: number): Promise<number[]> {
  const res = await fetch(`${DORA}/address/${account}?v=transactions&c=${limit}`);
  if (!res.ok) throw new Error(`Explorer answered HTTP ${res.status}`);
  const html = await res.text();
  const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  const blocks = [...body.matchAll(/href="\/slot\/0x[0-9a-fA-F]+">(.*?)<\/a>/g)].map((m) => Number(m[1]!.replace(/<[^>]+>|\D/g, "")));
  return [...new Set(blocks)].filter((n) => n > 0);
}

/** The calls in one SENDER frame. A frame to the account itself is execute() or a setter. */
function framesCalls(account: Hex, f: NodeFrame, ok: boolean): HistoryCall[] {
  const to = getAddress(f.to ?? account);
  if (to !== account) return [{ to, value: BigInt(f.value).toString(), settings: false, ok }];
  try {
    const { args } = decodeFunctionData({ abi: EXECUTE_ABI, data: f.data });
    const [batch] = decodeAbiParameters(EXECUTIONS, args[1]);
    return batch.map((c) => ({ to: getAddress(c.target), value: c.value.toString(), settings: false, ok }));
  } catch {
    return [{ to, value: BigInt(f.value).toString(), settings: true, ok }];
  }
}

async function history(env: Env, account: Hex, limit: number): Promise<HistoryItem[]> {
  const me = account.toLowerCase();
  const blocks = await historyBlocks(account, limit);
  const perBlock = await Promise.all(
    blocks.map(async (n) => {
      const b = await rpc<{ timestamp: Hex; transactions: NodeTx[] } | null>(env.rpc, "eth_getBlockByNumber", [toHex(n), true]);
      const mine = (b?.transactions ?? []).filter((t) => t.from.toLowerCase() === me || t.to?.toLowerCase() === me);
      return Promise.all(
        mine.map(async (t): Promise<HistoryItem> => {
          const r = await rpc<NodeReceipt>(env.rpc, "eth_getTransactionReceipt", [t.hash]);
          const frames = t.frames ?? [];
          // A frame that ran and was then undone with its atomic group still reads 0x1.
          const ok = frames.map((_, i) => r.frameReceipts?.[i]?.status === "0x1");
          for (let start = 0, i = 0; i < frames.length; i++) {
            if (Number(frames[i]!.flags) & ATOMIC_FLAG && i + 1 < frames.length) continue;
            if (ok.slice(start, i + 1).includes(false)) ok.fill(false, start, i + 1);
            start = i + 1;
          }
          const calls = frames.flatMap((f, i) => (Number(f.mode) === FrameMode.SENDER ? framesCalls(account, f, ok[i]!) : []));
          const outgoing = t.from.toLowerCase() === me;
          const frame = outgoing && t.type === "0x6";
          return {
            hash: t.hash,
            block: n,
            time: Number(b!.timestamp),
            kind: frame ? "frame" : outgoing ? "out" : "in",
            status: !frame || calls.length === 0 ? (r.status === "0x1" ? "ok" : "failed") : calls.every((c) => c.ok) ? "ok" : calls.some((c) => c.ok) ? "partial" : "failed",
            counterparty: frame ? null : outgoing ? (t.to ? getAddress(t.to) : null) : getAddress(t.from),
            value: frame ? calls.reduce((v, c) => v + BigInt(c.value), 0n).toString() : BigInt(t.value).toString(),
            fee: (BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice)).toString(),
            payer: r.payer && r.payer.toLowerCase() !== me ? getAddress(r.payer) : null,
            creates: frames.some((f) => Number(f.mode) === FrameMode.DEFAULT && f.to?.toLowerCase() === env.factory.toLowerCase()),
            calls,
          };
        }),
      );
    }),
  );
  return perBlock.flat().sort((a, b) => b.block - a.block);
}

// ---------------------------------------------------------------- http

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const pre = (req as IncomingMessage & { body?: unknown }).body;
  if (pre && typeof pre === "object") return pre as Record<string, unknown>;
  if (typeof pre === "string") return pre ? (JSON.parse(pre) as Record<string, unknown>) : {};
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
function holdUntilMined(env: Env, account: Hex, nonce: number): void {
  const start = Date.now();
  void (async () => {
    while (Date.now() - start < 40_000) {
      if ((await keyedNonce(env, account).catch(() => nonce)) > nonce) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    sending.delete(account);
  })();
}

export async function handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
  const url = new URL(req.url ?? "/", "http://local");
  if (!url.pathname.startsWith("/api/pg/")) return next();
  const env = loadEnv();
  if (!env) return reply(res, 503, { error: "Playground addresses are not configured (env file or environment)." });

  try {
    if (url.pathname === "/api/pg/info" && req.method === "GET") {
      const { pub } = clients(env);
      const head = await pub.getBlockNumber();
      return reply(res, 200, { chainId: CHAIN_ID, rpc: env.rpc, validator: env.validator, factory: env.factory, paymaster: env.paymaster, head });
    }

    if (url.pathname === "/api/pg/account" && req.method === "GET") {
      const account = address(url.searchParams.get("address"), "account");
      const q = url.searchParams;
      const clone = q.get("implementation") ? parseClone({ implementation: q.get("implementation"), args: q.get("args"), salt: q.get("salt") }) : null;
      return reply(res, 200, await readAccount(env, account, await resolveClone(env, account, clone)));
    }

    if (url.pathname === "/api/pg/paymaster" && req.method === "GET") {
      return reply(res, 200, await readPaymaster(env));
    }

    if (url.pathname === "/api/pg/receipt" && req.method === "GET") {
      const hash = url.searchParams.get("hash") ?? "";
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return reply(res, 400, { error: "bad hash" });
      return reply(res, 200, { receipt: await rpc<unknown>(env.rpc, "eth_getTransactionReceipt", [hash]) });
    }

    if (url.pathname === "/api/pg/history" && req.method === "GET") {
      const account = address(url.searchParams.get("address"), "account");
      return reply(res, 200, { items: await history(env, account, 50) });
    }

    if (url.pathname === "/api/pg/deploy" && req.method === "POST") {
      return reply(res, 200, await deploy(env, await readJson(req)));
    }

    if (url.pathname === "/api/pg/prepare" && req.method === "POST") {
      return reply(res, 200, await prepare(env, await plan(env, await readJson(req))));
    }

    if (url.pathname === "/api/pg/send" && req.method === "POST") {
      const body = await readJson(req);
      const account = address(body.account, "account");
      if (sending.has(account)) return reply(res, 429, { error: "This account's last transaction is still on its way." });
      const work = send(env, body);
      sending.set(account, work);
      try {
        const out = await work;
        if (out.hash) holdUntilMined(env, account, out.nonce);
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

/** The same handler as a plain Node request handler, for a serverless function. */
export function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handle(req, res, () => reply(res, 404, { error: "not found" }));
}
