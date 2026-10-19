// EIP-8141 example 1b: a frame transaction that deploys its own sender.
//
//   npm run send:deploy:testnet                       # simulate, wallet key, pays for itself
//   VARIANT=pq-pay SUBMIT=1 npm run send:deploy:testnet
//
// An account has to have code before it can validate, so the creation goes in a DEFAULT frame
// ahead of the VERIFY frame. The account is an EIP-1167 clone whose configuration sits in its
// code (LibCloneConfig), created by ERC8286AccountFactory, so the deploy frame writes no
// storage and the prefix fits the 500k gas and 500k state gas caps:
//
//   frame[0] DEFAULT -> factory.createAccount(impl, args, salt)   the clone appears
//   frame[1] VERIFY  -> account.verify(sig)                        approves 0x3, or 0x2 with a payer
//   frame[2] VERIFY  -> paymaster.pay()                            VARIANT=*-pay only
//   frame[3] SENDER  -> 0x..dEaD, 0.0001 ETH
//
// VARIANT = wallet-self (default) | wallet-pay | pq-self | pq-pay. The *-self variants prefund
// the counterfactual address with 0.01 ETH, since the account pays for its own creation. The
// wallet is the deployer key; a pq variant generates a fresh SPHINCS key. DEPLOY_GAS,
// DEPLOY_STATE, VERIFY_GAS and PAY_GAS override the declared limits.
import { encodeAbiParameters, encodeFunctionData, encodePacked, getAddress, keccak256, numberToHex, parseEther, toHex } from "viem";
import { Frame, FrameMode, FrameTx, KEYED_NONCE_STATE_GAS, authDigest, nonceManagerFor, nonceSlot } from "./lib/frametx.js";
import { connect, need, simulate, type TypedReceipt } from "./lib/connect.js";
import { keyFromSecret, randomSecret, sign } from "../site/src/lib/pq/sphincs.mjs";

const VERIFY_ABI = [{ type: "function", name: "verify", inputs: [{ type: "bytes" }], outputs: [] }] as const;
const PAY_ABI = [{ type: "function", name: "pay", inputs: [], outputs: [] }] as const;
const FACTORY_ABI = [
  { type: "function", name: "createAccount", inputs: [{ type: "address" }, { type: "bytes" }, { type: "bytes32" }], outputs: [{ type: "address" }], stateMutability: "nonpayable" },
  { type: "function", name: "predict", inputs: [{ type: "address" }, { type: "bytes" }, { type: "bytes32" }], outputs: [{ type: "address" }], stateMutability: "view" },
] as const;

const variant = process.env.VARIANT ?? "wallet-self";
const pq = variant.startsWith("pq");
const payer = variant.endsWith("-pay");
const n = (k: string, d: number) => Number(process.env[k] ?? d);

const { env, client, account: owner, chainId } = await connect();
const factory = getAddress(need(env, "ERC8286ACCOUNTFACTORY_ADDRESS", ""));
const impl = getAddress(need(env, "ERC8286FRAMEACCOUNT_ADDRESS", ""));
const paymaster = getAddress(need(env, "PAYMASTER_ADDRESS", "deploy one from the playground, or any Paymaster"));
const validator = getAddress(need(env, pq ? "SPHINCSFRAMEVALIDATOR_ADDRESS" : "ECDSAFRAMEVALIDATOR_ADDRESS", ""));

const key = pq ? keyFromSecret(randomSecret()) : null;
const initData = pq ? (`0x${key!.pkSeed.slice(2, 34)}${key!.pkRoot.slice(2, 34)}` as `0x${string}`) : owner.address;
const scopes = payer ? 2 : 3;
const args = encodePacked(["address", "uint8", "uint8", "uint8", "bytes"], [validator, scopes, 0x0f, 0, initData]); // all shapes, protocol route
const salt = keccak256(numberToHex(Date.now(), { size: 32 }));
const sender = getAddress(await client.readContract({ address: factory, abi: FACTORY_ABI, functionName: "predict", args: [impl, args, salt] }));
console.log(`${variant}: counterfactual ${sender}, config ${(args.length - 2) / 2} bytes`);

