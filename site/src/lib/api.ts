// Client for the playground API (server/frame-api.ts) and the shared types.

export const DORA = "https://dora.privacy.ethrex.xyz";
export const FAUCET = "https://faucet.privacy.ethrex.xyz";
export const MODES = ["single", "batch", "batch-atomic"] as const;
export type ModeName = (typeof MODES)[number];
/** Any address. The two burn addresses are the quick picks. */
export type Target = string;
export const QUICK_TARGETS = [
  { label: "0x...dEaD", address: "0x000000000000000000000000000000000000dEaD" },
  { label: "0x...bEEF", address: "0x000000000000000000000000000000000000bEEF" },
] as const;
export const DEAD = QUICK_TARGETS[0].address;
export const BEEF = QUICK_TARGETS[1].address;
export const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
export type Scope = 1 | 2 | 3;

/** Plain words for the protocol's numbers. The numbers themselves live in tooltips. */
export const SCOPE_WORD: Record<Scope, string> = { 1: "Pay only", 2: "Execute only", 3: "Pay and execute" };
export const SCOPE_HINT: Record<Scope, string> = { 1: "APPROVE scope 0x1: payment", 2: "APPROVE scope 0x2: execution", 3: "APPROVE scope 0x3: payment and execution" };
export const MODE_WORD: Record<ModeName, string> = { single: "One call", batch: "Several calls", "batch-atomic": "Several calls, all or nothing" };
export const MODE_HINT: Record<ModeName, string> = {
  single: "SENDER frame shape single (callType 0x02, execType 0x01)",
  batch: "SENDER frame shape batch (callType 0x03, execType 0x01)",
  "batch-atomic": "SENDER frame shape batch-atomic (callType 0x03, execType 0x00)",
};
export const ROUTE_WORD = (route: number) => (route === 1 ? "Calls go through the account" : "Calls run directly");
export const ROUTE_HINT = (route: number) => (route === 1 ? "executionRoute() = 0x01 contract: every SENDER frame calls execute()" : "executionRoute() = 0x00 protocol: SENDER frames call their targets");

/** How an account is signed for: an ECDSA wallet, or a post-quantum (SPHINCS) key kept in this browser. */
export type Signer = "wallet" | "pq";
export const SIGNER_WORD: Record<Signer, string> = { wallet: "Wallet", pq: "Post-quantum key" };
export const SIGNER_HINT: Record<Signer, string> = {
  wallet: "ECDSAFrameValidator: secp256k1 ecrecover over EIP-712 typed data carrying sig_hash, 65-byte signature in an ARBITRARY signature entry",
  pq: "SphincsFrameValidator: SPHINCS (sphincs-g, keccak256 only) over sig_hash itself, 6,176-byte signature in an ARBITRARY signature entry, about 389k gas in the VERIFY frame. Verifier: RivaLabs sphincs-g.",
};

/** What creates a clone account: enough for the factory, or for a deploy frame. */
export interface CloneSpec {
  implementation: string;
  args: string;
  salt: string;
}

export interface Account {
  address: string;
  /** Kept by the browser; sent back with requests about an undeployed account. */
  clone: CloneSpec | null;
  balance: string;
  nonce: number;
  signer: Signer;
  /** The wallet that signs for this account, or the public key (pkRoot) of its post-quantum key. */
  owner: string;
  pkSeed: string | null;
  /** Deployed with an earlier validator; cannot be used from this playground. */
  stale: boolean;
  /** False until its first transaction, which carries a deploy frame that creates it. */
  deployed: boolean;
  scopes: number;
  route: number;
  modes: Record<ModeName, boolean>;
}

/** The common paymaster: pays for whatever reaches it. Provisioned and refilled by the server. */
export interface Paymaster {
  address: string;
  balance: string;
  /** Needs a top-up at the faucet. */
  low: boolean;
}

export interface Prepared {
  nonce: number;
  signer: Signer;
  /** What a wallet signs: typed data carrying sig_hash beside the SENDER frames. */
  typedData: unknown;
  /** sig_hash: what a post-quantum key signs directly. */
  digest: string;
  /** Signed over through sig_hash, so they go back to /send unchanged. */
  fees: { maxFee: string; maxPriorityFee: string };
}

export interface Call {
  target: Target;
  eth: number;
}
export interface FrameSpec {
  id: number;
  kind: "transfer" | "execute" | "setScopes" | "setMode";
  target: Target;
  eth: number;
  atomic: boolean;
  calls: Call[];
  /** setScopes */
  scopes?: 1 | 2 | 3;
  /** setMode */
  mode?: ModeName;
  supported?: boolean;
}
export interface VerifySpec {
  scope: Scope;
  tamper: boolean;
}

export interface Info {
  chainId: number;
  rpc: string;
  validator: string;
  pqValidator: string | null;
  factory: string;
  paymaster: string;
  head: string;
}

