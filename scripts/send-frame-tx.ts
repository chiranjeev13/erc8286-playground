// Builds, simulates, and optionally submits an ERC-8286 frame transaction (type 0x06).
//
//   npm run send                # simulate
//   SUBMIT=1 npm run send       # ...and send it
//
// Configured by environment variables, because `hardhat run` does not forward positional
// arguments to a script:
//   TO        recipient                       (default 0x…dEaD)
//   AMOUNT    wei to transfer                 (default 1e15)
//   SUBMIT=1  send it, instead of simulating only
//   BAD_SIG=1 corrupt the signature on purpose (negative control)
//   FORCE=1   submit even if the prefix simulation says invalid
//
// Unlike the devnet's self-verified transfer (where the sender is an EOA and the protocol's
// default code checks the envelope signature), the sender here is an ERC8286FrameAccount:
//
//   frame[0] VERIFY (mode 1), target = the account, flags 0x03
//            data = abi.encodeCall(verify, r(32) || s(32) || v(1))
//            the validator is nonce_keys[0]
//            -> account.verify() delegatecalls the installed module, masks the returned
//               scope with the frame's allowed_scope, and APPROVEs.
//   frame[1] SENDER (mode 2), target = recipient, value = amount
//            -> executes as tx.sender (the account).
//
// The envelope's `signatures` list is empty: authorization is the account's APPROVE, not an
// outer signature.
import {
  AbiCoder,
  SigningKey,
  concat,
  formatEther,
  getBytes,
  hexlify,
  id,
  keccak256,
  toBeHex,
  zeroPadValue,
} from "ethers";
import { Frame, FrameMode, FrameTx, authDigest, type Hex } from "./lib/frametx.js";
import { connect, need } from "./lib/connect.js";

const APPROVE_SCOPE_EXECUTION_AND_PAYMENT = 0x03;
const VERIFY_SELECTOR = id("verify(bytes)").slice(0, 10);

/** One frame's outcome, as ethrex reports it. */
interface FrameResult {
  gasUsed: string;
  succeeded: boolean;
}

/** Response of ethrex_simulateFrameTransaction. */
interface FrameSimulation {
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

interface FrameReceipt {
  status: string;
  gasUsed: string;
  logs: unknown[];
}

interface TypedReceipt {
  blockNumber: string;
  type: string;
  status: string;
  payer?: string;
  frameReceipts?: FrameReceipt[];
}

/**
 * The devnet's sibling RPCs. Frame transactions propagate by full broadcast and not via
 * GetPooledTransactions, so an unlucky submission can sit in one node's mempool while
 * another builds blocks without it.
 */
function peerRpcs(url: string): string[] {
  const match = /^(https?:\/\/)rpc(\d)\.(.+)$/.exec(url);
  if (match === null) return [];
  const [, scheme, index, host] = match;
  return ["1", "2", "3"]
    .filter((i) => i !== index)
    .map((i) => `${scheme}rpc${i}.${host}`);
}

async function sendRaw(url: string, rawTx: string): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransaction",
      params: [rawTx],
    }),
  });
  const body = (await response.json()) as { error?: { message: string } };
  if (body.error !== undefined) throw new Error(body.error.message);
}

const to = process.env.TO ?? "0x000000000000000000000000000000000000dEaD";
const amount = BigInt(process.env.AMOUNT ?? 1_000_000_000_000_000n);
const submit = process.env.SUBMIT === "1";
const badSig = process.env.BAD_SIG === "1";
const force = process.env.FORCE === "1";

const { env, provider, wallet, chainId } = await connect();
const hint = "run `npm run deploy` first";
const account = need(env, "ERC8286FRAMEACCOUNT_ADDRESS", hint);
const validator = need(env, "ECDSAFRAMEVALIDATOR_ADDRESS", hint);
const key = need(env, "DEVNET_PRIVATE_KEY", "generate one with `cast wallet new`");

// EIP-8250: the account selects its validator from nonce_keys[0], and the key set is part
// of the signed envelope, so a relayer cannot substitute another validator.
const nonceKeys = [BigInt(validator)];

// A keyed nonce has its own sequence in NONCE_MANAGER at keccak256(pad32(sender) || pad32(key)).
const NONCE_MANAGER = "0x0000000000000000000000000000000000008250";
const nonceSlot = keccak256(
  concat([zeroPadValue(account, 32), zeroPadValue(toBeHex(nonceKeys[0]!), 32)]),
);
const nonce = Number(
  BigInt(await provider.send("eth_getStorageAt", [NONCE_MANAGER, nonceSlot, "latest"])),
);
const balance = await provider.getBalance(account);
const block = await provider.getBlock("latest");
const maxPriorityFee = 1_000_000_000n;
const maxFee = (block?.baseFeePerGas ?? 0n) * 2n + maxPriorityFee;

