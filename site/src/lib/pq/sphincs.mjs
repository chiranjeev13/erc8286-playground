// SPHINCS signer for contracts/src/SphincsVerifier.sol (sphincs-g: n=16 h=20 d=5 h'=4 a=9 k=19 w=16).
// Port of RivaLabs-Core/Post-Quantum-AA-Infra scripts/sphincs_v2_reference.py, checked against its
// test vector in contracts/test/vectors. Keccak256 tweakable hashes over 32-byte slots, 16-byte nodes
// in the top half of each slot, deterministic R. Uses hashing only.

import { keccak_256 } from "@noble/hashes/sha3.js";

const N = 16;
const H = 20;
const D = 5;
const HP = H / D; // 4
const K = 19;
const A = 9;
const LOG_W = 4;
const W = 1 << LOG_W;
const LEN1 = 128 / LOG_W; // 32
const LEN2 = 3;
const L = LEN1 + LEN2; // 35
export const SIG_LEN = N * (1 + K + K * A) + D * (N * L + N * HP); // 6176

const WOTS_HASH = 0, WOTS_PK = 1, TREE = 2, FORS_TREE = 3, FORS_ROOTS = 4, WOTS_PRF = 5, FORS_PRF = 6;

const te = new TextEncoder();

function adrs(layer, tree, typ, w1 = 0, w2 = 0, w3 = 0) {
  // (layer << 224) | (tree << 128) | (typ << 96) | (w1 << 64) | (w2 << 32) | w3, big-endian 32 bytes.
  const out = new Uint8Array(32);
  const v = new DataView(out.buffer);
  v.setUint32(0, layer);
  v.setUint32(8, Math.floor(tree / 2 ** 32)); // tree < 2^20 here, so the top 4 of its 12 bytes stay 0
  v.setUint32(12, tree >>> 0);
  v.setUint32(16, typ);
  v.setUint32(20, w1);
  v.setUint32(24, w2);
  v.setUint32(28, w3);
  return out;
}

/** Holds the three 16-byte secrets/seeds and caches subtrees while signing one message. */
class Ctx {
  constructor(skSeed, skPrf, pkSeed) {
    this.skSeed = skSeed;
    this.skPrf = skPrf;
    this.pkSeed = pkSeed;
  }

  thash(a, nodes) {
    const buf = new Uint8Array(64 + 32 * nodes.length);
    buf.set(this.pkSeed, 0);
    buf.set(a, 32);
    for (let i = 0; i < nodes.length; i++) buf.set(nodes[i], 64 + 32 * i);
    return keccak_256(buf).subarray(0, N);
  }

  prf(a) {
    const buf = new Uint8Array(64);
    buf.set(this.skSeed, 0);
    buf.set(a, 32);
    return keccak_256(buf).subarray(0, N);
  }

  chain(x, start, steps, layer, tree, kp, ci) {
    for (let j = start; j < start + steps; j++) x = this.thash(adrs(layer, tree, WOTS_HASH, kp, ci, j), [x]);
    return x;
  }

  wotsSk(layer, tree, kp, ci) {
    return this.prf(adrs(layer, tree, WOTS_PRF, kp, ci, 0));
  }

  wotsPk(layer, tree, kp) {
    const pks = [];
    for (let i = 0; i < L; i++) pks.push(this.chain(this.wotsSk(layer, tree, kp, i), 0, W - 1, layer, tree, kp, i));
    return this.thash(adrs(layer, tree, WOTS_PK, kp), pks);
  }

  wotsSign(msgNode, layer, tree, kp) {
    const digits = wotsDigits(msgNode);
    const out = [];
    for (let i = 0; i < L; i++) out.push(this.chain(this.wotsSk(layer, tree, kp, i), 0, digits[i], layer, tree, kp, i));
    return out;
  }

  subtree(layer, tree) {
    const levels = [[]];
    for (let kp = 0; kp < 1 << HP; kp++) levels[0].push(this.wotsPk(layer, tree, kp));
    for (let z = 1; z <= HP; z++) {
      const prev = levels[z - 1];
      const next = [];
      for (let p = 0; p < prev.length / 2; p++) next.push(this.thash(adrs(layer, tree, TREE, 0, z, p), [prev[2 * p], prev[2 * p + 1]]));
      levels.push(next);
    }
    return levels;
  }

