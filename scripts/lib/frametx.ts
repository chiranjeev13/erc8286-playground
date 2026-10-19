import { concat, hashTypedData, keccak256, numberToHex, pad, toRlp } from "viem";

/**
 * EIP-8141/8250 frame-transaction (type 0x06) encoder.
 *
 * Matches lambdaclass/ethrex @ 325a9be (the bogota-devnet-1 image), whose
 * `golden_frame_tx_rlp_and_sig_hash` vector this file is checked against by
 * scripts/frametx-selftest.ts.
 *
 *   raw = 0x06 || rlp([chain_id, nonce_keys, nonce_seq, sender, frames, signatures,
 *                      fees, blob_hashes])
 *   frame     = [mode, flags, target_or_empty, limits, value, data]
 *   limits    = [execution, state]
 *   fees      = [max_priority_fee, max_fee, max_blob_fee]
 *   signature = [scheme, signer_or_empty, msg, signature_bytes]
 *   sig_hash  = keccak256(0x06 || rlp(envelope with empty-msg signatures' bytes elided))
 *
 * EIP-8272 recent-root references are no longer an envelope field; they ride in a verifier
 * frame instead.
 */

export const FrameMode = { DEFAULT: 0, VERIFY: 1, SENDER: 2, POST_TX: 3 } as const;
export const SigScheme = { ARBITRARY: 0, SECP256K1: 1, P256: 2 } as const;

/** EIP-8250 system contract holding every non-zero nonce key's sequence. */
export const NONCE_MANAGER = "0x8250968C12e01A19d6F667b9B2F3b3A4d0e51cB7";

/** Its address before EIP-8250 moved it to a keyless deployment; ethrex's chains still use it. */
export const NONCE_MANAGER_LEGACY = "0x0000000000000000000000000000000000008250";

/** The nonce manager a chain actually runs: hegota (3151908) and the Hegota testnet (8141) predate the move. */
export function nonceManagerFor(chainId: number): Hex {
  return chainId === 8141 || chainId === 3151908 ? NONCE_MANAGER_LEGACY : NONCE_MANAGER;
}

/**
 * `limits.state` for the frame that APPROVEs payment under a non-zero nonce key. The first
 * use of a key creates its NONCE_MANAGER slot -- 64 state bytes at 1530 gas each -- and
 * APPROVE's nonce increment charges that to the approving frame. Without it the VERIFY frame
 * reverts inside APPROVE, before any account logic matters. Later uses rewrite the slot and
 * draw nothing.
 */
export const KEYED_NONCE_STATE_GAS = 64 * 1530;

/** EIP-8250 `slot(sender, nonce_key) = keccak256(left_pad_32(sender) || be32(nonce_key))`. */
export function nonceSlot(sender: Hex, nonceKey: Numeric): Hex {
  return keccak256(concat([pad(sender, { size: 32 }), numberToHex(BigInt(nonceKey), { size: 32 })]));
}

/** Anything accepted where the wire format wants an integer. */
export type Numeric = number | bigint | string;
/** A 0x-prefixed hex string. */
export type Hex = `0x${string}`;
/** RLP is a tree of byte strings. */
type RlpItem = Hex | RlpItem[];

/**
 * RLP integer: the minimal big-endian encoding, with zero as the empty string.
 *
 * Built from the hex digits directly rather than through viem's `numberToHex`, which
 * without a `size` emits the shortest digit string -- a nibble short of a whole byte for
 * odd-length values (`1n` -> `0x1`).
 */
const rlpInt = (x: Numeric): Hex => {
  const value = BigInt(x);
  if (value === 0n) return "0x";
  const digits = value.toString(16);
  return `0x${digits.length % 2 === 0 ? digits : `0${digits}`}`;
};
const addr20 = (a: Numeric): Hex => numberToHex(BigInt(a), { size: 20 });

export interface FrameInit {
  mode: number;
  flags?: number;
  /** `null` means an empty target, which resolves to `tx.sender`. */
  target?: Numeric | null;
  /** `limits.execution`. */
  gasLimit: Numeric;
  /** `limits.state`: the EIP-8037 state-gas budget, for frames that grow state. */
  stateGasLimit?: Numeric;
  value?: Numeric;
  data?: Hex;
}

export class Frame {
  readonly mode: number;
  readonly flags: number;
  readonly target: Numeric | null;
  readonly gasLimit: Numeric;
  readonly stateGasLimit: Numeric;
  readonly value: Numeric;
  readonly data: Hex;

  constructor({
    mode,
    flags = 0,
    target = null,
    gasLimit,
    stateGasLimit = 0,
    value = 0,
    data = "0x",
  }: FrameInit) {
    this.mode = mode;
    this.flags = flags;
    this.target = target;
    this.gasLimit = gasLimit;
    this.stateGasLimit = stateGasLimit;
    this.value = value;
    this.data = data;
  }