console.log(`account   ${account}  balance ${formatEther(balance)} ETH  nonce ${nonce}`);
console.log(`validator ${validator}  owner ${wallet.address}  nonce_seq ${nonce}`);

// The SENDER frames are what the validator's digest commits to, so they are fixed before
// the VERIFY frame's data (which carries the signature over that digest) can exist.
const senderFrame = new Frame({
  mode: FrameMode.SENDER,
  target: to,
  gasLimit: 30_000,
  value: amount,
});

const digest = authDigest({
  chainId,
  nonce,
  sender: account,
  nonceKeys,
  senderFrames: [senderFrame],
});
const sig = new SigningKey(key).sign(digest);
// ECDSAFrameValidator reads r(32) || s(32) || v(1) and hands them to ecrecover, which wants
// v in {27,28} -- which is what ethers' `v` already is.
let frameSig: Hex = concat([sig.r, sig.s, hexlify(new Uint8Array([sig.v]))]);
if (badSig) {
  const bytes = Uint8Array.from(getBytes(frameSig));
  bytes.set([(bytes.at(0) ?? 0) ^ 0xff], 0); // corrupt r so ecrecover yields a different signer
  frameSig = hexlify(bytes);
  console.log("BAD_SIG: signature corrupted on purpose");
}

// A VERIFY frame's `data` is the calldata of the call to its target, so the account's
// verify(bytes) is reached through an ordinary ABI-encoded call.
const payload = frameSig;
const verifyData = concat([
  VERIFY_SELECTOR,
  AbiCoder.defaultAbiCoder().encode(["bytes"], [payload]),
]);

const tx = new FrameTx({
  chainId,
  nonceKeys,
  nonceSeq: nonce,
  sender: account,
  frames: [
    new Frame({
      mode: FrameMode.VERIFY,
      flags: APPROVE_SCOPE_EXECUTION_AND_PAYMENT,
      target: account,
      gasLimit: 200_000,
      data: verifyData,
    }),
    senderFrame,
  ],
  signatures: [],
  maxPriorityFee,
  maxFee,
});

const raw = tx.raw();
console.log(`auth_digest ${digest}`);
console.log(`raw type-0x06 tx: ${getBytes(raw).length} bytes`);

// eth_call cannot represent a frame transaction, so ethrex exposes a dedicated dry-run that
// takes the exact bytes eth_sendRawTransaction would. `valid` covers only the EIP-8141
// validation prefix -- necessary for admission, not sufficient.
const sim: FrameSimulation = await provider.send("ethrex_simulateFrameTransaction", [
  raw,
  "latest",
]);
console.log("\n--- ethrex_simulateFrameTransaction ---");
console.log(JSON.stringify(sim, null, 2));

if (!sim.valid) {
  console.log(`\nINVALID: ${sim.violation}`);
  // The prefix check is a local mempool policy, not consensus: a builder may still include
  // the transaction. FORCE=1 submits anyway, to see what this node's mempool says.
  if (!(force && submit)) process.exit(1);
  console.log("FORCE: submitting anyway");
}

if (!submit) {
  console.log("\nsimulation only; set SUBMIT=1 to send");
  process.exit(0);
}

let hash: string;
try {
  hash = await provider.send("eth_sendRawTransaction", [raw]);
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.log(`\nSUBMIT REJECTED: ${message}`);
  process.exit(1);
}
console.log(`\nsubmitted: ${hash}`);

// Frame-tx gossip between the devnet nodes is best-effort, so a transaction submitted to
// one node may never reach the one that builds the next block. Re-submitting the identical
// bytes to the peers is idempotent (same hash) and is what the devnet guide prescribes.
const peers = peerRpcs(env.DEVNET_RPC ?? "");
if (peers.length > 0) {
  const results = await Promise.allSettled(peers.map((url) => sendRaw(url, raw)));
  const accepted = results.filter((r) => r.status === "fulfilled").length;
  console.log(`also broadcast to ${accepted}/${peers.length} peer RPC(s)`);
}

for (let i = 0; i < 30; i++) {
  const receipt: TypedReceipt | null = await provider.send("eth_getTransactionReceipt", [hash]);
  if (receipt !== null) {
    console.log(
      `MINED block=${Number(receipt.blockNumber)} type=${receipt.type} ` +
        `status=${receipt.status} payer=${receipt.payer}`,
    );
    console.log(JSON.stringify(receipt.frameReceipts, null, 2));
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
console.log("not mined within timeout");
process.exit(1);
