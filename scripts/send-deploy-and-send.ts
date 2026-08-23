// EIP-8141 example 1b: a frame transaction that deploys its own sender.
//
//   npm run send:deploy               # simulate
//   SUBMIT=1 npm run send:deploy      # ...and send it
//
// An account has to have code before it can validate, so the deployment goes in a DEFAULT
// frame ahead of the VERIFY frame:
//
//   frame[0] DEFAULT, target = EIP-7997 predeploy, data = salt || proxy init code
//            -> CREATE2s the account. Called by ENTRY_POINT, approval scope none.
//   frame[1] VERIFY,  target = empty (resolves to tx.sender), flags 0x03
//            -> the account that frame[0] just deployed validates and APPROVEs.
//   frame[2] SENDER,  target = recipient, value = amount
//
//
// The account pays for all of it, including its own deployment, so it must hold ETH before
// the transaction runs -- possible because the address is known in advance. This script funds
// it with an ordinary transfer first (a real deployment would have been funded long before).
//
// No factory is involved: frame[0] targets the EIP-7997 predeploy directly, and the address
// and those calldata bytes are derived locally in scripts/lib/accounts.ts.
//
// What it sends is set by the constants below, and nothing here second-guesses the node: the
// transaction is built and handed to `ethrex_simulateFrameTransaction` whatever the numbers
// look like. Worth knowing while choosing the frame gas limits, though: EIP-8141 budgets the
// whole validation prefix -- every frame before the first SENDER frame, so frames 0 and 1 both
// -- and this devnet enforces that as one 500_000 limit named MAX_VERIFY_GAS. See the README
// for what the deployment actually costs against it.
import {
  encodeFunctionData,
  formatEther,
  getAddress,
  keccak256,
  numberToHex,
  parseEther,
  size,
  concat,
  type Hex,
} from "viem";
import { Frame, FrameMode, FrameTx, authDigest } from "./lib/frametx.js";
import { connect, need, type FrameSimulation, type TypedReceipt } from "./lib/connect.js";
import { DETERMINISTIC_FACTORY, deriveAccount } from "./lib/accounts.js";
import { APPROVAL_SCOPES, EXECUTION_MODES } from "./lib/policy.js";

const APPROVE_SCOPE_EXECUTION_AND_PAYMENT = 0x03;
const NONCE_MANAGER = "0x0000000000000000000000000000000000008250";


const ACCOUNT_ABI = [
  { type: "function", name: "verify", inputs: [{ type: "bytes" }], outputs: [] },
] as const;

/** Recipient of the SENDER frame's transfer. */
const to = getAddress("0x000000000000000000000000000000000000dEaD");
/** Wei to transfer. */
const amount = 100_000_000_000_000n;
/** Account index for the salt -- pick one that does not exist yet. */
const index = 3n;
/** What to pre-fund the account with; it pays for its own deployment. */
const prefund = parseEther("0.02");
/** frame[0], the deployment. Together with verifyGas this must fit MAX_VERIFY_GAS. */
const deployGas = 2_000_000n;
/** frame[1], the validation. */
const verifyGas = 400_000n;
/** Submit it, rather than simulating only. */
const submit: boolean = true;
/** Submit even if the prefix simulation says invalid. */
const force: boolean = false;

const { env, client, account: owner, chainId } = await connect();
const validator = getAddress(need(env, "ECDSAFRAMEVALIDATOR_ADDRESS", "run `npm run deploy`"));
const implementation = getAddress(
  need(env, "ERC8286FRAMEACCOUNT_IMPLEMENTATION", "run `npm run create:account` first"),
);
const ownerAddress = owner.address;
const scopes = APPROVAL_SCOPES;
const modes = EXECUTION_MODES;

// Address and deployment bytes, derived locally: the predeploy's CREATE2 takes nothing from
// the caller, so the account's address follows from its creation code and salt alone.
const { address: account, deployCalldata } = deriveAccount({
  implementation,
  index,
  validator,
  owner: ownerAddress,
  scopes,
  modes,
});

const existing = await client.getCode({ address: account });
console.log(`account   ${account}  (index ${index})`);
console.log(`code      ${existing === undefined ? "none yet -- frame[0] will deploy it" : `already ${(existing.length - 2) / 2} bytes`}`);

