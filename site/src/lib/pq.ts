// Post-quantum keys for the playground. A SPHINCS (hash-based) key is generated in the
// browser and kept in localStorage; there is no wallet that can hold one yet. The account's
// validator checks a SPHINCS signature over the transaction's sig_hash, so
// an account owned this way has no elliptic-curve key anywhere on its approval path.
//
// Demo storage: the secret sits unprotected in this browser. Test funds only.

import { bytesToHex, hexToBytes, keyFromSecret, randomSecret, sign, type SphincsKey } from "./pq/sphincs.mjs";

export interface PqKey {
  /** 32-byte secret, hex. Everything else derives from it. */
  secret: string;
  pkSeed: string;
  pkRoot: string;
  /** ISO timestamp. */
  created: string;
}

const STORE = "erc8286-pq-keys";
const listeners = new Set<() => void>();
let cache: PqKey[] | null = null;

function read(): PqKey[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORE);
    cache = raw ? (JSON.parse(raw) as PqKey[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(keys: PqKey[]): void {
  cache = keys;
  try {
    localStorage.setItem(STORE, JSON.stringify(keys));
  } catch {
    // Private window or blocked storage: the key lives for this page load only.
  }
  listeners.forEach((l) => l());
}

export const pqKeys = (): PqKey[] => read();
export const onPqKeysChanged = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Generates a key. Deriving the public key builds the top subtree: well under 100 ms. */
export function createPqKey(): PqKey {
  const secret = randomSecret();
  const k = keyFromSecret(secret);
  const key: PqKey = { secret: bytesToHex(secret), pkSeed: k.pkSeed, pkRoot: k.pkRoot, created: new Date().toISOString() };
  write([key, ...read()]);
  return key;
}

export function forgetPqKey(pkRoot: string): void {
  write(read().filter((k) => k.pkRoot !== pkRoot));
}

export const findPqKey = (pkRoot: string | null | undefined): PqKey | null =>
  pkRoot ? (read().find((k) => k.pkRoot.toLowerCase() === pkRoot.toLowerCase()) ?? null) : null;

const loaded = new Map<string, SphincsKey>();

/** Signs a 32-byte digest. About 300 ms of hashing; yields once so the UI can paint first. */
export async function pqSign(key: PqKey, digest: string): Promise<`0x${string}`> {
  await new Promise((r) => setTimeout(r, 30));
  let k = loaded.get(key.pkRoot);
  if (!k) {
    k = keyFromSecret(hexToBytes(key.secret));
    if (k.pkRoot !== key.pkRoot) throw new Error("stored key does not match its public key");
    loaded.set(key.pkRoot, k);
  }
  return sign(k, digest);
}

/** The signature size, for the tooltip. */
export const PQ_SIG_BYTES = 6176;
