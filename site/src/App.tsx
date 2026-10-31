import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ToastProvider, toastManager } from "@/components/ui/toast";
import { api, execute, frameLabel, short, toWei, transfer, DEAD, DORA, FAUCET, SCOPE_WORD, type Account, type FrameSpec, type Info, type Paymaster, type Prepared, type Receipt, type SentFrame, type Sim, type VerifySpec, PRESETS } from "@/lib/api";
import { findPqKey, onPqKeysChanged, pqKeys, pqSign } from "@/lib/pq";
import { accountQuery, onStoredAccountsChanged, rememberAccount, storedAccounts } from "@/lib/accounts";
import { CopyAddress } from "@/components/CopyAddress";
import { Mascot } from "@/components/Mascot";
import { SettingsSheet } from "@/components/SettingsSheet";
import { Rain } from "@/components/Rain";
import { Stepper } from "@/components/Stepper";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CreateStep } from "@/steps/CreateStep";
import { ResultStep, type Run } from "@/steps/ResultStep";
import { ReviewStep } from "@/steps/ReviewStep";
import { TransactionStep } from "@/steps/TransactionStep";
import { WalletView } from "@/steps/WalletView";

/** The dashboard, the create wizard, or one of the three steps of sending. */
type View = "wallet" | "create" | "transaction" | "review" | "result";
const SEND_STEPS = ["transaction", "review", "result"] as const;
const SEND_LABEL = ["Transaction", "Review", "Result"] as const;

/** Unique per run even across hot reloads of this module; a counter reset to 1 could reuse a dismissed run's id and hide the widget. */
const nextRunId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);

