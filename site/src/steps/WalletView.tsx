import { useState } from "react";
import { ArrowUpRight, Droplet, KeyRound, Plus, RefreshCw, Send, Settings } from "lucide-react";
import { Activity } from "@/components/Activity";
import { AccountAvatar } from "@/components/AccountAvatar";
import { CopyAddress } from "@/components/CopyAddress";
import { Hint } from "@/components/Hint";
import { PqKeys } from "@/components/PqKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { DORA, ethStr, short, FAUCET, MODES, MODE_HINT, MODE_WORD, ROUTE_HINT, ROUTE_WORD, SIGNER_HINT, type Account } from "@/lib/api";
import type { PqKey } from "@/lib/pq";
import type { Run } from "@/steps/ResultStep";

interface Props {
  accounts: Account[];
  active: string | null;
  /** Stored accounts are still being read from the chain. */
  loading: boolean;
  runs: Run[];
  keys: PqKey[];
  onSelect: (address: string) => void;
  onCreate: () => void;
  onSend: () => void;
  onSettings: () => void;
  onOpenRun: (id: number) => void;
  onRefresh: (address: string) => Promise<void>;
}

/** The dashboard: every account this browser made, and the selected one as a wallet. */
export function WalletView({ accounts, active, loading, runs, keys, onSelect, onCreate, onSend, onSettings, onOpenRun, onRefresh }: Props) {
  const account = accounts.find((a) => a.address === active) ?? null;

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        {loading ? (
          <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <Skeleton className="h-64 rounded-2xl" />
            <Skeleton className="h-64 rounded-2xl" />
          </div>
        ) : (
          <Card>
            <CardPanel className="py-10">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia>
                    <img src="/wizard.png" alt="" className="size-14 rounded-md" style={{ imageRendering: "pixelated" }} />
                  </EmptyMedia>
                  <EmptyTitle>No accounts yet</EmptyTitle>
                  <EmptyDescription>
                    An ERC-8286 account is a modular smart account that sends{" "}
                    <a className="underline underline-offset-4" href="https://eips.ethereum.org/EIPS/eip-8141" target="_blank" rel="noreferrer">
                      EIP-8141
                    </a>{" "}
                    frame transactions.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button onClick={onCreate}>
                    <Plus /> Create an account
                  </Button>
                </EmptyContent>
              </Empty>
            </CardPanel>
          </Card>
        )}
        {keys.length > 0 && <PqKeys keys={keys} accounts={accounts} />}
      </div>
    );
  }

  const total = accounts.reduce((n, a) => n + BigInt(a.balance), 0n);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Card className="lg:sticky lg:top-4">
          <CardHeader>
            <CardDescription>Total balance</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{ethStr(total)} ETH</CardTitle>
            <CardDescription>
              {accounts.length} account{accounts.length > 1 ? "s" : ""} on Hegotá
            </CardDescription>
          </CardHeader>
          <CardPanel className="flex flex-col gap-1 pt-0">
            {accounts.map((a) => (
              <button
                key={a.address}
                type="button"
                disabled={a.stale}
                onClick={() => onSelect(a.address)}
                aria-current={a.address === active ? "true" : undefined}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-colors enabled:cursor-pointer enabled:hover:bg-accent disabled:opacity-50 ${a.address === active ? "bg-accent ring-1 ring-border" : ""}`}
              >
                <AccountAvatar address={a.address} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-sm">{short(a.address)}</span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <KeyRound className="size-3" />
                    {a.stale ? "outdated" : !a.deployed ? "not created yet" : `${a.nonce} sent`}
                  </span>
                </span>
                <span className="text-sm tabular-nums">{ethStr(a.balance)}</span>
              </button>
            ))}
            <Button variant="outline" className="mt-2" onClick={onCreate}>
              <Plus /> New account
            </Button>
          </CardPanel>
        </Card>

        {account ? (
          <div className="flex min-w-0 flex-col gap-6">
            <WalletCard account={account} onRefresh={onRefresh} />

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Action icon={<Send className="size-5" />} label="Send" primary onClick={onSend} disabled={account.stale} />
              <Action icon={<Droplet className="size-5" />} label="Fund" href={FAUCET} />
              <Action icon={<Settings className="size-5" />} label="Settings" onClick={onSettings} disabled={account.stale} />
              <Action icon={<ArrowUpRight className="size-5" />} label="Explorer" href={`${DORA}/address/${account.address}`} />
            </div>

            <Activity account={account} runs={runs} onOpenRun={onOpenRun} />

            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
                <CardDescription>Read from the chain, or from the clone code until it exists.</CardDescription>
              </CardHeader>
              <CardPanel>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
                  <dt className="text-muted-foreground">Owner</dt>
                  <dd className="flex flex-wrap items-center gap-2">
                    <Hint text={SIGNER_HINT}>Post-quantum key</Hint>
                    <CopyAddress address={account.owner} className="text-xs text-muted-foreground" />
                  </dd>
                  <dt className="text-muted-foreground">Calls</dt>
                  <dd><Hint text={ROUTE_HINT(account.route)}>{ROUTE_WORD(account.route)}</Hint></dd>
                  <dt className="text-muted-foreground">May approve</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    <Badge variant={account.scopes & 1 ? "success" : "outline"} className={account.scopes & 1 ? "" : "line-through opacity-60"}>Pay gas</Badge>
                    <Badge variant={account.scopes & 2 ? "success" : "outline"} className={account.scopes & 2 ? "" : "line-through opacity-60"}>Execute calls</Badge>
                  </dd>
                  <dt className="text-muted-foreground">Shapes</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {MODES.map((m) => (
                      <Hint key={m} text={MODE_HINT[m]}>
                        <Badge variant={account.modes[m] ? "secondary" : "outline"} className={account.modes[m] ? "" : "line-through opacity-60"}>{MODE_WORD[m]}</Badge>
                      </Hint>
                    ))}
                  </dd>
                  <dt className="text-muted-foreground">Sent</dt>
                  <dd className="tabular-nums">{account.nonce} transaction{account.nonce === 1 ? "" : "s"}</dd>
                </dl>
              </CardPanel>
            </Card>

          </div>
        ) : (
          <Card>
            <CardPanel className="py-10">
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Pick an account</EmptyTitle>
                  <EmptyDescription>Choose one on the left to see it here.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </CardPanel>
          </Card>
        )}
      </div>

      {keys.length > 0 && <PqKeys keys={keys} accounts={accounts} />}
    </div>
  );
}

/** The selected account drawn as a card, in the wizard's own black and grey pixels. */
function WalletCard({ account, onRefresh }: { account: Account; onRefresh: (address: string) => Promise<void> }) {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh(account.address);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="wallet-card relative overflow-hidden rounded-3xl p-6 text-white shadow-lg ring-1 ring-white/10 sm:p-8">
      <span aria-hidden="true" className="wallet-card-grid pointer-events-none absolute inset-0" />
      <img src="/wizard.png" alt="" aria-hidden="true" className="wallet-card-wizard pointer-events-none absolute inset-y-0 end-0 h-full select-none" />
      <div className="relative flex flex-col gap-8">
        <div className="flex flex-wrap items-center gap-2">
          <AccountAvatar address={account.address} className="size-5" />
          <span className="text-sm font-medium text-white/80">ERC-8286 account</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-xs ring-1 ring-white/15">
            <KeyRound className="size-3" />
            post-quantum
          </span>
          {!account.deployed && (
            <Hint text="No code at this address yet. The first transaction carries a deploy frame that creates it.">
              <span className="rounded-full bg-amber-300/20 px-2 py-0.5 text-xs text-amber-100 ring-1 ring-amber-200/25">not created yet</span>
            </Hint>
          )}
          {account.stale && <span className="rounded-full bg-red-400/25 px-2 py-0.5 text-xs ring-1 ring-red-300/30">outdated</span>}
        </div>

        <div>
          <div className="flex items-center gap-1 text-sm text-white/60">
            Balance
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-white/70 hover:bg-white/10 hover:text-white"
              aria-label="Refresh balance"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? "animate-spin" : ""} />
            </Button>
          </div>
          <div className="text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">
            {ethStr(account.balance)} <span className="text-2xl font-normal text-white/60 sm:text-3xl">ETH</span>
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-xs text-white/50">Address · Hegotá testnet</div>
          <CopyAddress address={account.address} full className="text-sm text-white/90 hover:text-white max-sm:[&>span]:max-w-[16rem]" />
        </div>
      </div>
    </div>
  );
}

/** A big square-ish button under the wallet card. */
function Action({ icon, label, onClick, href, primary = false, disabled = false }: { icon: React.ReactNode; label: string; onClick?: () => void; href?: string; primary?: boolean; disabled?: boolean }) {
  const className = "h-auto flex-col gap-1.5 rounded-2xl py-4 sm:h-auto";
  if (href) {
    return (
      <Button variant="outline" className={className} render={<a href={href} target="_blank" rel="noreferrer" />}>
        {icon}
        {label}
      </Button>
    );
  }
  return (
    <Button variant={primary ? "default" : "outline"} className={className} onClick={onClick} disabled={disabled}>
      {icon}
      {label}
    </Button>
  );
}
