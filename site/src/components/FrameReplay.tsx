import { Fragment, useEffect, useMemo, useState } from "react";
import { Pause, Play, RotateCcw, StepForward } from "lucide-react";
import { Hint } from "@/components/Hint";
import { CopyAddress } from "@/components/CopyAddress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ethStr, frameOutcomes, SCOPE_WORD, type FrameOutcome, type Receipt, type SentFrame } from "@/lib/api";

/**
 * Replays a mined frame transaction the way the node ran it: a cursor moves down the frames
 * in order; APPROVE flips the transaction state (approved, payer, nonce, escrow); a divider
 * marks where validation ends and the account starts acting; atomic groups fail together;
 * settlement refunds the payer. Everything shown comes from the receipt and the frames sent.
 */
export interface ReplayInput {
  account: string;
  frames: SentFrame[];
  /** Declared gas limit per frame, in order, as sent. */
  gasLimits?: number[];
  /** Escrowed at payment approval: the transaction's max cost, wei. */
  maxCost?: string;
  /** Keyed nonce before this transaction. */
  nonce?: number;
  receipt?: Receipt;
  /** submitted: waiting for the block. */
  pending: boolean;
}

const BEAT_MS = 1000;

export function FrameReplay({ account, frames, gasLimits, maxCost, nonce, receipt, pending }: ReplayInput) {
  const fr = receipt?.frameReceipts ?? [];
  const outcomes = useMemo(() => frameOutcomes(frames, fr), [frames, fr]);
  // The validation prefix is every frame before the first SENDER frame.
  const firstSender = frames.findIndex((f) => f.mode === "SENDER");
  const prefixEnd = firstSender === -1 ? frames.length : firstSender;
  // Beats: one per frame, one for the divider (after the prefix), one for settlement.
  // Beat b sits on frame b for b < prefixEnd, on the divider at prefixEnd, on frame b - 1 after.
  const total = frames.length + 2;
  const [beat, setBeat] = useState(-1);
  const [playing, setPlaying] = useState(true);

  // Start when the receipt lands; replay from the top on each new one.
  useEffect(() => {
    setBeat(receipt ? 0 : -1);
    setPlaying(true);
  }, [receipt]);
  useEffect(() => {
    if (!receipt || !playing || beat >= total - 1) return;
    const t = window.setTimeout(() => setBeat((b) => b + 1), beat === prefixEnd ? BEAT_MS * 1.4 : BEAT_MS);
    return () => window.clearTimeout(t);
  }, [receipt, playing, beat, total, prefixEnd]);

  const frameOfBeat = (b: number) => (b < prefixEnd ? b : b === prefixEnd ? -1 : b - 1);
  const cursor = beat < 0 ? -1 : frameOfBeat(beat);
  const reached = (i: number) => (i < prefixEnd ? beat >= i : beat >= i + 1);
  const settled = beat >= total - 1;

  // Transaction state as of the cursor: what APPROVE has done so far.
  const state = useMemo(() => {
    let approved = false;
    let payer: string | null = null;
    let nonceNow = nonce ?? 0;
    let escrow = false;
    frames.forEach((f, i) => {
      if (!reached(i) || fr[i]?.status !== "0x1") return;
      if (f.mode === "VERIFY") {
        const s = f.scope ?? 0;
        if (s & 2) approved = true;
        if (s & 1 && !payer) {
          payer = account;
          nonceNow += 1;
          escrow = true;
        }
      }
      if (f.mode === "PAY" && !payer) {
        payer = receipt?.payer ?? "paymaster";
        nonceNow += 1;
        escrow = true;
      }
    });
    return { approved, payer, nonceNow, escrow };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beat, frames, fr, nonce, account, receipt]);

  // Atomic groups: the index of the member that failed, if any, so earlier members flip to
  // "rolled back" only once the cursor reaches it, and later members are skipped.
  const failAt = useMemo((): (number | null)[] => {
    const out: (number | null)[] = frames.map(() => null);
    let start = 0;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i]?.atomic && i + 1 < frames.length) continue;
      const bad = fr.slice(start, i + 1).findIndex((r) => r.status !== "0x1" && r.status !== "0x2");
      if (bad !== -1) for (let j = start; j <= i; j++) out[j] = start + bad;
      start = i + 1;
    }
    return out;
  }, [frames, fr]);

  const shown = (i: number): FrameOutcome | "pending" | "running" => {
    if (!receipt) return "pending";
    if (!reached(i)) return i === cursor ? "running" : "pending";
    const o = outcomes[i] ?? "ok";
    const fa = failAt[i] ?? null;
    if (o === "rolled" && fa !== null && !reached(fa)) return "ok";
    if (o === "skip" && fa !== null && !reached(fa)) return "pending";
    return o;
  };

  const cost = receipt ? BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? "0x0") : 0n;
  const escrowed = maxCost ? BigInt(maxCost) : 0n;

  const groupClass = (i: number) => {
    const joinedToPrev = i > 0 && frames[i - 1]!.atomic;
    const inGroup = frames[i]!.atomic || joinedToPrev;
    if (!inGroup) return "";
    const fa = failAt[i] ?? null;
    const broken = fa !== null && reached(fa);
    return `replay-group ${broken ? "replay-group-broken" : ""} ${joinedToPrev ? "replay-group-cont" : "replay-group-start"}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <StateStrip approved={state.approved} payer={state.payer} nonce={nonce} nonceNow={state.nonceNow} escrow={state.escrow} escrowed={escrowed} cost={cost} settled={settled} receipt={receipt} />

      <ol className="replay">
        {frames.map((f, i) => {
          const r = fr[i];
          const o = shown(i);
          const limit = gasLimits?.[i] ?? 0;
          const used = r ? Number(r.gasUsed) : 0;
          const fill = reached(i) && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
          return (
            <Fragment key={i}>
              {i === prefixEnd && (
                <li className={`replay-divider ${beat >= prefixEnd ? "is-reached" : ""} ${beat === prefixEnd ? "is-cursor" : ""}`}>
                  <Hint text="sender_approved is set and the payer is committed. SENDER frames now run with caller = tx.sender; a failing one reverts alone, the rest still run and the gas is still paid.">
                    From here the account acts and the payer pays
                  </Hint>
                </li>
              )}
              <li className={`replay-row ${i === cursor ? "is-cursor" : ""} ${reached(i) ? "is-reached" : ""} ${groupClass(i)}`} data-outcome={o}>
                <span className="replay-index tabular-nums">{i}</span>
                <span>
                  <Badge variant={f.mode === "VERIFY" ? "info" : f.mode === "PAY" ? "success" : f.mode === "DEFAULT" ? "secondary" : "warning"}>{f.mode === "PAY" ? "VERIFY" : f.mode}</Badge>
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm">{f.label}</span>
                  {f.mode === "VERIFY" && reached(i) && r?.status === "0x1" && (
                    <span className="replay-approve font-mono text-xs text-muted-foreground">
                      APPROVE(0x{(f.scope ?? 0).toString(16)}): {SCOPE_WORD[(f.scope ?? 3) as 1 | 2 | 3].toLowerCase()}
                    </span>
                  )}
                  {f.mode === "PAY" && reached(i) && r?.status === "0x1" && <span className="replay-approve font-mono text-xs text-muted-foreground">APPROVE(0x1): paymaster pays</span>}
                  {f.mode === "DEFAULT" && reached(i) && r?.status === "0x1" && <span className="replay-approve font-mono text-xs text-muted-foreground">CREATE2: the account now has code</span>}
                </span>
                <span className="replay-fuel" title={limit ? `${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} gas` : undefined}>
                  <span className="replay-fuel-bar" style={{ width: `${fill}%` }} />
                  <span className="replay-fuel-text tabular-nums">{reached(i) && r ? used.toLocaleString("en-US") : limit ? `${limit.toLocaleString("en-US")} max` : ""}</span>
                </span>
                <span className="replay-verdict">
                  {o === "ok" && <Badge variant="success">done</Badge>}
                  {o === "bad" && <Badge variant="error">failed</Badge>}
                  {o === "skip" && <Badge variant="secondary">skipped</Badge>}
                  {o === "rolled" && (
                    <Hint text="Completed, then undone with its atomic group. The receipt still says 0x1: ethrex records the frame's own result, not the rollback.">
                      <Badge variant="warning">rolled back</Badge>
                    </Hint>
                  )}
                  {o === "running" && <Badge variant="outline">running</Badge>}
                  {o === "pending" && <span className="text-xs text-muted-foreground">{pending && !receipt ? "waiting for the block" : ""}</span>}
                </span>
              </li>
            </Fragment>
          );
        })}
      </ol>

      {receipt && (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { setBeat(0); setPlaying(true); }}>
            <RotateCcw /> Replay
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setPlaying((p) => !p)} disabled={settled}>
            {playing ? <Pause /> : <Play />} {playing ? "Pause" : "Play"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { setPlaying(false); setBeat((b) => Math.min(total - 1, b + 1)); }} disabled={settled}>
            <StepForward /> Step
          </Button>
          <span className="ms-auto text-xs text-muted-foreground">{settled ? "settled" : beat === prefixEnd ? "validation done" : cursor >= 0 ? `frame ${cursor}` : ""}</span>
        </div>
      )}
    </div>
  );
}

function StateStrip({ approved, payer, nonce, nonceNow, escrow, escrowed, cost, settled, receipt }: { approved: boolean; payer: string | null; nonce?: number; nonceNow: number; escrow: boolean; escrowed: bigint; cost: bigint; settled: boolean; receipt?: Receipt }) {
  const cell = "flex flex-col gap-1 rounded-md border border-border bg-muted/40 px-3 py-2";
  const on = "replay-cell-on";
  return (
    <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      <div className={`${cell} ${approved ? on : ""}`}>
        <Hint text="sender_approved: set by APPROVE with the execution bit; SENDER frames run only once it is set">
          <span className="text-muted-foreground">Approved to execute</span>
        </Hint>
        <span className="font-medium">{approved ? "yes" : "not yet"}</span>
      </div>
      <div className={`${cell} ${payer ? on : ""}`}>
        <Hint text="Set by APPROVE with the payment bit: the account itself, or the paymaster's frame">
          <span className="text-muted-foreground">Payer</span>
        </Hint>
        <span className="font-medium">{payer ? <CopyAddress address={payer} /> : "none"}</span>
      </div>
      <div className={`${cell} ${nonce !== undefined && nonceNow !== nonce ? on : ""}`}>
        <Hint text="The keyed nonce (EIP-8250) is consumed when payment is approved, not when the transaction is included">
          <span className="text-muted-foreground">Nonce</span>
        </Hint>
        <span className="font-medium tabular-nums">{nonce === undefined ? "-" : nonceNow !== nonce ? `${nonce} to ${nonceNow}` : nonce}</span>
      </div>
      <div className={`${cell} ${escrow ? on : ""}`}>
        <Hint text="At payment approval the max cost (every frame's gas limit at the max fee) is taken from the payer; after the last frame the unused part is refunded">
          <span className="text-muted-foreground">{settled ? "Paid" : "Escrowed"}</span>
        </Hint>
        <span className="font-medium tabular-nums">
          {!escrow ? "nothing" : settled && receipt ? `${ethStr(cost)} ETH, ${ethStr(escrowed > cost ? escrowed - cost : 0n)} refunded` : escrowed > 0n ? `${ethStr(escrowed)} ETH held` : "held"}
        </span>
      </div>
    </div>
  );
}

