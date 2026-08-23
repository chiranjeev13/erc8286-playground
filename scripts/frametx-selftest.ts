// Checks the TS encoder against the same golden vector the Python original uses.
import { Frame, FrameMode, FrameSig, FrameTx, SigScheme } from "./lib/frametx.js";

const EXPECT_RLP =
  "0xf8ae01c1800794000000000000000000000000000000000000abcde8ca01038082520880821122dc0280940000000000000000000000000000000000001234829c408080f85cf85a0194000000000000000000000000000000000000abcd80b8410101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101843b9aca008506fc23ac0080c0c0";
const EXPECT_SIGHASH = "0x989e6ce4dc87b2afd5cfa6c780ff60f01fc3b40c77057cf872410145d69f715c";

const tx = new FrameTx({
  chainId: 1,
  nonceKeys: [0],
  nonceSeq: 7,
  sender: 0xabcdn,
  frames: [
    new Frame({ mode: FrameMode.VERIFY, flags: 3, target: null, gasLimit: 0x5208, data: "0x1122" }),
    new Frame({ mode: FrameMode.SENDER, target: 0x1234n, gasLimit: 0x9c40 }),
  ],
  signatures: [
    new FrameSig({ scheme: SigScheme.SECP256K1, signer: 0xabcdn, signature: `0x${"01".repeat(65)}` }),
  ],
  maxPriorityFee: 0x3b9aca00,
  maxFee: 0x6fc23ac00,
});

const rlpOk = tx.encode() === EXPECT_RLP;
const shOk = tx.sigHash() === EXPECT_SIGHASH;
console.log("RLP match:     ", rlpOk);
if (!rlpOk) console.log("  expected:", EXPECT_RLP, "\n  got:     ", tx.encode());
console.log("sig_hash match:", shOk);
if (!shOk) console.log("  expected:", EXPECT_SIGHASH, "\n  got:     ", tx.sigHash());
process.exit(rlpOk && shOk ? 0 : 1);