// The account pays for its own deployment, so it needs a balance while it is still codeless.
let balance = await client.getBalance({ address: account });
if (balance < prefund) {
  const hash = await client.sendTransaction({ account: owner, to: account, value: prefund - balance });
  await client.waitForTransactionReceipt({ hash });
  balance = await client.getBalance({ address: account });
  console.log(`pre-funded to ${formatEther(balance)} ETH (an address with no code takes ETH fine)`);
}

const nonceKeys = [BigInt(validator)];
const slot = keccak256(
  concat([numberToHex(BigInt(account), { size: 32 }), numberToHex(nonceKeys[0]!, { size: 32 })]),
);
const nonce = Number(BigInt((await client.getStorageAt({ address: NONCE_MANAGER, slot })) ?? "0x0"));
const block = await client.getBlock();
const maxPriorityFee = 1_000_000_000n;
const maxFee = (block.baseFeePerGas ?? 0n) * 2n + maxPriorityFee;
console.log(`balance   ${formatEther(balance)} ETH  keyed nonce ${nonce}  owner ${ownerAddress}`);

const senderFrame = new Frame({ mode: FrameMode.SENDER, target: to, gasLimit: 30_000, value: amount });

// Signed before the account exists: the digest covers chain id, nonce, sender and the SENDER
// frames, all of which are known in advance -- the sender address most of all, since it is
// derived from the very init code frame[0] carries.
const digest = authDigest({ chainId, nonce, sender: account, nonceKeys, senderFrames: [senderFrame] });
const signature = await owner.sign({ hash: digest });

const tx = new FrameTx({
  chainId,
  nonceKeys,
  nonceSeq: nonce,
  sender: account,
  frames: [
    // DEFAULT frame: no approval scope, and it must not need one -- it only calls the
    // predeploy, which deploys code the account's address already commits to.
    new Frame({
      mode: FrameMode.DEFAULT,
      flags: 0,
      target: DETERMINISTIC_FACTORY,
      gasLimit: deployGas,
      data: deployCalldata,
    }),
    // Empty target, which EIP-8141 resolves to tx.sender -- as example 1b writes it.
    new Frame({
      mode: FrameMode.VERIFY,
      flags: APPROVE_SCOPE_EXECUTION_AND_PAYMENT,
      target: null,
      gasLimit: verifyGas,
      data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "verify", args: [signature] }),
    }),
    senderFrame,
  ],
  signatures: [],
  maxPriorityFee,
  maxFee,
});

const raw = tx.raw();
console.log(`\nframe[0] DEFAULT -> ${DETERMINISTIC_FACTORY}  ${size(deployCalldata)}B (salt || proxy init code)`);
console.log(`frame[1] VERIFY  -> (empty target = tx.sender)  flags 0x03`);
console.log(`frame[2] SENDER  -> ${to}  value ${formatEther(amount)} ETH`);
console.log(`auth_digest ${digest}`);
console.log(`raw type-0x06 tx: ${size(raw)} bytes`);
console.log(`prefix gas: ${deployGas} + ${verifyGas} = ${deployGas + verifyGas}`);

const sim: FrameSimulation = await client.request({
  method: "ethrex_simulateFrameTransaction",
  params: [raw, "latest"],
});
console.log("\n--- ethrex_simulateFrameTransaction ---");
console.log(JSON.stringify(sim, null, 2));

if (!sim.valid) {
  console.log(`\nINVALID: ${sim.violation}`);
  if (!(force && submit)) process.exit(1);
  console.log("FORCE: submitting anyway");
}
if (!submit) {
  console.log("\nsimulation only; set `submit` to send");
  process.exit(0);
}

const before = await client.getBalance({ address: to });
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
      `MINED block=${Number(receipt.blockNumber)} type=${receipt.type} status=${receipt.status} payer=${receipt.payer}`,
    );
    console.log(JSON.stringify(receipt.frameReceipts, null, 2));
    const code = await client.getCode({ address: account });
    const after = await client.getBalance({ address: to });
    console.log(`\naccount code   ${code === undefined ? "STILL NONE" : `${(code.length - 2) / 2} bytes -- deployed by frame[0]`}`);
    console.log(`recipient      ${after - before === 0n ? "unchanged" : `+${formatEther(after - before)} ETH`}`);
    console.log(`account balance ${formatEther(await client.getBalance({ address: account }))} ETH`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("not mined within timeout");
process.exit(1);
