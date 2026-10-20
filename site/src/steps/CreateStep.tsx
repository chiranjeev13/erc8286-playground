import { useState, type ReactNode } from "react";
import { ArrowRightLeft, KeyRound, Route, Wallet } from "lucide-react";
import { CopyAddress } from "@/components/CopyAddress";
import { Hint } from "@/components/Hint";
import { PermissionBoxes, ShapeBoxes } from "@/components/PolicyBoxes";
import { Stepper } from "@/components/Stepper";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { api, MODES, MODE_WORD, ROUTE_WORD, SIGNER_HINT, SIGNER_WORD, type Account, type ModeName, type Signer } from "@/lib/api";
import { createPqKey, type PqKey } from "@/lib/pq";
import { hasWallet } from "@/lib/wallet";

const STEPS = ["Owner", "Calls", "Permissions", "Review"] as const;

interface Props {
  wallet: string | null;
  /** Post-quantum keys kept in this browser. */
  keys: PqKey[];
  connecting: boolean;
  onConnect: () => void;
  onDeployed: (a: Account) => void;
  /** Leave the wizard without creating anything; absent when there is nowhere to go back to. */
  onCancel?: () => void;
}

/** One choice of a radio group, drawn as a card. */
function Option({ value, icon, title, hint, children }: { value: string; icon: ReactNode; title: string; hint: string; children: ReactNode }) {
  return (
    <Label className="flex cursor-pointer items-start gap-3 rounded-xl border p-4 font-normal transition-colors hover:bg-accent/60 has-data-checked:border-primary/50 has-data-checked:bg-accent">
      <Radio value={value} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2 font-medium">
          <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
          <Hint text={hint}>{title}</Hint>
        </span>
        <span className="text-sm text-muted-foreground">{children}</span>
      </span>
    </Label>
  );
}

/** Creating an account, one decision per step. The address is reserved at the end; the
 * account itself is created by its first transaction. */
