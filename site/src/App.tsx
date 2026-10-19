import { useEffect, useState, useSyncExternalStore } from "react";
import { Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { ToastProvider, toastManager } from "@/components/ui/toast";
import { api, execute, frameLabel, short, toWei, transfer, DEAD, DORA, FAUCET, SCOPE_WORD, type Account, type FrameSpec, type Info, type Paymaster, type Prepared, type Receipt, type SentFrame, type Sim, type VerifySpec, PRESETS } from "@/lib/api";
import { connectWallet, describeError, hasWallet, onAccountsChanged, signTypedData } from "@/lib/wallet";
import { findPqKey, onPqKeysChanged, pqKeys, pqSign } from "@/lib/pq";
import { accountQuery, onStoredAccountsChanged, rememberAccount, storedAccounts } from "@/lib/accounts";
import { CopyAddress } from "@/components/CopyAddress";
import { Mascot } from "@/components/Mascot";
import { SettingsSheet } from "@/components/SettingsSheet";
import { Rain } from "@/components/Rain";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AccountStep } from "@/steps/AccountStep";
import { ResultStep, type Run } from "@/steps/ResultStep";
import { ReviewStep } from "@/steps/ReviewStep";
import { TransactionStep } from "@/steps/TransactionStep";

const STEPS = ["account", "transaction", "review", "result"] as const;
export type Step = (typeof STEPS)[number];
const STEP_LABEL: Record<Step, string> = { account: "Account", transaction: "Transaction", review: "Review", result: "Result" };

/** Unique per run even across hot reloads of this module; a counter reset to 1 could reuse a dismissed run's id and hide the widget. */
const nextRunId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

