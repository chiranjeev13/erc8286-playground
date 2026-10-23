import { Wallet } from "lucide-react";
import { CopyAddress } from "@/components/CopyAddress";
import { Hint } from "@/components/Hint";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { expectation, frameHint, frameLabel, short, MODES, MODE_WORD, ROUTE_WORD, SCOPE_HINT, SCOPE_WORD, SIGNER_HINT, type Account, type FrameSpec, type Paymaster, type VerifySpec } from "@/lib/api";

interface Props {
  account: Account;
  verify: VerifySpec;
  frames: FrameSpec[];
  payer: Paymaster | null;
  /** wallet: the connected wallet owns the account. pq: a post-quantum key in this browser does.
   * other: whoever owns it is not here. */
  signer: "wallet" | "pq" | "other";
  sending: boolean;
  onConnect: () => void;
  onBack: () => void;
  onSend: () => void;
}

export function ReviewStep({ account, verify, frames, payer, signer, sending, onConnect, onBack, onSend }: Props) {
  const exp = expectation(account, verify, frames, payer);
  const title = { success: "Should go through", warning: "Should go through, with a failed frame", error: "Will be refused" }[exp.tone];
  const base = account.deployed ? 0 : 1;
  const offset = base + (payer ? 2 : 1);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>From</CardTitle>
          <CardDescription><CopyAddress address={account.address} full /></CardDescription>
        </CardHeader>
        <CardPanel className="flex flex-wrap gap-1.5">
          <Hint text={SIGNER_HINT[account.signer]}>
            <Badge variant="info">{account.signer === "pq" ? "post-quantum key" : "owner"} {short(account.owner)}</Badge>
          </Hint>
          <Badge variant="secondary">{ROUTE_WORD(account.route).toLowerCase()}</Badge>
          <Badge variant={account.scopes & 1 ? "success" : "outline"} className={account.scopes & 1 ? "" : "line-through opacity-60"}>pays gas</Badge>
          <Badge variant={account.scopes & 2 ? "success" : "outline"} className={account.scopes & 2 ? "" : "line-through opacity-60"}>executes</Badge>
          {MODES.map((m) => (
            <Badge key={m} variant="outline" className={account.modes[m] ? "" : "line-through opacity-60"}>
              {MODE_WORD[m].toLowerCase()}
            </Badge>
          ))}
        </CardPanel>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Frames</CardTitle>
          <CardDescription>
            <Hint text="One EIP-8141 type-0x06 transaction; nonce_keys = [validator]; the owner's signature in one ARBITRARY signature entry, over sig_hash.">In order.</Hint>
          </CardDescription>
        </CardHeader>
        <CardPanel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">Frame</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>What</TableHead>
                <TableHead className="text-end">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!account.deployed && (
                <TableRow>
                  <TableCell className="tabular-nums">0</TableCell>
                  <TableCell><Badge variant="secondary">DEFAULT</Badge></TableCell>
                  <TableCell className="text-xs">factory</TableCell>
                  <TableCell>
                    <Hint text="factory.createAccount(implementation, config, salt), caller ENTRY_POINT; about 23k gas and 320k to 340k state gas">Create the account</Hint>
                  </TableCell>
                  <TableCell className="text-end">-</TableCell>
                </TableRow>
              )}
              <TableRow>
                <TableCell className="tabular-nums">{base}</TableCell>
                <TableCell><Badge variant="info">VERIFY</Badge></TableCell>
                <TableCell className="text-xs"><CopyAddress address={account.address} /></TableCell>
                <TableCell>
                  <Hint text={`${SCOPE_HINT[verify.scope]}; ${SIGNER_HINT[account.signer]}${verify.tamper ? "; tampered signature" : ""}`}>
                    Approval: {SCOPE_WORD[verify.scope].toLowerCase()}{account.signer === "pq" ? ", post-quantum signature" : ""}{verify.tamper ? ", broken signature" : ""}
                  </Hint>
                </TableCell>
                <TableCell className="text-end">-</TableCell>
              </TableRow>
              {payer && (
                <TableRow>
                  <TableCell className="tabular-nums">{base + 1}</TableCell>
                  <TableCell><Badge variant="success">VERIFY</Badge></TableCell>
                  <TableCell className="text-xs"><CopyAddress address={payer.address} /></TableCell>
                  <TableCell>
                    <Hint text="Paymaster.pay(), allowed scope 0x1: APPROVE(0x1) with no check">Gas payment by the paymaster</Hint>
                  </TableCell>
                  <TableCell className="text-end">-</TableCell>
                </TableRow>
              )}
              {frames.map((f, i) => {
                // An atomic group: frame i with the flag joins frame i + 1. Its rows get one
                // box: a left rule, a tint, and no divider between members.
                const joinedToPrev = i > 0 && frames[i - 1]!.atomic;
                const inGroup = f.atomic || joinedToPrev;
                const groupStart = inGroup && !joinedToPrev;
                const groupClass = inGroup ? `bg-warning/5 border-s-2 border-s-warning ${f.atomic ? "border-b-0" : ""} ${groupStart ? "" : "border-t-0"}` : "";
                return (
                <TableRow key={f.id} className={groupClass}>
                  <TableCell className="tabular-nums">{i + offset}</TableCell>
                  <TableCell><Badge variant="warning">SENDER</Badge></TableCell>
                  <TableCell className="text-xs"><CopyAddress address={f.kind === "transfer" ? f.target : account.address} /></TableCell>
                  <TableCell>
                    <Hint text={`${frameHint(f)}${inGroup ? ", ATOMIC_BATCH_FLAG group: all revert if one fails" : ""}`}>
                      {frameLabel(f)}
                    </Hint>
                    {groupStart && <Badge variant="warning" size="sm" className="ms-2">all or nothing</Badge>}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{f.kind === "transfer" ? `${f.eth} ETH` : f.kind === "execute" ? `${f.calls.reduce((n, c) => n + c.eth, 0)} ETH` : "-"}</TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardPanel>
      </Card>

      <Alert variant={exp.tone}>
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{exp.text}</AlertDescription>
      </Alert>

      {signer === "other" && (
        <Alert variant="warning">
          <AlertTitle>This account belongs to {account.signer === "pq" ? "post-quantum key" : ""} {short(account.owner)}</AlertTitle>
          <AlertDescription>{account.signer === "pq" ? "That key is not in this browser, so nothing here can sign for it. Pick another account." : "Connect that wallet to sign for it, or pick another account."}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardFooter className="justify-between">
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          {signer === "other" && account.signer === "wallet" ? (
            <Button size="lg" variant="outline" onClick={onConnect}>
              <Wallet /> Connect wallet
            </Button>
          ) : (
            <Button size="lg" onClick={onSend} loading={sending} disabled={signer === "other"}>
              {signer === "pq" ? "Sign with the post-quantum key and send" : "Sign and send"}
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