export interface Sim {
  valid: boolean;
  violation?: string | null;
  prefixShape?: string | null;
  payer?: string | null;
  /** Escrowed at payment approval, wei (hex). */
  maxCost?: string | null;
}
export interface Receipt {
  blockNumber: string;
  status: string;
  gasUsed: string;
  effectiveGasPrice?: string;
  payer?: string;
  frameReceipts?: { status: string; gasUsed: string; stateGasUsed?: string }[];
}

/** One transaction in an account's history, from /api/pg/history. Amounts in wei. */
export interface HistoryItem {
  hash: string;
  block: number;
  time: number;
  /** frame: a frame transaction the account sent. in/out: a plain transaction to or from it. */
  kind: "frame" | "in" | "out";
  status: "ok" | "partial" | "failed";
  counterparty: string | null;
  value: string;
  fee: string;
  /** Who paid the gas when it was not the account. */
  payer: string | null;
  /** This transaction created the account. */
  creates: boolean;
  calls: { to: string; value: string; settings: boolean; ok: boolean }[];
}

/** One frame of a sent transaction, as the result step describes it. */
export interface SentFrame {
  mode: "DEFAULT" | "VERIFY" | "PAY" | "SENDER";
  label: string;
  /** ATOMIC_BATCH_FLAG: this frame and the next succeed or fail together. */
  atomic?: boolean;
  /** VERIFY frames: the allowed scope the account approves against. */
  scope?: number;
}

export type FrameOutcome = "ok" | "bad" | "skip" | "rolled";

/**
 * What each frame came to, from the receipt and the atomic flags that were sent. ethrex
 * records a frame's own execution result, so a frame that completed and was then undone
 * with its atomic group still reads 0x1 there; it is reported here as "rolled".
 */
export function frameOutcomes(sent: { atomic?: boolean }[], receipt: { status: string }[]): (FrameOutcome | undefined)[] {
  const own = receipt.map((r): FrameOutcome => (r.status === "0x1" ? "ok" : r.status === "0x2" ? "skip" : "bad"));
  const out = [...own];
  // Walk the atomic groups: frame i with the flag set is joined to frame i + 1.
  let start = 0;
  for (let i = 0; i < own.length; i++) {
    if (sent[i]?.atomic && i + 1 < own.length) continue;
    const failed = own.slice(start, i + 1).some((o) => o === "bad");
    if (failed) for (let j = start; j <= i; j++) if (own[j] === "ok") out[j] = "rolled";
    start = i + 1;
  }
  return out;
}

export const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
export const ethStr = (wei: string | bigint) => {
  const n = Number(BigInt(wei)) / 1e18;
  return n === 0 ? "0" : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
};
export const toWei = (eth: number) => (BigInt(Math.round(eth * 1e6)) * 1_000_000_000_000n).toString();

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(
    path,
    body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    throw new Error("Playground server is not running. Start it with `npm run dev` in site/.");
  }
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Frame ids only need to be distinct within a session. A random id survives hot reloads of
 * this module, which reset a counter and made a new frame collide with an existing one. */
export const nextId = () => Math.floor(Math.random() * 2 ** 52);
export const transfer = (target: Target, eth = 0.001, atomic = false): FrameSpec => ({ id: nextId(), kind: "transfer", target, eth, atomic, calls: [] });
export const execute = (calls: Call[], atomic = false): FrameSpec => ({ id: nextId(), kind: "execute", target: DEAD, eth: 0, atomic, calls });

export const setScopesFrame = (scopes: 1 | 2 | 3): FrameSpec => ({ id: nextId(), kind: "setScopes", target: DEAD, eth: 0, atomic: false, calls: [], scopes });
export const setModeFrame = (mode: ModeName, supported: boolean): FrameSpec => ({ id: nextId(), kind: "setMode", target: DEAD, eth: 0, atomic: false, calls: [], mode, supported });

/** The SENDER frames that take an account from its current settings to the wanted ones. */
export function settingsFrames(a: Account, scopes: number, modes: Record<ModeName, boolean>): FrameSpec[] {
  const out: FrameSpec[] = [];
  if (scopes !== a.scopes && (scopes === 1 || scopes === 2 || scopes === 3)) out.push(setScopesFrame(scopes));
  for (const m of MODES) if (modes[m] !== a.modes[m]) out.push(setModeFrame(m, modes[m]));
  return out;
}

/** One line describing what a frame does, in plain words. */
export function frameLabel(f: FrameSpec): string {
  if (f.kind === "setScopes") return `Set approval to: ${SCOPE_WORD[f.scopes!].toLowerCase()}`;
  if (f.kind === "setMode") return `${f.supported ? "Allow" : "Disallow"}: ${MODE_WORD[f.mode!].toLowerCase()}`;
  if (f.kind === "execute") return `${f.calls.length} call${f.calls.length > 1 ? "s" : ""} through the account: ${f.calls.map((c) => `${c.eth} ETH to ${short(c.target)}`).join(", ")}`;
  return `${f.eth} ETH to ${short(f.target)}`;
}

