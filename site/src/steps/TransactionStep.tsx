import { Plus, X } from "lucide-react";
import { Hint } from "@/components/Hint";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberField, NumberFieldDecrement, NumberFieldGroup, NumberFieldIncrement, NumberFieldInput } from "@/components/ui/number-field";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ethStr, execute, frameHint, frameLabel, transfer, isAddress, short, BEEF, DEAD, QUICK_TARGETS, SCOPE_HINT, SCOPE_WORD, type Account, type FrameSpec, type Paymaster, type Scope, type Target, type VerifySpec } from "@/lib/api";

interface Props {
  account: Account;
  verify: VerifySpec;
  frames: FrameSpec[];
  presetId: string | null;
  paymasters: Paymaster[];
  payer: Paymaster | null;
  onPayer: (address: string | null) => void;
  onChange: (verify: VerifySpec, frames: FrameSpec[], presetId: string | null) => void;
  onBack: () => void;
  onNext: () => void;
}

export function TransactionStep({ account, verify, frames, paymasters, payer, onPayer, onChange, onBack, onNext }: Props) {
  const setVerify = (v: Partial<VerifySpec>) => onChange({ ...verify, ...v }, frames, null);
  const setFrames = (f: FrameSpec[]) => onChange(verify, f, null);
  const patch = (id: number, p: Partial<FrameSpec>) => setFrames(frames.map((f) => (f.id === id ? { ...f, ...p } : f)));
  const targetsValid = frames.every((f) => (f.kind === "transfer" ? isAddress(f.target) : f.kind === "execute" ? f.calls.every((c) => isAddress(c.target)) : true));
  const canSelfPay = (account.scopes & 1) !== 0;
  /** Frame numbering: a deploy frame first if the account does not exist yet, then VERIFY, then the pay frame. */
  const base = account.deployed ? 0 : 1;
  const frameIndex = (i: number) => i + base + (payer ? 2 : 1);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Who pays the gas</CardTitle>
          {!canSelfPay && <CardDescription>This account cannot pay gas, so a paymaster has to.</CardDescription>}
        </CardHeader>
        <CardPanel>
          <RadioGroup value={payer?.address ?? "self"} onValueChange={(v) => onPayer(v === "self" ? null : String(v))} className="gap-3">
            <Label className="flex items-start gap-3 font-normal">
              <Radio value="self" disabled={!canSelfPay} />
              <span>
                <span className="block font-medium">The account itself</span>
                <span className="block text-sm text-muted-foreground">{account.signer === "pq" ? "One post-quantum signature." : "One wallet signature."}</span>
              </span>
            </Label>
            {paymasters.map((p) => (
              <Label key={p.address} className="flex items-start gap-3 font-normal">
                <Radio value={p.address} />
                <span>
                  <span className="block font-medium">
                    Paymaster <span className="font-mono text-sm">{short(p.address)}</span>
                  </span>
                  <span className="block text-sm text-muted-foreground">{ethStr(p.balance)} ETH. Pays for anything.</span>
                </span>
              </Label>
            ))}
          </RadioGroup>
          {paymasters.length === 0 && !canSelfPay && <p className="mt-3 text-sm text-warning-foreground">Create a paymaster in the Account step first.</p>}
        </CardPanel>
      </Card>

      {!account.deployed && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">Frame 0: DEFAULT</Badge>
              <CardTitle>
                <Hint text="DEFAULT frame, caller ENTRY_POINT: factory.createAccount(implementation, config, salt). The clone's code carries its configuration, so this writes no storage.">Create the account</Hint>
              </CardTitle>
            </div>
            <CardDescription>The account does not exist yet; this frame creates it.</CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Badge variant="info">Frame {base}: VERIFY</Badge>
            <CardTitle>
              <Hint text="account.verify(signature): the account picks its validator, masks the result with the frame's allowed scope, then calls APPROVE">Approval</Hint>
            </CardTitle>
          </div>
          <CardDescription>{account.signer === "pq" ? "Checks your post-quantum signature and approves." : "Checks your wallet's signature and approves."}</CardDescription>
        </CardHeader>
        <CardPanel className="flex flex-wrap items-end gap-8">
          <Field>
            <FieldLabel>What this approval covers</FieldLabel>
            <ToggleGroup value={[String(verify.scope)]} onValueChange={(v) => v[0] && setVerify({ scope: Number(v[0]) as Scope })}>
              {([1, 2, 3] as Scope[]).map((s) => (
                <ToggleGroupItem key={s} value={String(s)}>
                  <Hint text={SCOPE_HINT[s]}>{SCOPE_WORD[s]}</Hint>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

          </Field>
          <Label className="flex items-center gap-3 pb-6 font-normal">
            <Switch checked={verify.tamper} onCheckedChange={(c) => setVerify({ tamper: c })} />
            <Hint text={account.signer === "pq" ? "Flips a byte of the SPHINCS signature's R, so the hypertree no longer reaches pkRoot" : "Flips a byte of the signature so ecrecover yields a different address"}>Break the signature, to see a refusal</Hint>
          </Label>
        </CardPanel>
      </Card>

      {payer && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Badge variant="success">Frame {base + 1}: VERIFY</Badge>
              <CardTitle>
                <Hint text="Paymaster.pay(), allowed scope 0x1: APPROVE(0x1), no policy">Gas payment</Hint>
              </CardTitle>
            </div>
            <CardDescription>Pays, no questions asked.</CardDescription>
          </CardHeader>
        </Card>
      )}

      {frames.map((f, i) => (
        <Card key={f.id}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Badge variant="warning">Frame {frameIndex(i)}: SENDER</Badge>
              <CardTitle>
                <Hint text={frameHint(f)}>{f.kind === "transfer" ? "Transfer" : f.kind === "execute" ? "Calls through the account" : "Change a setting"}</Hint>
              </CardTitle>
              <Button variant="ghost" size="icon" className="ms-auto" aria-label="Remove" onClick={() => setFrames(frames.filter((x) => x.id !== f.id))}>
                <X />
              </Button>
            </div>
            {f.kind !== "transfer" && f.kind !== "execute" && <CardDescription>{frameLabel(f)}</CardDescription>}
          </CardHeader>
          <CardPanel className="flex flex-col gap-4">
            {f.kind === "transfer" ? (
              <CallRow target={f.target} eth={f.eth} onTarget={(t) => patch(f.id, { target: t })} onEth={(e) => patch(f.id, { eth: e })} />
            ) : f.kind === "execute" ? (
              <div className="flex flex-col gap-3">
                {f.calls.map((c, k) => (
                  <CallRow
                    key={k}
                    label={`Call ${k + 1}`}
                    target={c.target}
                    eth={c.eth}
                    onTarget={(t) => patch(f.id, { calls: f.calls.map((x, j) => (j === k ? { ...x, target: t } : x)) })}
                    onEth={(e) => patch(f.id, { calls: f.calls.map((x, j) => (j === k ? { ...x, eth: e } : x)) })}
                    onRemove={f.calls.length > 1 ? () => patch(f.id, { calls: f.calls.filter((_, j) => j !== k) }) : undefined}
                  />
                ))}
                {f.calls.length < 3 && (
                  <Button variant="outline" size="sm" className="self-start" onClick={() => patch(f.id, { calls: [...f.calls, { target: BEEF, eth: 0.001 }] })}>
                    <Plus /> Add call
                  </Button>
                )}
              </div>
            ) : null}
            <Separator />
            <Label className="flex items-center gap-3 font-normal">
              <Switch checked={f.atomic} onCheckedChange={(c) => patch(f.id, { atomic: c })} disabled={i === frames.length - 1 && !f.atomic} />
              <Hint text="Sets the ATOMIC_BATCH_FLAG (flags bit 2), joining this frame to the next">All or nothing with the next frame</Hint>
              {i === frames.length - 1 && <span className="text-xs text-muted-foreground">(last frame: nothing to join)</span>}
            </Label>
          </CardPanel>
        </Card>
      ))}

      <Card>
        <CardPanel className="flex flex-wrap items-center gap-3">
          {account.route === 1 ? (
            <Button variant="outline" disabled={frames.length >= 4} onClick={() => setFrames([...frames, execute([{ target: DEAD, eth: 0.001 }])])}>
              <Plus /> Calls through the account
            </Button>
          ) : (
            <Button variant="outline" disabled={frames.length >= 4} onClick={() => setFrames([...frames, transfer(DEAD)])}>
              <Plus /> Transfer
            </Button>
          )}
          <span className="text-sm text-muted-foreground">
            <Hint text={account.route === 1 ? "executionRoute() = 0x01: every SENDER frame must target the account and call execute(), or verify() clears the execution bit" : "executionRoute() = 0x00: SENDER frames call their targets directly, no account code runs"}>
              {account.route === 1 ? "Each frame targets the account." : "Each frame targets its recipient."}
            </Hint>
          </span>
        </CardPanel>
        <CardFooter className="justify-between">
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button onClick={onNext} disabled={frames.length === 0 || !targetsValid}>
            Next: review
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

function CallRow({ label, target, eth, onTarget, onEth, onRemove }: { label?: string; target: Target; eth: number; onTarget: (t: Target) => void; onEth: (e: number) => void; onRemove?: () => void }) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      {label && <span className="pb-2 text-sm text-muted-foreground">{label}</span>}
      <Field className="min-w-72 flex-1">
        <FieldLabel>To</FieldLabel>
        <Input value={target} onChange={(e) => onTarget(e.target.value.trim())} placeholder="0x..." spellCheck={false} className="font-mono" aria-invalid={!isAddress(target)} />
        <div className="flex flex-wrap items-center gap-1">
          {QUICK_TARGETS.map((q) => (
            <Button key={q.address} variant="ghost" size="xs" onClick={() => onTarget(q.address)}>
              {q.label}
            </Button>
          ))}
          {!isAddress(target) && <span className="text-xs text-destructive-foreground">Needs a full address.</span>}
        </div>
      </Field>
      <Field>
        <FieldLabel>Amount (ETH)</FieldLabel>
        <NumberField value={eth} onValueChange={(v) => onEth(Math.max(0, v ?? 0))} min={0} step={0.001} format={{ maximumFractionDigits: 6 }}>
          <NumberFieldGroup>
            <NumberFieldDecrement />
            <NumberFieldInput className="w-28" />
            <NumberFieldIncrement />
          </NumberFieldGroup>
        </NumberField>
      </Field>
      {onRemove && (
        <Button variant="ghost" size="icon" aria-label="Remove call" onClick={onRemove}>
          <X />
        </Button>
      )}
    </div>
  );
}
