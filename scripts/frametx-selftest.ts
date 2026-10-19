// Checks the TS encoder against ethrex's golden vector
// (crates/common/types/transaction.rs, golden_frame_tx_rlp_and_sig_hash @ 325a9be).
import { Frame, FrameMode, FrameSig, FrameTx, SigScheme } from "./lib/frametx.js";

const EXPECT_RLP =
  "0xf8b501c1800794000000000000000000000000000000000000abcdefcf010380c7825208831e848080821122de0280940000000000000000000000000000000000001234c4829c40808080f85cf85a0194000000000000000000000000000000000000abcd80b8410101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101cc843b9aca008506fc23ac0080c0";
const EXPECT_SIGHASH = "0xab79d82e38567c944b076afa917f6df24ba84ea4d67aebf786382955ab27e05d";

const tx = new FrameTx({
  chainId: 1,
  nonceKeys: [0],
  nonceSeq: 7,
  sender: 0xabcdn,
  frames: [
    new Frame({ mode: FrameMode.VERIFY, flags: 3, target: null, gasLimit: 0x5208, stateGasLimit: 0x1e8480, data: "0x1122" }),
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