/** The protocol-level description of the same frame, for tooltips. */
export function frameHint(f: FrameSpec): string {
  if (f.kind === "setScopes") return `SENDER frame -> account.setApprovalScopes(0x${f.scopes})`;
  if (f.kind === "setMode") return `SENDER frame -> account.setExecutionMode(${f.mode}, ${f.supported})`;
  if (f.kind === "execute") return "SENDER frame -> account.execute(batch mode)";
  return "SENDER frame -> target, caller = tx.sender";
}

export interface Preset {
  id: string;
  label: string;
  note: string;
  verify: VerifySpec;
  frames: () => FrameSpec[];
}
export const PRESETS: Preset[] = [
  { id: "transfer", label: "Transfer", note: "One SENDER frame. Should mine.", verify: { scope: 3, tamper: false }, frames: () => [transfer(DEAD)] },
  { id: "batch", label: "Atomic batch", note: "Two transfers that succeed or fail together.", verify: { scope: 3, tamper: false }, frames: () => [transfer(DEAD, 0.001, true), transfer(BEEF)] },
  { id: "execute", label: "execute()", note: "Calls go through the account. Needs the contract route.", verify: { scope: 3, tamper: false }, frames: () => [execute([{ target: DEAD, eth: 0.001 }, { target: BEEF, eth: 0.001 }])] },
  { id: "rogue", label: "Rogue frame", note: "A frame bypasses execute(). A contract-route account refuses it.", verify: { scope: 3, tamper: false }, frames: () => [execute([{ target: BEEF, eth: 0.001 }]), transfer(DEAD)] },
  { id: "badsig", label: "Bad signature", note: "The validator returns 0x0 and verify reverts.", verify: { scope: 3, tamper: true }, frames: () => [transfer(DEAD)] },
  { id: "payonly", label: "Scope 0x1", note: "Payment can't be approved before execution.", verify: { scope: 1, tamper: false }, frames: () => [transfer(DEAD)] },
];

/** What should happen, from the account's config, the transaction and the payer. Shown before sending. */
export function expectation(a: Account, v: VerifySpec, frames: FrameSpec[], payer: Paymaster | null): { tone: "success" | "warning" | "error"; text: string } {
  if (v.tamper) return { tone: "error", text: "The signature is broken on purpose, so the account will not recognise its owner and the node will refuse the transaction." };
  if (payer) {
    if (v.scope !== 2) return { tone: "error", text: "With a paymaster the account should approve execution only. If it also approves paying, it becomes the payer itself and the paymaster's step fails." };
    if ((a.scopes & 2) === 0) return { tone: "error", text: "This account is not allowed to approve execution, so nothing can run." };
  } else {
    if (BigInt(a.balance) === 0n) return { tone: "error", text: "This account holds nothing, so it cannot pay for the transaction. Send it test ETH from the faucet, or let the paymaster pay." };
    if (v.scope !== 3) return { tone: "error", text: "Without a paymaster the account has to approve both paying and executing. Pick a paymaster, or set the approval to both." };
    if ((a.scopes & 1) === 0) return { tone: "error", text: "This account is not allowed to pay gas. Pick a paymaster to pay for it." };
    if ((a.scopes & 2) === 0) return { tone: "error", text: "This account is not allowed to approve execution, so nothing can run." };
  }
  const batch = frames.length > 1;
  const atomic = frames.some((f) => f.atomic);
  const shape: ModeName = batch ? (atomic ? "batch-atomic" : "batch") : "single";
  if (!a.modes[shape]) return { tone: "error", text: `This transaction has the shape "${MODE_WORD[shape].toLowerCase()}", which this account does not allow. It will be refused.` };
  if (a.route === 1 && frames.some((f) => f.kind === "transfer")) return { tone: "error", text: "This account only runs calls through itself, but one call here goes straight to another address. The account will refuse the whole transaction." };
  const spend = frames.reduce((n, f) => n + (f.kind === "transfer" ? f.eth : f.kind === "execute" ? f.calls.reduce((m, c) => m + c.eth, 0) : 0), 0);
  if (spend > Number(BigInt(a.balance)) / 1e18) {
    return { tone: "warning", text: `The calls move ${spend} ETH but the account holds ${ethStr(a.balance)} ETH. The transaction is still valid: the frame that runs out of funds fails on its own, and gas is paid.` };
  }
  const newScopes = frames.find((f) => f.kind === "setScopes")?.scopes;
  if (newScopes !== undefined && (newScopes & 2) === 0) return { tone: "warning", text: "This removes the account's ability to execute. That cannot be undone: it could never change its own settings again." };
  if (a.route === 0 && frames.some((f) => f.kind === "execute")) return { tone: "warning", text: "This account runs calls directly and has no batch entry point, so the batched call will fail. The account still pays for the transaction." };
  const created = a.deployed ? "" : " The account does not exist yet: the first frame creates it, and the same transaction is its first.";
  if (payer) return { tone: "success", text: `The account approves the calls, paymaster ${short(payer.address)} pays the gas, and the calls run.${created}` };
  return { tone: "success", text: `The account approves, pays the gas, and the calls run.${created}` };
}