export function App() {
  const [step, setStep] = useState<Step>("account");
  const [info, setInfo] = useState<Info | null>(null);
  const [wallet, setWallet] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [paymaster, setPaymaster] = useState<Paymaster | null>(null);
  const [usePaymaster, setUsePaymaster] = useState(false);
  const [verify, setVerify] = useState<VerifySpec>(PRESETS[0]!.verify);
  const [frames, setFrames] = useState<FrameSpec[]>(() => PRESETS[0]!.frames());
  const [presetId, setPresetId] = useState<string | null>("transfer");
  const [runs, setRuns] = useState<Run[]>([]);
  const [sending, setSending] = useState(false);
  const keys = useSyncExternalStore(onPqKeysChanged, pqKeys);
  const stored = useSyncExternalStore(onStoredAccountsChanged, storedAccounts);

  const account = accounts.find((a) => a.address === active) ?? null;
  const payer = usePaymaster ? paymaster : null;
  const current = runs[0] ?? null;
  /** Who can sign for the selected account here: the connected wallet, a post-quantum key in
   * this browser, or nobody present. */
  const signer: "wallet" | "pq" | "other" =
    account === null ? "other"
    : account.signer === "pq" ? (findPqKey(account.owner) ? "pq" : "other")
    : wallet && wallet.toLowerCase() === account.owner.toLowerCase() ? "wallet"
    : "other";

  useEffect(() => {
    void (async () => {
      try {
        setInfo(await api<Info>("/api/pg/info"));
        setPaymaster(await api<Paymaster>("/api/pg/paymaster"));
      } catch (e) {
        toastManager.add({ type: "error", title: "Playground server", description: e instanceof Error ? e.message : String(e) });
      }
    })();
    onAccountsChanged(setWallet);
  }, []);

  // The accounts this browser created, from its own list; the server reads each one's live
  // state and keeps no record of its own.
  const storedKey = stored.map((s) => s.address).join(",");
  useEffect(() => {
    if (!storedKey) return;
    void (async () => {
      const results = await Promise.allSettled(stored.map((s) => api<Account>(`/api/pg/account?${accountQuery(s.address, s.clone)}`)));
      const mine = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failed = results.filter((r) => r.status === "rejected").length;
      setAccounts((xs) => [...mine, ...xs.filter((x) => !mine.some((m) => m.address === x.address))]);
      setActive((a) => a ?? mine.find((m) => !m.stale)?.address ?? null);
      if (failed) toastManager.add({ type: "error", title: "Accounts", description: `${failed} stored account${failed > 1 ? "s" : ""} could not be read.` });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  const connect = async () => {
    setConnecting(true);
    try {
      setWallet(await connectWallet(info?.rpc ?? "https://rpc1.privacy.ethrex.xyz"));
    } catch (e) {
      toastManager.add({ type: "error", title: "Wallet", description: describeError(e) });
    } finally {
      setConnecting(false);
    }
  };

  const refreshAccount = async (address: string) => {
    const clone = stored.find((s) => s.address === address)?.clone ?? accounts.find((x) => x.address === address)?.clone;
    const a = await api<Account>(`/api/pg/account?${accountQuery(address, clone)}`);
    setAccounts((xs) => xs.map((x) => (x.address === address ? a : x)));
  };

  const onDeployed = (a: Account) => {
    if (a.clone) rememberAccount({ address: a.address, signer: a.signer, owner: a.owner, clone: a.clone });
    setAccounts((xs) => [a, ...xs.filter((x) => x.address !== a.address)]);
    setActive(a.address);
    toastManager.add({ type: "success", title: "Account address reserved", description: `${short(a.address)} owned by ${a.signer === "pq" ? "post-quantum key" : "wallet"} ${short(a.owner)}. Fund it at the faucet, or let the paymaster pay its first transaction.` });
  };

  const patchRun = (id: number, patch: Partial<Run>) => setRuns((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  // A contract-route account targets itself in every SENDER frame, a protocol-route one
  // targets recipients directly. When the selected account's route differs from the frames
  // already built, rebuild them for that route; settings frames fit either.
  useEffect(() => {
    if (!account) return;
    setFrames((fs) =>
      fs.map((f) => {
        if (account.route === 1 && f.kind === "transfer") return { ...execute([{ target: f.target, eth: f.eth }], f.atomic), id: f.id };
        if (account.route === 0 && f.kind === "execute") return { ...transfer(f.calls[0]?.target ?? DEAD, f.calls[0]?.eth ?? 0.001, f.atomic), id: f.id };
        return f;
      }),
    );
  }, [account?.address, account?.route]);

  const send = async () => {
    if (!account || signer === "other") return;
    const wire = frames.map((f) => {
      if (f.kind === "transfer") return { kind: "transfer", target: f.target, valueWei: toWei(f.eth), atomic: f.atomic };
      if (f.kind === "execute") return { kind: "execute", calls: f.calls.map((c) => ({ target: c.target, valueWei: toWei(c.eth) })), atomic: f.atomic };
      if (f.kind === "setScopes") return { kind: "setScopes", scopes: f.scopes, atomic: f.atomic };
      return { kind: "setMode", mode: f.mode, supported: f.supported, atomic: f.atomic };
    });
    const run: Run = {
      id: nextRunId(),
      label: PRESETS.find((p) => p.id === presetId)?.label ?? (frames.some((f) => f.kind === "setScopes" || f.kind === "setMode") ? "Settings" : "Custom"),
      account: account.address,
      frames: frames.length,
      payer: payer !== null,
      sentFrames: [
        ...(account.deployed ? [] : [{ mode: "DEFAULT", label: "create the account" } as SentFrame]),
        { mode: "VERIFY", label: `${SCOPE_WORD[verify.scope]}${account.signer === "pq" ? ", post-quantum signature" : ""}`, scope: verify.scope } as SentFrame,
        ...(payer ? [{ mode: "PAY", label: `paymaster ${short(payer.address)}`, scope: 1 } as SentFrame] : []),
        ...frames.map((f): SentFrame => ({ mode: "SENDER", label: frameLabel(f), atomic: f.atomic })),
      ],
      status: "signing",
      message: "",
      pq: account.signer === "pq",
    };
    setRuns((rs) => [run, ...rs]);
    setStep("result");
    setSending(true);
    try {
      const prep = await api<Prepared>("/api/pg/prepare", { account: account.address, frames: wire, clone: account.clone });
      // A wallet signs the typed data; a post-quantum key signs its hash, right here in the browser.
      const t0 = performance.now();
      const signature = signer === "pq" ? await pqSign(findPqKey(account.owner)!, prep.digest) : await signTypedData(wallet!, prep.typedData);
      patchRun(run.id, { signature: { hex: signature, pq: signer === "pq", ms: signer === "pq" ? performance.now() - t0 : undefined } });
      patchRun(run.id, { status: "simulating" });
      const out = await api<{ sim: Sim; hash: string | null; gasLimits?: number[] }>("/api/pg/send", {
        account: account.address,
        verify,
        frames: wire,
        signature,
        nonce: prep.nonce,
        clone: account.clone,
        payer: payer?.address ?? null,
      });
      if (!out.sim.valid || !out.hash) {
        patchRun(run.id, { status: "refused", message: out.sim.violation ?? "invalid" });
        toastManager.add({ type: "error", title: "Refused by the node", description: out.sim.violation ?? "invalid" });
        return;
      }
      patchRun(run.id, { status: "submitted", hash: out.hash, message: out.sim.prefixShape ?? "prefix ok", gasLimits: out.gasLimits, nonce: prep.nonce, maxCost: out.sim.maxCost ?? undefined });
      setSending(false);
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const { receipt } = await api<{ receipt: Receipt | null }>(`/api/pg/receipt?hash=${out.hash}`);
        if (!receipt) continue;
        const bad = (receipt.frameReceipts ?? []).some((f) => f.status !== "0x1");
        patchRun(run.id, { status: bad ? "reverted" : "mined", receipt, message: "" });
        toastManager.add({ type: bad ? "warning" : "success", title: bad ? "Mined, a frame reverted" : "Mined", description: `Block ${Number(receipt.blockNumber).toLocaleString("en-US")}` });
        void refreshAccount(account.address);
        return;
      }
      patchRun(run.id, { message: "Not mined within 80 s. Check the explorer." });
    } catch (e) {
      const message = describeError(e);
      const rejected = /denied|rejected/i.test(message);
      patchRun(run.id, { status: "error", message: rejected ? "You rejected the signature in the wallet." : message });
      toastManager.add({ type: "error", title: rejected ? "Signature rejected" : "Send failed", description: rejected ? "Nothing was sent." : message });
    } finally {
      setSending(false);
    }
  };

  const reachable = (s: Step): boolean => {
    if (s === "account") return true;
    if (s === "transaction") return account !== null;
    if (s === "review") return account !== null && frames.length > 0;
    return current !== null;
  };

  return (
    <ToastProvider>
      <div className="relative min-h-svh bg-background text-foreground">
        <Rain />
        <header className="relative z-10 mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-4 sm:px-6">
          <Mascot run={current} />
          <span className="text-base font-semibold tracking-tight">
            ERC-8286 <span className="text-muted-foreground font-normal">Playground</span>
          </span>
          {account && (
            <Badge variant="outline">
              <CopyAddress address={account.address} />
            </Badge>
          )}
          <Badge variant={info ? "success" : "secondary"}>{info ? `Hegota - block ${Number(info.head).toLocaleString("en-US")}` : "connecting..."}</Badge>
          <div className="ms-auto flex items-center gap-3">
            {wallet ? (
              <Badge variant="info">
                <Wallet /> <CopyAddress address={wallet} />
              </Badge>
            ) : (
              <Button variant="outline" size="sm" onClick={() => void connect()} loading={connecting} disabled={!hasWallet()} title={hasWallet() ? undefined : "No wallet found"}>
                <Wallet /> Connect wallet
              </Button>
            )}
            <a className="text-sm text-muted-foreground underline-offset-4 hover:underline" href={FAUCET} target="_blank" rel="noreferrer">
              Faucet
            </a>
            <a className="text-sm text-muted-foreground underline-offset-4 hover:underline" href={DORA} target="_blank" rel="noreferrer">
              Explorer
            </a>
            <a className="text-sm text-muted-foreground underline-offset-4 hover:underline" href="https://eips.ethereum.org/EIPS/eip-8286" target="_blank" rel="noreferrer">
              Spec
            </a>
            <SettingsSheet
              account={account}
              paymaster={paymaster}
              onSettings={(f) => {
                setFrames(f);
                setPresetId(null);
                setStep("transaction");
              }}
            />
            <ThemeToggle />
          </div>
        </header>

        <main className="relative z-10 mx-auto max-w-5xl px-4 pb-16 sm:px-6">
          {/* A progress indicator only: the steps move with the Next and Back buttons. */}
          <Tabs value={step}>
            <TabsList variant="underline" className="mb-6 pointer-events-none" aria-hidden="true">
              {STEPS.map((s, i) => (
                <TabsTab key={s} value={s} tabIndex={-1} className={reachable(s) ? "" : "opacity-50"}>
                  <span className="me-2 inline-flex size-5 items-center justify-center rounded-full bg-muted text-xs tabular-nums">{i + 1}</span>
                  {STEP_LABEL[s]}
                </TabsTab>
              ))}
            </TabsList>
          </Tabs>

          {step === "account" && (
            <AccountStep
              accounts={accounts}
              active={active}
              wallet={wallet}
              keys={keys}
              onConnect={() => void connect()}
              connecting={connecting}
              onSelect={setActive}
              onDeployed={onDeployed}
              onNext={() => setStep("transaction")}
            />
          )}
          {step === "transaction" && account && (
            <TransactionStep
              account={account}
              verify={verify}
              frames={frames}
              presetId={presetId}
              paymaster={paymaster}
              payer={payer}
              onPayer={(p) => {
                setUsePaymaster(p);
                // A sponsored account approves execution only; a self-paying one needs both.
                setVerify((x) => ({ ...x, scope: p ? 2 : 3 }));
              }}
              onChange={(v, f, p) => {
                setVerify(v);
                setFrames(f);
                setPresetId(p);
              }}
              onBack={() => setStep("account")}
              onNext={() => setStep("review")}
            />
          )}
          {step === "review" && account && (
            <ReviewStep
              account={account}
              verify={verify}
              frames={frames}
              payer={payer}
              signer={signer}
              sending={sending}
              onConnect={() => void connect()}
              onBack={() => setStep("transaction")}
              onSend={() => void send()}
            />
          )}
          {step === "result" && current && (
            <ResultStep run={current} history={runs.slice(1)} onAgain={() => setStep("transaction")} onNewAccount={() => setStep("account")} />
          )}
        </main>

        <footer className="relative z-10 mx-auto flex max-w-5xl items-center justify-center gap-2 px-4 pb-8 text-sm text-muted-foreground sm:px-6">
          Made with love by{" "}
          <a className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline" href="https://x.com/0xChiranjeev" target="_blank" rel="noreferrer">
            <img src="/wizard.png" alt="" className="size-5 rounded-sm" style={{ imageRendering: "pixelated" }} />
            0xChiranjeev
          </a>
        </footer>

      </div>
    </ToastProvider>
  );
}