if (!payer) {
  const h = await client.sendTransaction({ to: sender, value: parseEther("0.01") });
  await client.waitForTransactionReceipt({ hash: h });
  console.log("prefunded 0.01 ETH");
}

const nonceKeys = [BigInt(validator)];
const nonce = Number(BigInt((await client.getStorageAt({ address: nonceManagerFor(chainId), slot: nonceSlot(sender, nonceKeys[0]!) })) ?? "0x0"));
const block = await client.getBlock();
const maxFee = (block.baseFeePerGas ?? 0n) * 2n + 1_000_000_000n;
const senderFrames = [new Frame({ mode: FrameMode.SENDER, target: "0x000000000000000000000000000000000000dEaD", gasLimit: 30_000, stateGasLimit: 200_000, value: parseEther("0.0001") })];

const digest = authDigest({ chainId, nonce, sender, account: sender, nonceKeys, senderFrames });
const sig = pq ? sign(key!, digest) : await owner.sign({ hash: digest });

const deployGas = n("DEPLOY_GAS", 30_000);
const deployState = n("DEPLOY_STATE", pq ? 340_000 : 320_000);
const verifyGas = n("VERIFY_GAS", pq ? 455_000 : 100_000);
const payGas = n("PAY_GAS", 15_000);
const tx = new FrameTx({
  chainId, nonceKeys, nonceSeq: nonce, sender, signatures: [], maxPriorityFee: 1_000_000_000n, maxFee,
  frames: [
    new Frame({ mode: FrameMode.DEFAULT, flags: 0, target: factory, gasLimit: deployGas, stateGasLimit: deployState, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "createAccount", args: [impl, args, salt] }) }),
    new Frame({ mode: FrameMode.VERIFY, flags: scopes, target: sender, gasLimit: verifyGas, stateGasLimit: payer ? 0 : KEYED_NONCE_STATE_GAS, data: encodeFunctionData({ abi: VERIFY_ABI, functionName: "verify", args: [sig] }) }),
    ...(payer ? [new Frame({ mode: FrameMode.VERIFY, flags: 1, target: paymaster, gasLimit: payGas, stateGasLimit: KEYED_NONCE_STATE_GAS, data: encodeFunctionData({ abi: PAY_ABI, functionName: "pay" }) })] : []),
    ...senderFrames,
  ],
});
console.log(`prefix limits: gas ${deployGas + verifyGas + (payer ? payGas : 0)}  state ${deployState + KEYED_NONCE_STATE_GAS}`);
const raw = tx.raw();
const sim = await simulate(client, raw);
console.log("simulation:", JSON.stringify({ valid: sim?.valid, violation: sim?.violation, prefixShape: sim?.prefixShape, payer: sim?.payer, frames: sim?.frames?.map((f) => `${f.succeeded ? "ok" : "fail"}/${Number(f.gasUsed)}`) }));
if (!sim?.valid || process.env.SUBMIT !== "1") process.exit(sim?.valid ? 0 : 1);

const hash = await client.sendRawTransaction({ serializedTransaction: raw });
console.log("submitted", hash);
for (let i = 0; i < 30; i++) {
  const r: TypedReceipt | null = await client.request({ method: "eth_getTransactionReceipt", params: [hash] });
  if (r) {
    const fr = (r.frameReceipts ?? []) as { status: string; gasUsed: string; stateGasUsed?: string }[];
    console.log(`MINED block=${Number(r.blockNumber)} status=${r.status} payer=${r.payer}`);
    fr.forEach((f, i) => console.log(`  frame ${i}: status ${f.status} gas ${Number(f.gasUsed)} stateGas ${Number(f.stateGasUsed ?? 0)}`));
    console.log("code now:", ((await client.getCode({ address: sender })) ?? "0x").length > 2 ? "deployed" : "none");
    process.exit(0);
  }
  await new Promise((res) => setTimeout(res, 2000));
}
process.exit(1);