  toRlp(): RlpItem[] {
    return [
      rlpInt(this.mode),
      rlpInt(this.flags),
      this.target === null ? "0x" : addr20(this.target),
      [rlpInt(this.gasLimit), rlpInt(this.stateGasLimit)],
      rlpInt(this.value),
      this.data,
    ];
  }
}

export interface FrameSigInit {
  scheme: number;
  /** `null` encodes as empty, which ARBITRARY signatures require. */
  signer: Numeric | null;
  msg?: Hex;
  signature?: Hex;
}

export class FrameSig {
  readonly scheme: number;
  readonly signer: Numeric | null;
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
    const signer = this.signer === null ? "0x" : addr20(this.signer);
    return [rlpInt(this.scheme), signer, this.msg, sig];
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
  }

  #envelope(elideSigs: boolean): RlpItem[] {
    return [
      rlpInt(this.chainId),
      this.nonceKeys.map(rlpInt),
      rlpInt(this.nonceSeq),
      addr20(this.sender),
      this.frames.map((f) => f.toRlp()),
      this.signatures.map((s) => s.toRlp(elideSigs)),
      [rlpInt(this.maxPriorityFee), rlpInt(this.maxFee), rlpInt(this.maxBlobFee)],
      this.blobHashes,
    ];
  }

  encode(): Hex {
    return toRlp(this.#envelope(false));
  }

  raw(): Hex {
    return concat(["0x06", this.encode()]);
  }

  sigHash(): Hex {
    return keccak256(concat(["0x06", toRlp(this.#envelope(true))]));
  }
}

/**
 * `keccak256(be32(len) || be32(k0) || ...)` over the EIP-8250 key set, i.e. TXPARAM(0x0F).
 * Because valid `nonce_keys` are strictly increasing, this has one canonical encoding.
 */
export function nonceKeysHash(nonceKeys: Numeric[]): Hex {
  const w = (x: Numeric): Hex => numberToHex(BigInt(x), { size: 32 });
  return keccak256(concat([w(nonceKeys.length), ...nonceKeys.map(w)]));
}

export interface AuthDigestInput {
  chainId: Numeric;
  nonce: Numeric;
  /** `tx.sender`, whose nonce and frames these are. */
  sender: Numeric;
  /** The account whose owner signs: the sender itself, or an account that only pays. */
  account?: Numeric;
  nonceKeys: Numeric[];
  senderFrames: Frame[];
}

/** The EIP-712 types ECDSAFrameValidator checks. `EIP712Domain` is what eth_signTypedData_v4 wants. */
export const AUTH_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  FrameTx: [
    { name: "sender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "nonceKeysHash", type: "bytes32" },
    { name: "frames", type: "Frame[]" },
  ],
  Frame: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "flags", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
} as const;

export interface AuthTypedData {
  domain: { name: string; version: string; chainId: bigint; verifyingContract: Hex };
  types: typeof AUTH_TYPES;
  primaryType: "FrameTx";
  message: { sender: Hex; nonce: bigint; nonceKeysHash: Hex; frames: { target: Hex; value: bigint; flags: bigint; data: Hex }[] };
}

/**
 * The typed data ECDSAFrameValidator._authDigest() hashes: the sender, the nonce, the
 * EIP-8250 key set, and every SENDER frame, under a domain whose verifyingContract is the
 * signing account. That account is the sender itself, or, for a payment-only VERIFY frame,
 * an account that pays for the sender's transaction.
 *
 * flags is included because bit 2 is EIP-8141's ATOMIC_BATCH_FLAG: it decides whether the
 * frames revert together, so it has to be signed over like any other frame field.
 *
 * nonceKeysHash commits the EIP-8250 key set. When the account selects its validator from
 * nonce_keys[0], that selection is signed over here: swap the validator and the digest moves.
 *
 * A signature in VERIFY-frame data cannot sign over sig_hash -- that hash commits the frame
 * data verbatim, so it would be a circular fixed point. Hence this reconstruction, which
 * covers only what the transaction will actually do.
 */
export function authTypedData({ chainId, nonce, sender, account = sender, nonceKeys, senderFrames }: AuthDigestInput): AuthTypedData {
  return {
    domain: {
      name: "ERC-8286 Frame Validator",
      version: "1",
      chainId: BigInt(chainId),
      verifyingContract: addr20(account),
    },
    types: AUTH_TYPES,
    primaryType: "FrameTx",
    message: {
      sender: addr20(sender),
      nonce: BigInt(nonce),
      nonceKeysHash: nonceKeysHash(nonceKeys),
      frames: senderFrames.map((f) => {
        if (f.target === null) throw new Error("a SENDER frame in the digest needs a resolved target");
        return { target: addr20(f.target), value: BigInt(f.value), flags: BigInt(f.flags), data: f.data };
      }),
    },
  };
}

/** Mirror of ECDSAFrameValidator._authDigest(): the EIP-712 hash of `authTypedData`. */
export function authDigest(input: AuthDigestInput): Hex {
  return hashTypedData(authTypedData(input));
}
