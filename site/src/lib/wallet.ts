// The visitor's wallet, through the injected EIP-1193 provider. Used for two things only:
// giving an address to own a new account, and signing the EIP-712 typed data (carrying the
// transaction's sig_hash) for a send.
// The wallet never pays gas: the account pays for its own frame transaction.

import { DORA } from "./api";

interface Eip1193 {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
}
declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

export const hasWallet = () => typeof window !== "undefined" && window.ethereum !== undefined;

/** EIP-1193 providers reject with plain objects ({ code, message, data }), not Error instances. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as { code?: number; message?: string; data?: { message?: string } };
    const msg = o.data?.message ?? o.message;
    if (o.code === 4001) return "You rejected the request in the wallet.";
    if (msg) return o.code !== undefined ? `${msg} (code ${o.code})` : msg;
    try {
      return JSON.stringify(e);
    } catch {
      return "Unknown wallet error";
    }
  }
  return String(e);
}

/** Calls the provider and turns its rejection into an Error with a readable message. */
async function request<T>(method: string, params?: unknown[]): Promise<T> {
  const eth = window.ethereum;
  if (!eth) throw new Error("No wallet found. Install MetaMask or another EIP-1193 wallet.");
  try {
    return (await eth.request({ method, params })) as T;
  } catch (e) {
    throw new Error(describeError(e));
  }
}

const CHAIN_HEX = "0x1fcd"; // 8141

export async function connectWallet(rpc: string): Promise<string> {
  const accounts = await request<string[]>("eth_requestAccounts");
  const addr = accounts[0];
  if (!addr) throw new Error("The wallet returned no account.");
  try {
    await window.ethereum!.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
  } catch {
    // The wallet does not know the chain. The standard code is 4902, but MetaMask also
    // reports it as -32603 "Unrecognized chain ID", so any failure here means: add it.
    // Adding a chain also switches to it.
    await request("wallet_addEthereumChain", [
      { chainId: CHAIN_HEX, chainName: "Hegota testnet", rpcUrls: [rpc], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: [DORA] },
    ]);
  }
  const chain = await request<string>("eth_chainId");
  if (chain.toLowerCase() !== CHAIN_HEX) throw new Error(`Wallet is on chain ${parseInt(chain, 16)}, not 8141. Switch it to Hegota.`);
  return addr;
}

export function onAccountsChanged(cb: (addr: string | null) => void): void {
  window.ethereum?.on?.("accountsChanged", (accounts) => cb((accounts as string[])[0] ?? null));
}

/** eth_signTypedData_v4 over the typed data /prepare returned (bigints already strings). */
export async function signTypedData(from: string, typedData: unknown): Promise<string> {
  return request<string>("eth_signTypedData_v4", [from, JSON.stringify(typedData)]);
}
