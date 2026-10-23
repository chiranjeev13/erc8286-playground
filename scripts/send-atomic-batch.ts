// Builds, simulates, and optionally submits an ERC-8286 atomic batch: one VERIFY frame
// followed by several SENDER frames grouped into a single EIP-8141 atomic batch.
//
//   npm run send:batch
//
// What it sends is set by the constants below -- `hardhat run` forwards no positional
// arguments, so edit them in place.
//
// EIP-8141 groups frames by a flag bit rather than by a container: an atomic batch is the
// maximal contiguous run of frames [i, j] where frames i..j-1 carry ATOMIC_BATCH_FLAG and
// frame j does not. The flag therefore goes on every member *except* the last -- it reads as
// "this frame is joined to the next one".
import {
  encodeFunctionData,
  formatEther,
  getAddress,
  size,
  type Address,
  type Hex,
} from "viem";
import { Frame, FrameMode, FrameTx, KEYED_NONCE_STATE_GAS, authDigest, nonceManagerFor, nonceSlot, witnessRef, witnessSig } from "./lib/frametx.js";
import { connect, need, simulate, type TypedReceipt } from "./lib/connect.js";

const APPROVE_SCOPE_EXECUTION_AND_PAYMENT = 0x03;

/** EIP-8141 `flags` bit 2: this frame is joined to the next one. Bits 0-1 are the scope. */
const ATOMIC_BATCH_FLAG = 0x04;

const FRAME_MODE_BATCH = `0x0301${"00".repeat(30)}` as Hex;
const FRAME_MODE_BATCH_ATOMIC = `0x0300${"00".repeat(30)}` as Hex;

const VERIFY_ABI = [
  { type: "function", name: "verify", inputs: [{ type: "bytes" }], outputs: [] },
] as const;
const ACCOUNT_ABI = [
  {
    type: "function",
    name: "supportsExecutionMode",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;
// A view call that always reverts ("not this account"), used as the failing batch member.
const VALIDATOR_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const;

/** Group the frames into one atomic batch; false presents BATCH instead of BATCH_ATOMIC. */
const atomic: boolean = true;
/** Append a SENDER frame that reverts, so an atomic group is seen to roll back. */
const revertLast: boolean = false;
/** Submit it, rather than simulating only. */
const submit: boolean = true;
/** Submit even if the prefix simulation says invalid. */
const force: boolean = false;
/** Wei per transfer. */
const amount = 100_000_000_000_000n;
/** One SENDER frame per recipient. */
const recipients = [
  "0x000000000000000000000000000000000000dEaD",
  "0x000000000000000000000000000000000000bEEF",
].map((t) => getAddress(t));

const { env, client, account: owner, chainId } = await connect();
const hint = "run `npm run deploy` first";
const account = getAddress(need(env, "ERC8286FRAMEACCOUNT_ADDRESS", hint));
const validator = getAddress(need(env, "ECDSAFRAMEVALIDATOR_ADDRESS", hint));

const nonceKeys = [BigInt(validator)];
const stored = await client.getStorageAt({
  address: nonceManagerFor(chainId),
  slot: nonceSlot(account, nonceKeys[0]!),
});
const nonce = Number(BigInt(stored ?? "0x0"));
const balance = await client.getBalance({ address: account });
const block = await client.getBlock();
const maxPriorityFee = 1_000_000_000n;
const maxFee = (block.baseFeePerGas ?? 0n) * 2n + maxPriorityFee;

console.log(`account   ${account}  balance ${formatEther(balance)} ETH  nonce ${nonce}`);
console.log(`validator ${validator}  owner ${owner.address}`);

// The SENDER frames, in the order the digest and the flag chain both walk them.
const senderFrames = recipients.map(
  (to) =>
    // EIP-8037: a transfer that creates the recipient account pays 120 state bytes.
    new Frame({ mode: FrameMode.SENDER, target: to, gasLimit: 300_000, stateGasLimit: 200_000, value: amount }),
);

if (revertLast) {
  senderFrames.push(
    new Frame({
      mode: FrameMode.SENDER,
      target: validator,
      gasLimit: 300_000,
      data: encodeFunctionData({
        abi: VALIDATOR_ABI,
        functionName: "ownerOf",
        args: [account as Address],
      }),
    }),
  );
}

// The flag joins a frame to its successor, so every member but the last carries it. Setting
// it on the last frame would instead pull whatever follows into the group.
const grouped = senderFrames.map(
  (f, i) =>
    new Frame({
      mode: f.mode,
      flags: atomic && i < senderFrames.length - 1 ? ATOMIC_BATCH_FLAG : 0,
      target: f.target,
      gasLimit: f.gasLimit,
      stateGasLimit: f.stateGasLimit,
      value: f.value,
      data: f.data,
    }),
);

// What the account will compute in _senderFramesSupported(): batch, because there is more
// than one SENDER frame, and atomic for every frame that carries the flag or follows one.
const presentedMode = atomic ? FRAME_MODE_BATCH_ATOMIC : FRAME_MODE_BATCH;
const supported = await client.readContract({
  address: account,
  abi: ACCOUNT_ABI,
  functionName: "supportsExecutionMode",
  args: [presentedMode],
});
console.log(
  `presented mode ${presentedMode.slice(0, 6)}..  (${atomic ? "BATCH_ATOMIC" : "BATCH"})  ` +
    `account supports it: ${supported}`,
);
if (!supported) throw new Error("the account does not support the presented SENDER-frame mode");

// Built once without the signature, whose ARBITRARY entry sig_hash elides, then signed and
// rebuilt with it; the VERIFY frame's data only names the entry.
const build = (signature?: Hex) =>
  new FrameTx({
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
        stateGasLimit: KEYED_NONCE_STATE_GAS,
        data: encodeFunctionData({ abi: VERIFY_ABI, functionName: "verify", args: [witnessRef()] }),
      }),
      ...grouped,
    ],
    signatures: [witnessSig(signature)],
    maxPriorityFee,
    maxFee,
  });