  forsTree(i, tree, kp) {
    const sks = [];
    const leaves = [];
    for (let j = 0; j < 1 << A; j++) {
      const sk = this.prf(adrs(0, tree, FORS_PRF, kp, 0, (i << A) | j));
      sks.push(sk);
      leaves.push(this.thash(adrs(0, tree, FORS_TREE, kp, 0, (i << A) | j), [sk]));
    }
    const levels = [leaves];
    for (let z = 1; z <= A; z++) {
      const prev = levels[z - 1];
      const next = [];
      for (let p = 0; p < prev.length / 2; p++) {
        next.push(this.thash(adrs(0, tree, FORS_TREE, kp, z, (i << (A - z)) | p), [prev[2 * p], prev[2 * p + 1]]));
      }
      levels.push(next);
    }
    return { sks, levels };
  }
}

function wotsDigits(msgNode) {
  const digits = [];
  for (const byte of msgNode) digits.push(byte >> 4, byte & 15);
  let csum = 0;
  for (const d of digits) csum += W - 1 - d;
  for (let j = 0; j < LEN2; j++) digits.push((csum >> (LOG_W * (LEN2 - 1 - j))) & (W - 1));
  return digits;
}

function authPath(levels, idx) {
  const path = [];
  for (let z = 0; z < levels.length - 1; z++) {
    path.push(levels[z][idx ^ 1]);
    idx >>= 1;
  }
  return path;
}

// --------------------------------------------------------------------------- byte helpers

export function hexToBytes(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error("invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** 16-byte node -> 32-byte word with the value in the top half, as the verifier expects. */
function slot(node) {
  const out = new Uint8Array(32);
  out.set(node.subarray(0, N), 0);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// --------------------------------------------------------------------------- public API

/**
 * Builds a key from explicit 16-byte values (each passed as 16 or 32 bytes, top-aligned). Used for the
 * reference vector; apps should use keyFromSecret.
 */
export function keyFromSeeds(skSeed, skPrf, pkSeed) {
  const ctx = new Ctx(slot(skSeed), slot(skPrf), slot(pkSeed));
  const pkRoot = ctx.subtree(D - 1, 0)[HP][0];
  return { ctx, pkSeed: bytesToHex(slot(pkSeed)), pkRoot: bytesToHex(slot(pkRoot)) };
}

/** Derives all three 16-byte values from one 32-byte secret with domain-separated keccak. */
export function keyFromSecret(secret) {
  const derive = (tag) => keccak_256(concat(secret, te.encode(`pq-nexus/sphincs-g/${tag}`))).subarray(0, N);
  return keyFromSeeds(derive("sk-seed"), derive("sk-prf"), derive("pk-seed"));
}

export function randomSecret() {
  const s = new Uint8Array(32);
  crypto.getRandomValues(s);
  return s;
}

/** Signs a 32-byte message (e.g. a userOpHash). Returns the 6,176-byte signature as 0x-hex. */
export function sign(key, messageHex) {
  const { ctx } = key;
  const message = hexToBytes(messageHex);
  if (message.length !== 32) throw new Error("message must be 32 bytes");
  const pkRoot = hexToBytes(key.pkRoot).subarray(0, N);

  const R = keccak_256(concat(ctx.skPrf, message)).subarray(0, N);
  const dom = new Uint8Array(32).fill(0xff);
  const digest = BigInt(bytesToHex(keccak_256(concat(dom, R, ctx.pkSeed.subarray(0, N), pkRoot, message))));
  const htIdx = Number((digest >> BigInt(K * A)) & BigInt((1 << H) - 1));

  let idxLeaf = htIdx & ((1 << HP) - 1);
  let idxTree = htIdx >> HP;
  const fors = [];
  const roots = [];
  for (let i = 0; i < K; i++) {
    const t = Number((digest >> BigInt(i * A)) & BigInt((1 << A) - 1));
    const { sks, levels } = ctx.forsTree(i, idxTree, idxLeaf);
    fors.push(sks[t], ...authPath(levels, t));
    roots.push(levels[A][0]);
  }
  let node = ctx.thash(adrs(0, idxTree, FORS_ROOTS, idxLeaf), roots);

  const ht = [];
  let idx = htIdx;
  for (let layer = 0; layer < D; layer++) {
    idxLeaf = idx & ((1 << HP) - 1);
    idx >>= HP;
    const levels = ctx.subtree(layer, idx);
    ht.push(...ctx.wotsSign(node, layer, idx, idxLeaf), ...authPath(levels, idxLeaf));
    node = levels[HP][0];
  }
  if (bytesToHex(slot(node)) !== key.pkRoot) throw new Error("hypertree did not reach pkRoot");

  const sig = concat(R, ...fors, ...ht);
  if (sig.length !== SIG_LEN) throw new Error("bad signature length");
  return bytesToHex(sig);
}
