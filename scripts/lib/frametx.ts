import { concat, encodeRlp, getBytes, keccak256, toBeHex, zeroPadValue } from "ethers";

/**
 * EIP-8141/8250/8272/7906 frame-transaction (type 0x06) encoder.
 *
 * Port of lambdaclass/ethrex @ hegota-devnet, scripts/hegota-devnet/frametx.py, whose
 * golden vector this file is checked against by scripts/frametx-selftest.ts.
 *
 *   raw = 0x06 || rlp([chain_id, nonce_keys, nonce_seq, sender, frames, signatures,
 *                      max_priority_fee, max_fee, max_blob_fee, blob_hashes,
 *                      recent_root_references])
 *   frame     = [mode, flags, target_or_empty, gas_limit, value, data]
 *   signature = [scheme, signer, msg, signature_bytes]
 *   sig_hash  = keccak256(0x06 || rlp(envelope with empty-msg signatures' bytes elided))
 */

export const FrameMode = { DEFAULT: 0, VERIFY: 1, SENDER: 2, POST_TX: 3 } as const;
export const SigScheme = { ARBITRARY: 0, SECP256K1: 1, P256: 2 } as const;

/** Anything accepted where the wire format wants an integer. */
export type Numeric = number | bigint | string;
/** A 0x-prefixed hex string. */
export type Hex = string;
/** RLP is a tree of byte strings. */
type RlpItem = Hex | RlpItem[];

/** RLP integer: the minimal big-endian encoding, with zero as the empty string. */
const rlpInt = (x: Numeric): Hex => (BigInt(x) === 0n ? "0x" : toBeHex(BigInt(x)));
const addr20 = (a: Numeric): Hex => zeroPadValue(toBeHex(BigInt(a)), 20);

export interface FrameInit {
  mode: number;
  flags?: number;
  /** `null` means an empty target, which resolves to `tx.sender`. */
  target?: Numeric | null;
  gasLimit: Numeric;
  value?: Numeric;
  data?: Hex;
}

export class Frame {
  readonly mode: number;
  readonly flags: number;
  readonly target: Numeric | null;
  readonly gasLimit: Numeric;
  readonly value: Numeric;
  readonly data: Hex;

  constructor({ mode, flags = 0, target = null, gasLimit, value = 0, data = "0x" }: FrameInit) {
    this.mode = mode;
    this.flags = flags;
    this.target = target;
    this.gasLimit = gasLimit;
    this.value = value;
    this.data = data;
  }

  toRlp(): RlpItem[] {
    return [
      rlpInt(this.mode),
      rlpInt(this.flags),
      this.target === null ? "0x" : addr20(this.target),
      rlpInt(this.gasLimit),
      rlpInt(this.value),
      this.data,
    ];
  }
}

export interface FrameSigInit {
  scheme: number;
  signer: Numeric;
  msg?: Hex;
  signature?: Hex;
}

export class FrameSig {
  readonly scheme: number;
  readonly signer: Numeric;
  readonly msg: Hex;
  readonly signature: Hex;

  constructor({ scheme, signer, msg = "0x", signature = "0x" }: FrameSigInit) {
    this.scheme = scheme;
    this.signer = signer;
    this.msg = msg;
    this.signature = signature;
  }

  toRlp(elide = false): RlpItem[] {
    // An empty msg means "signed over sig_hash", so its bytes are elided from the preimage.
    const sig = elide && this.msg === "0x" ? "0x" : this.signature;
    return [rlpInt(this.scheme), addr20(this.signer), this.msg, sig];
  }
}

export interface FrameTxInit {
  chainId: Numeric;
  nonceKeys?: Numeric[];
  nonceSeq: Numeric;
  sender: Numeric;
  frames: Frame[];
  signatures?: FrameSig[];
  maxPriorityFee: Numeric;
  maxFee: Numeric;
  maxBlobFee?: Numeric;
  blobHashes?: Hex[];
  recentRootRefs?: RlpItem[];
}

export class FrameTx {
  readonly chainId: Numeric;
  readonly nonceKeys: Numeric[];
  readonly nonceSeq: Numeric;
  readonly sender: Numeric;
  readonly frames: Frame[];
  readonly signatures: FrameSig[];
  readonly maxPriorityFee: Numeric;
  readonly maxFee: Numeric;
  readonly maxBlobFee: Numeric;
  readonly blobHashes: Hex[];
  readonly recentRootRefs: RlpItem[];

  constructor(init: FrameTxInit) {
    this.chainId = init.chainId;
    this.nonceKeys = init.nonceKeys ?? [0];
    this.nonceSeq = init.nonceSeq;
    this.sender = init.sender;
    this.frames = init.frames;
    this.signatures = init.signatures ?? [];
    this.maxPriorityFee = init.maxPriorityFee;
    this.maxFee = init.maxFee;
    this.maxBlobFee = init.maxBlobFee ?? 0;
    this.blobHashes = init.blobHashes ?? [];
    this.recentRootRefs = init.recentRootRefs ?? [];
  }

  #envelope(elideSigs: boolean): RlpItem[] {
    return [
      rlpInt(this.chainId),
      this.nonceKeys.map(rlpInt),
      rlpInt(this.nonceSeq),
      addr20(this.sender),
      this.frames.map((f) => f.toRlp()),
      this.signatures.map((s) => s.toRlp(elideSigs)),
      rlpInt(this.maxPriorityFee),
      rlpInt(this.maxFee),
      rlpInt(this.maxBlobFee),
      this.blobHashes,
      this.recentRootRefs,
    ];
  }

  encode(): Hex {
    return encodeRlp(this.#envelope(false));
  }

  raw(): Hex {
    return concat(["0x06", this.encode()]);
  }

  sigHash(): Hex {
    return keccak256(concat(["0x06", encodeRlp(this.#envelope(true))]));
  }
}

export interface AuthDigestInput {
  chainId: Numeric;
  nonce: Numeric;
  sender: Numeric;
  senderFrames: Frame[];
}

/**
 * Mirror of ECDSAFrameValidator._authDigest().
 *
 * abi.encodePacked(uint256 chainid, uint256 nonce, uint256 sender), then per SENDER frame
 * uint256 target, uint256 value, uint256 len(data), and the raw data. Every scalar is a
 * uint256, so 32 bytes big-endian with no packing.
 *
 * A signature in VERIFY-frame data cannot sign over sig_hash -- that hash commits the frame
 * data verbatim, so it would be a circular fixed point. Hence this reconstruction, which
 * covers only what the transaction will actually do.
 */
export function authDigest({ chainId, nonce, sender, senderFrames }: AuthDigestInput): Hex {
  const w = (x: Numeric): Hex => zeroPadValue(toBeHex(BigInt(x)), 32);
  const parts: Hex[] = [w(chainId), w(nonce), w(sender)];
  for (const f of senderFrames) {
    if (f.target === null) throw new Error("a SENDER frame in the digest needs a resolved target");
    parts.push(w(f.target), w(f.value), w(getBytes(f.data).length), f.data);
  }
  return keccak256(concat(parts));
}
