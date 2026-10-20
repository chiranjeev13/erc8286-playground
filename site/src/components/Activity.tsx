import { useEffect, useRef, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, Check, ExternalLink, Play, RefreshCw, Settings2, Sparkles, X } from "lucide-react";
import { Hint } from "@/components/Hint";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ethStr, short, DORA, type Account, type HistoryItem } from "@/lib/api";
import { TONE, type Run } from "@/steps/ResultStep";

const PAGE = 10;

/** "3 min. ago", from a unix time. */
function ago(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** What a transaction did, in a few words. */
function title(h: HistoryItem): string {
  if (h.kind === "in") return `Received ${ethStr(h.value)} ETH`;
  if (h.kind === "out") return `Sent ${ethStr(h.value)} ETH`;
  const calls = h.calls.filter((c) => !c.settings);
  if (calls.length === 0) return h.calls.length ? "Changed settings" : h.creates ? "Created the account" : "Frame transaction";
  const targets = new Set(calls.map((c) => c.to));
  const where = targets.size === 1 ? ` to ${short(calls[0]!.to)}` : ` in ${calls.length} calls`;
  return BigInt(h.value) > 0n ? `Sent ${ethStr(h.value)} ETH${where}` : `Called ${targets.size === 1 ? short(calls[0]!.to) : `${calls.length} targets`}`;
}

interface Props {
  account: Account;
  /** This session's sends, for the replay and for what the explorer has not indexed yet. */
  runs: Run[];
  onOpenRun: (id: number) => void;
}

/** The account's transactions on chain, newest first, with this session's pending sends on top. */
export function Activity({ account, runs, onOpenRun }: Props) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  /** The account the latest request was for; an answer for any other one is dropped. */
  const latest = useRef(account.address);

  const load = async () => {
    const address = account.address;
    latest.current = address;
    setLoading(true);
    setError(null);
    try {
      const { items } = await api<{ items: HistoryItem[] }>(`/api/pg/history?address=${address}`);
      if (latest.current === address) setItems(items);
    } catch (e) {
      if (latest.current === address) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (latest.current === address) setLoading(false);
    }
  };

  // Reload when the account changes, and when a send or a top-up moves its nonce or balance.
  useEffect(() => {
    setItems(null);
    setShown(PAGE);
  }, [account.address]);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.address, account.nonce, account.balance]);

  const mine = runs.filter((r) => r.account === account.address);
  const pending = mine.filter((r) => !items?.some((h) => h.hash === r.hash));
  const runFor = (hash: string) => mine.find((r) => r.hash === hash);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>
          <Hint text="Blocks come from the Dora explorer's address index; each transaction, its frames and their results are read from the node.">Everything this account sent or received.</Hint>
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon-sm" aria-label="Reload activity" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        </CardAction>
      </CardHeader>
      <CardPanel className="flex flex-col gap-1">
        {pending.length > 0 && (
          <ul className="-mx-2 flex flex-col">
            {pending.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => onOpenRun(r.id)} className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2.5 text-start hover:bg-accent">
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                    <ArrowUpRight className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{r.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      This session · {r.frames} frame{r.frames > 1 ? "s" : ""}
                      {r.payer ? " · sponsored" : ""}
                      {r.status === "mined" || r.status === "reverted" ? " · waiting for the explorer" : ""}
                    </span>
                  </span>
                  <Badge variant={TONE[r.status]}>{r.status}</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}

        {items === null && !error ? (
          <div className="flex flex-col gap-3 py-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-9 rounded-full" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        ) : error ? (
          <p className="text-sm text-destructive-foreground">Could not load the history: {error}</p>
        ) : items!.length === 0 && pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing yet. {account.deployed ? "" : "The account is created by its first transaction. "}Press Send to build a frame transaction.
          </p>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {items!.slice(0, shown).map((h) => {
              const expanded = open === h.hash;
              const run = runFor(h.hash);
              const Icon = h.kind === "in" ? ArrowDownLeft : h.creates ? Sparkles : h.calls.length && h.calls.every((c) => c.settings) ? Settings2 : ArrowUpRight;
              const signed = h.kind === "in" ? "+" : BigInt(h.value) > 0n ? "-" : "";
              return (
                <li key={h.hash} className="rounded-lg data-[open=true]:bg-accent/50" data-open={expanded}>
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : h.hash)}
                    aria-expanded={expanded}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2.5 text-start hover:bg-accent"
                  >
                    <span className={`inline-flex size-9 shrink-0 items-center justify-center rounded-full ${h.kind === "in" ? "bg-success/12 text-success-foreground" : "bg-muted"}`}>
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">
                        {title(h)}
                        {h.status === "partial" && <Badge variant="warning" size="sm">some calls failed</Badge>}
                        {h.status === "failed" && <Badge variant="error" size="sm">{h.kind === "frame" ? "calls failed" : "reverted"}</Badge>}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {ago(h.time)}
                        {h.kind === "in" && h.counterparty ? ` · from ${short(h.counterparty)}` : ""}
                        {h.creates ? " · created the account" : ""}
                        {h.payer ? " · gas paid by the paymaster" : ""}
                      </span>
                    </span>
                    <span className="flex flex-col items-end">
                      <span className={`text-sm tabular-nums ${h.kind === "in" ? "text-success-foreground" : ""}`}>
                        {signed}
                        {ethStr(h.value)} ETH
                      </span>
                      {!h.payer && h.kind !== "in" && <span className="text-xs text-muted-foreground tabular-nums">fee {ethStr(h.fee)}</span>}
                    </span>
                    <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
                  </button>
                  {expanded && (
                    <div className="flex flex-col gap-3 px-2 pt-1 pb-3 ps-14 text-sm">
                      {h.calls.length > 0 && (
                        <ul className="flex flex-col gap-1">
                          {h.calls.map((c, i) => (
                            <li key={i} className="flex items-center gap-2">
                              {c.ok ? <Check className="size-3.5 text-success" /> : <X className="size-3.5 text-destructive" />}
                              <span className="text-muted-foreground">{c.settings ? "Settings change" : "Call"}</span>
                              <span className="font-mono text-xs">{short(c.to)}</span>
                              {!c.settings && <span className="ms-auto tabular-nums">{ethStr(c.value)} ETH</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
                        <dt className="text-muted-foreground">Block</dt>
                        <dd className="tabular-nums">{h.block.toLocaleString("en-US")}</dd>
                        <dt className="text-muted-foreground">Fee</dt>
                        <dd className="tabular-nums">
                          {ethStr(h.fee)} ETH{h.payer ? `, paid by ${short(h.payer)}` : ""}
                        </dd>
                        <dt className="text-muted-foreground">Hash</dt>
                        <dd className="truncate font-mono">{h.hash}</dd>
                      </dl>
                      <div className="flex flex-wrap gap-2">
                        {run && (
                          <Button size="sm" variant="outline" onClick={() => onOpenRun(run.id)}>
                            <Play /> Replay frames
                          </Button>
                        )}
                        <Button size="sm" variant="outline" render={<a href={`${DORA}/tx/${h.hash}`} target="_blank" rel="noreferrer" />}>
                          Explorer <ExternalLink />
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {items && items.length > shown && (
          <Button variant="ghost" className="self-center" onClick={() => setShown((n) => n + PAGE)}>
            Show more ({items.length - shown})
          </Button>
        )}
      </CardPanel>
    </Card>
  );
}
