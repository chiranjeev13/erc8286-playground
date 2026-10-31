// The accounts this browser created. The server keeps no record, so each account is
// remembered here as its address plus the clone spec that produces it; the spec goes back to
// the server with every request about an undeployed account, which re-derives the address
// from it before trusting it.

import type { CloneSpec } from "./api";

export interface StoredAccount {
  address: string;
  /** The pkRoot of the post-quantum key that owns it. */
  owner: string;
  clone: CloneSpec;
  created: string;
}

const STORE = "erc8286-accounts";
const listeners = new Set<() => void>();
let cache: StoredAccount[] | null = null;

function read(): StoredAccount[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORE);
    // Wallet-owned accounts came from an earlier version of the playground, which no longer signs for them.
    cache = raw ? (JSON.parse(raw) as (StoredAccount & { signer?: string })[]).filter((a) => a.signer !== "wallet") : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(xs: StoredAccount[]): void {
  cache = xs;
  try {
    localStorage.setItem(STORE, JSON.stringify(xs));
  } catch {
    // no storage: the list lasts for this page load only
  }
  listeners.forEach((l) => l());
}

export const storedAccounts = (): StoredAccount[] => read();
export const onStoredAccountsChanged = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function rememberAccount(a: Omit<StoredAccount, "created">): void {
  if (read().some((x) => x.address === a.address)) return;
  write([{ ...a, created: new Date().toISOString() }, ...read()]);
}

export function forgetAccount(address: string): void {
  write(read().filter((x) => x.address !== address));
}

/** Query string for /api/pg/account: the address and, for an undeployed account, its clone spec. */
export function accountQuery(address: string, clone: CloneSpec | null | undefined): string {
  const q = new URLSearchParams({ address });
  if (clone) {
    q.set("implementation", clone.implementation);
    q.set("args", clone.args);
    q.set("salt", clone.salt);
  }
  return q.toString();
}