export function CreateStep({ wallet, keys, connecting, onConnect, onDeployed, onCancel }: Props) {
  const [step, setStep] = useState(0);
  const [signer, setSigner] = useState<Signer>("wallet");
  const [keyRoot, setKeyRoot] = useState<string | null>(null);
  const key = keys.find((k) => k.pkRoot === keyRoot) ?? keys[0] ?? null;
  const [route, setRoute] = useState<"0" | "1">("0");
  const [scopes, setScopes] = useState<string[]>(["1", "2"]);
  const [modes, setModes] = useState<string[]>([...MODES]);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const owner = signer === "wallet" ? wallet : (key?.pkRoot ?? null);
  const ready = [owner !== null, true, scopes.length > 0 && modes.length > 0, true];

  const deploy = async () => {
    setDeploying(true);
    setError(null);
    try {
      const body = { route: Number(route), scopes: scopes.reduce((n, s) => n | Number(s), 0), modes };
      onDeployed(await api<Account>("/api/pg/deploy", signer === "pq" ? { ...body, signer, pkSeed: key?.pkSeed, pkRoot: key?.pkRoot } : { ...body, signer, owner: wallet }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeploying(false);
    }
  };

  const title = ["Who signs for it", "How calls run", "What it may do", "Check and create"][step];
  const description = [
    "Every transaction the account sends carries this owner's signature.",
    "Fixed at creation. Decides whether the account's own code sees every call.",
    "You can change these later, with a transaction the account sends to itself.",
    "The address is reserved now. The account is created by its first transaction.",
  ][step];

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <Stepper steps={STEPS} current={step} />
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardPanel className="flex flex-col gap-6">
          {step === 0 && (
            <>
              <RadioGroup value={signer} onValueChange={(v) => setSigner(v as Signer)} className="grid gap-3 sm:grid-cols-2">
                <Option value="wallet" icon={<Wallet />} title="Your wallet" hint={`${SIGNER_HINT.wallet}. The wallet approves transactions and never pays gas.`}>
                  MetaMask or any browser wallet signs each transaction.
                </Option>
                <Option value="pq" icon={<KeyRound />} title="A post-quantum key" hint={`${SIGNER_HINT.pq}. Made in this browser; no elliptic curve anywhere, so breaking it means breaking keccak256.`}>
                  A SPHINCS key made in this browser. Safe from quantum computers.
                </Option>
              </RadioGroup>
              {signer === "wallet" ? (
                wallet ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    Owner
                    <Badge variant="info">
                      <Wallet /> <CopyAddress address={wallet} />
                    </Badge>
                  </div>
                ) : (
                  <Button variant="outline" className="self-start" onClick={onConnect} loading={connecting} disabled={!hasWallet()}>
                    <Wallet /> {hasWallet() ? "Connect wallet to own the account" : "No wallet found"}
                  </Button>
                )
              ) : keys.length === 0 ? (
                <Button variant="outline" className="self-start" onClick={() => setKeyRoot(createPqKey().pkRoot)}>
                  <KeyRound /> Generate a post-quantum key
                </Button>
              ) : (
                <Field>
                  <FieldLabel>Key</FieldLabel>
                  <RadioGroup value={key?.pkRoot ?? ""} onValueChange={(v) => setKeyRoot(String(v))} className="gap-2">
                    {keys.map((k) => (
                      <Label key={k.pkRoot} className="flex items-center gap-3 font-normal">
                        <Radio value={k.pkRoot} />
                        <KeyRound className="size-4 text-muted-foreground" />
                        <span className="text-xs"><CopyAddress address={k.pkRoot} /></span>
                      </Label>
                    ))}
                  </RadioGroup>
                  <Button variant="ghost" size="sm" className="self-start" onClick={() => setKeyRoot(createPqKey().pkRoot)}>
                    <KeyRound /> Generate another
                  </Button>
                </Field>
              )}
            </>
          )}

          {step === 1 && (
            <RadioGroup value={route} onValueChange={(v) => setRoute(v as "0" | "1")} className="grid gap-3 sm:grid-cols-2">
              <Option value="0" icon={<ArrowRightLeft />} title="Directly" hint="executionRoute() = 0x00 protocol: each SENDER frame calls its target, no account code runs">
                Each call goes straight to its target. Cheapest.
              </Option>
              <Option value="1" icon={<Route />} title="Through the account" hint="executionRoute() = 0x01 contract: every SENDER frame calls the account's execute(), which can apply its own rules">
                Every call passes through the account's execute(), which can apply its own rules.
              </Option>
            </RadioGroup>
          )}

          {step === 2 && (
            <>
              <Field>
                <FieldLabel>What the account may approve</FieldLabel>
                <PermissionBoxes value={scopes} onChange={setScopes} />
              </Field>
              <Field>
                <FieldLabel>Transaction shapes it allows</FieldLabel>
                <ShapeBoxes value={modes} onChange={setModes} />
              </Field>
              {scopes.length === 0 && <p className="text-sm text-warning-foreground">Pick at least one permission.</p>}
            </>
          )}

          {step === 3 && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
              <dt className="text-muted-foreground">Owner</dt>
              <dd className="flex flex-wrap items-center gap-2">
                {SIGNER_WORD[signer]} {owner && <CopyAddress address={owner} />}
              </dd>
              <dt className="text-muted-foreground">Calls</dt>
              <dd>{ROUTE_WORD(Number(route))}</dd>
              <dt className="text-muted-foreground">May approve</dt>
              <dd className="flex flex-wrap gap-1.5">
                {scopes.includes("1") && <Badge variant="secondary">Pay gas</Badge>}
                {scopes.includes("2") && <Badge variant="secondary">Execute calls</Badge>}
              </dd>
              <dt className="text-muted-foreground">Shapes</dt>
              <dd className="flex flex-wrap gap-1.5">
                {MODES.filter((m) => modes.includes(m)).map((m) => (
                  <Badge key={m} variant="secondary">{MODE_WORD[m as ModeName]}</Badge>
                ))}
              </dd>
            </dl>
          )}

          {error && (
            <Alert variant="error">
              <AlertTitle>Could not create the account</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardPanel>
        <CardFooter className="justify-between">
          {step === 0 ? (
            onCancel ? <Button variant="ghost" onClick={onCancel}>Cancel</Button> : <span />
          ) : (
            <Button variant="ghost" onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
          )}
          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep((s) => s + 1)} disabled={!ready[step]}>
              Next: {STEPS[step + 1]!.toLowerCase()}
            </Button>
          ) : (
            <Button onClick={() => void deploy()} loading={deploying} disabled={!ready.every(Boolean)}>
              {deploying ? "Reserving..." : "Create account"}
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