const digest = authDigest(build());
const tx = build(await owner.sign({ hash: digest }));

console.log(`\nframes: 1 VERIFY + ${grouped.length} SENDER`);
grouped.forEach((f, i) => {
  const flag = (f.flags & ATOMIC_BATCH_FLAG) !== 0;
  console.log(
    `  frame[${i + 1}] -> ${String(f.target)}  value ${formatEther(BigInt(f.value))} ETH  ` +
      `data ${size(f.data)}B  flags 0x0${f.flags}${flag ? " (joined to next)" : ""}`,
  );
});

const raw = tx.raw();
console.log(`auth_digest ${digest}`);
console.log(`raw type-0x06 tx: ${size(raw)} bytes`);

const before = await Promise.all(recipients.map((to) => client.getBalance({ address: to })));

// `null` where the endpoint has no dry-run (see `simulate`); the transaction then goes out
// unsimulated, and the receipt is the only verdict.
const sim = await simulate(client, raw);
if (sim !== null) {
  console.log("\n--- ethrex_simulateFrameTransaction ---");
  console.log(JSON.stringify(sim, null, 2));
  if (!sim.valid) {
    console.log(`\nINVALID: ${sim.violation}`);
    if (!(force && submit)) process.exit(1);
    console.log("FORCE: submitting anyway");
  }
}

if (!submit) {
  console.log("\nsimulation only; set `submit` to send");
  process.exit(0);
}

let hash: Hex;
try {
  hash = await client.sendRawTransaction({ serializedTransaction: raw });
} catch (e) {
  console.log(`\nSUBMIT REJECTED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
console.log(`\nsubmitted: ${hash}`);

for (let i = 0; i < 30; i++) {
  const receipt: TypedReceipt | null = await client.request({
    method: "eth_getTransactionReceipt",
    params: [hash],
  });
  if (receipt !== null) {
    console.log(
      `MINED block=${Number(receipt.blockNumber)} type=${receipt.type} ` +
        `status=${receipt.status} payer=${receipt.payer}`,
    );
    // FRAMEPARAM(i, 0x05) status: 0 failed, 1 succeeded, 2 skipped because the atomic
    // batch it belongs to failed.
    console.log(JSON.stringify(receipt.frameReceipts, null, 2));

    const after = await Promise.all(recipients.map((to) => client.getBalance({ address: to })));
    console.log("\nrecipient balances:");
    recipients.forEach((to, j) => {
      const delta = after[j]! - before[j]!;
      console.log(`  ${to}  ${delta === 0n ? "unchanged" : `+${formatEther(delta)} ETH`}`);
    });
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
console.log("not mined within timeout");
process.exit(1);