export function App() {
  const [view, setView] = useState<View>("wallet");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [paymaster, setPaymaster] = useState<Paymaster | null>(null);
  const [usePaymaster, setUsePaymaster] = useState(false);
  const [verify, setVerify] = useState<VerifySpec>(PRESETS[0]!.verify);
  const [frames, setFrames] = useState<FrameSpec[]>(() => PRESETS[0]!.frames());
  const [presetId, setPresetId] = useState<string | null>("transfer");
  const [runs, setRuns] = useState<Run[]>([]);
  /** The run the result step shows; the latest when none was picked from the activity list. */
  const [shownRun, setShownRun] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const keys = useSyncExternalStore(onPqKeysChanged, pqKeys);
  const stored = useSyncExternalStore(onStoredAccountsChanged, storedAccounts);

  const account = accounts.find((a) => a.address === active) ?? null;
  const payer = usePaymaster ? paymaster : null;
  const latest = runs[0] ?? null;
  const current = runs.find((r) => r.id === shownRun) ?? latest;
  /** The post-quantum key that signs for the selected account, if this browser holds it. */
  const key = account ? findPqKey(account.owner) : null;

  useEffect(() => {
    void (async () => {
      try {
        setInfo(await api<Info>("/api/pg/info"));
        setPaymaster(await api<Paymaster>("/api/pg/paymaster"));
      } catch (e) {
        toastManager.add({ type: "error", title: "Playground server", description: e instanceof Error ? e.message : String(e) });
      }
    })();
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

  const refreshAccount = async (address: string) => {
    const clone = stored.find((s) => s.address === address)?.clone ?? accounts.find((x) => x.address === address)?.clone;
    const a = await api<Account>(`/api/pg/account?${accountQuery(address, clone)}`);
    setAccounts((xs) => xs.map((x) => (x.address === address ? a : x)));
  };

  const onDeployed = (a: Account) => {
    if (a.clone) rememberAccount({ address: a.address, owner: a.owner, clone: a.clone });
    setAccounts((xs) => [a, ...xs.filter((x) => x.address !== a.address)]);
    setActive(a.address);
    setView("wallet");
    toastManager.add({ type: "success", title: "Account address reserved", description: `${short(a.address)} owned by post-quantum key ${short(a.owner)}. Fund it at the faucet, or let the paymaster pay its first transaction.` });
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
    if (!account || !key) return;
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
        { mode: "VERIFY", label: `${SCOPE_WORD[verify.scope]}, post-quantum signature`, scope: verify.scope } as SentFrame,
        ...(payer ? [{ mode: "PAY", label: `paymaster ${short(payer.address)}`, scope: 1 } as SentFrame] : []),
        ...frames.map((f): SentFrame => ({ mode: "SENDER", label: frameLabel(f), atomic: f.atomic })),
      ],
      status: "signing",
      message: "",
    };
    setRuns((rs) => [run, ...rs]);
    setShownRun(run.id);
    setView("result");
    setSending(true);
    try {
      // Scope, payer and fees are all inside sig_hash now, so /prepare fixes them and /send
      // must get the same ones back.
      const plan = { account: account.address, verify, frames: wire, clone: account.clone, payer: payer?.address ?? null };
      const prep = await api<Prepared>("/api/pg/prepare", plan);
      // The post-quantum key signs sig_hash itself, right here in the browser.
      const t0 = performance.now();
      const signature = await pqSign(key, prep.digest);
      patchRun(run.id, { signature: { hex: signature, ms: performance.now() - t0 } });
      patchRun(run.id, { status: "simulating" });
      const out = await api<{ sim: Sim; hash: string | null; gasLimits?: number[] }>("/api/pg/send", { ...plan, signature, nonce: prep.nonce, fees: prep.fees });
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
      const message = e instanceof Error ? e.message : String(e);
      patchRun(run.id, { status: "error", message });
      toastManager.add({ type: "error", title: "Send failed", description: message });
    } finally {
      setSending(false);
    }
  };

  return (
    <ToastProvider>
      <div className="relative min-h-svh bg-background text-foreground">
        <Rain />
        <header className="relative z-10 mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-4 sm:px-6">
          <Mascot run={latest} />
          <span className="text-base font-semibold tracking-tight">
            ERC-8286 <span className="text-muted-foreground font-normal">Playground</span>
          </span>
          {account && (
            <Badge variant="outline">
              <CopyAddress address={account.address} />
            </Badge>
          )}
          <Badge variant={info ? "success" : "secondary"}>{info ? `Hegota (chain ${info.chainId}) - block ${Number(info.head).toLocaleString("en-US")}` : "connecting..."}</Badge>
          <div className="ms-auto flex items-center gap-3">
            <a className="text-sm text-muted-foreground underline-offset-4 hover:underline" href={FAUCET} target="_blank" rel="noreferrer">
              Faucet
            </a>
            <a className="text-sm text-muted-foreground underline-offset-4 hover:underline" href={DORA} target="_blank" rel="noreferrer">
              Explorer
            </a>
            <a className="text-sm text-muted-foreground underline-offset-4 hover:underline" href="https://eips.ethereum.org/EIPS/eip-8286" target="_blank" rel="noreferrer" title="ERC-8286: Modular Accounts for Frame Transactions">
              ERC-8286
            </a>
            <a className="text-sm text-muted-foreground underline-offset-4 hover:underline" href="https://eips.ethereum.org/EIPS/eip-8141" target="_blank" rel="noreferrer" title="EIP-8141: Frame Transactions">
              EIP-8141
            </a>
            <SettingsSheet
              account={account}
              paymaster={paymaster}
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
              onSettings={(f) => {
                setFrames(f);
                setPresetId(null);
                setView("transaction");
              }}
            />
            <ThemeToggle />
          </div>
        </header>

        <main className="relative z-10 mx-auto max-w-6xl px-4 pb-16 sm:px-6">
          {view === "wallet" && (
            <WalletView
              accounts={accounts}
              active={active}
              loading={stored.length > 0 && accounts.length === 0}
              runs={runs}
              keys={keys}
              onSelect={setActive}
              onCreate={() => setView("create")}
              onSend={() => setView("transaction")}
              onSettings={() => setSettingsOpen(true)}
              onOpenRun={(id) => {
                setShownRun(id);
                setView("result");
              }}
              onRefresh={refreshAccount}
            />
          )}
          {view === "create" && (
            <CreateStep
              keys={keys}
              onDeployed={onDeployed}
              onCancel={accounts.length > 0 || stored.length > 0 ? () => setView("wallet") : undefined}
            />
          )}

          {(view === "transaction" || view === "review" || view === "result") && (
            <div className="mx-auto mb-6 flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-3">
              <Button variant="ghost" size="sm" onClick={() => setView("wallet")}>
                <ArrowLeft /> Wallet
              </Button>
              <div className="min-w-0 flex-1">
                <Stepper steps={SEND_LABEL} current={SEND_STEPS.indexOf(view)} />
              </div>
            </div>
          )}
          <div className="mx-auto max-w-5xl">
            {view === "transaction" && account && (
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
                onBack={() => setView("wallet")}
                onNext={() => setView("review")}
              />
            )}
            {view === "review" && account && (
              <ReviewStep
                account={account}
                verify={verify}
                frames={frames}
                payer={payer}
                canSign={key !== null}
                sending={sending}
                onBack={() => setView("transaction")}
                onSend={() => void send()}
              />
            )}
            {view === "result" && current && (
              <ResultStep run={current} history={runs.filter((r) => r.id !== current.id)} onAgain={() => setView("transaction")} onWallet={() => setView("wallet")} />
            )}
          </div>
        </main>

        <footer className="relative z-10 mx-auto flex max-w-6xl items-center justify-center gap-2 px-4 pb-8 text-sm text-muted-foreground sm:px-6">
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
