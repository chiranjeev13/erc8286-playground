import { Check, ExternalLink, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DORA, short, type Receipt, type SentFrame } from "@/lib/api";
import { SignatureView, type SignatureInfo } from "@/components/SignatureView";
import { FrameReplay } from "@/components/FrameReplay";

export interface Run {
  id: number;
  label: string;
  account: string;
  frames: number;
  /** A paymaster frame sits at index 1. */
  payer: boolean;
  /** Every frame of the transaction, in order. */
  sentFrames: SentFrame[];
  status: "signing" | "simulating" | "refused" | "submitted" | "mined" | "reverted" | "error";
  message: string;
  /** Signed by a post-quantum key in this browser rather than a wallet. */
  pq?: boolean;
  /** The account's signature, once made. */
  signature?: SignatureInfo;
  hash?: string;
  receipt?: Receipt;
  /** From /send: declared gas limit per frame, the keyed nonce used, the escrowed max cost. */
  gasLimits?: number[];
  nonce?: number;
  maxCost?: string;
}

interface Props {
  run: Run;
  history: Run[];
  onAgain: () => void;
  onNewAccount: () => void;
}

const TONE: Record<Run["status"], "info" | "success" | "warning" | "error"> = {
  signing: "info",
  simulating: "info",
  submitted: "info",
  mined: "success",
  reverted: "warning",
  refused: "error",
  error: "error",
};

export function ResultStep({ run, history, onAgain, onNewAccount }: Props) {
  const r = run.receipt;
  const stages = [
    { name: run.pq ? "Post-quantum signature" : "Wallet signature", state: run.status === "signing" ? "busy" : run.status === "error" ? "bad" : "ok" },
    { name: "Node simulation", state: run.status === "signing" ? "wait" : run.status === "simulating" ? "busy" : run.status === "refused" || run.status === "error" ? "bad" : "ok" },
    { name: "Submitted", state: run.status === "submitted" || run.status === "mined" || run.status === "reverted" ? "ok" : run.status === "simulating" || run.status === "signing" ? "wait" : "skip" },
    { name: "Mined", state: run.status === "mined" || run.status === "reverted" ? "ok" : run.status === "submitted" ? "busy" : run.status === "simulating" || run.status === "signing" ? "wait" : "skip" },
  ] as const;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Progress</CardTitle>
          </CardHeader>
          <CardPanel>
            <ol className="flex flex-col gap-3">
              {stages.map((s) => (
                <li key={s.name} className="flex items-center gap-3">
                  <span className="inline-flex size-6 items-center justify-center rounded-full bg-muted">
                    {s.state === "busy" && <Spinner className="size-3.5" />}
                    {s.state === "ok" && <Check className="size-3.5 text-success" />}
                    {s.state === "bad" && <X className="size-3.5 text-destructive" />}
                  </span>
                  <span className={s.state === "wait" || s.state === "skip" ? "text-muted-foreground" : ""}>{s.name}</span>
                </li>
              ))}
            </ol>
            {(run.status === "refused" || run.status === "error") && (
              <Alert variant="error" className="mt-4">
                <AlertTitle>{run.status === "refused" ? "Refused by the network" : "Something went wrong"}</AlertTitle>
                <AlertDescription>{run.status === "refused" ? <>Nothing happened and nobody paid. Reason: <span className="font-mono">{run.message}</span></> : run.message}</AlertDescription>
              </Alert>
            )}
            {run.hash && (
              <Button variant="link" className="mt-4 px-0" render={<a href={`${DORA}/tx/${run.hash}`} target="_blank" rel="noreferrer" />}>
                {short(run.hash)} <ExternalLink />
              </Button>
            )}
          </CardPanel>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Frames</CardTitle>
            <CardDescription>Replayed as the node ran them.</CardDescription>
          </CardHeader>
          <CardPanel>
            {run.status === "refused" || run.status === "error" ? (
              <p className="text-sm text-muted-foreground">Nothing ran: the node stopped before the first frame.</p>
            ) : (
              <FrameReplay account={run.account} frames={run.sentFrames} gasLimits={run.gasLimits} maxCost={run.maxCost} nonce={run.nonce} receipt={r} pending={run.status === "submitted"} />
            )}
          </CardPanel>
        </Card>
      </div>

      {run.signature && <SignatureView sig={run.signature} />}

      <Card>
        <CardFooter className="justify-between">
          <Button variant="ghost" onClick={onNewAccount}>
            New account
          </Button>
          <Button onClick={onAgain}>Send another</Button>
        </CardFooter>
      </Card>

      {history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Earlier this session</CardTitle>
          </CardHeader>
          <CardPanel>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>What</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Frames</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="text-end">Tx</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell>{h.label}</TableCell>
                    <TableCell className="font-mono text-xs">{short(h.account)}</TableCell>
                    <TableCell className="tabular-nums">{h.frames}</TableCell>
                    <TableCell><Badge variant={TONE[h.status]}>{h.status}</Badge></TableCell>
                    <TableCell className="text-end">
                      {h.hash ? (
                        <a className="font-mono text-xs underline-offset-4 hover:underline" href={`${DORA}/tx/${h.hash}`} target="_blank" rel="noreferrer">
                          {short(h.hash)}
                        </a>
                      ) : (
                        "-"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardPanel>
        </Card>
      )}
    </div>
  );
}
