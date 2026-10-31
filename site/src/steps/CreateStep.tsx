import { useState, type ReactNode } from "react";
import { ArrowRightLeft, KeyRound, Route } from "lucide-react";
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
import { api, MODES, MODE_WORD, ROUTE_WORD, SIGNER_HINT, type Account, type ModeName } from "@/lib/api";
import { createPqKey, type PqKey } from "@/lib/pq";

const STEPS = ["Owner", "Calls", "Permissions", "Review"] as const;

interface Props {
  /** Post-quantum keys kept in this browser. */
  keys: PqKey[];
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
export function CreateStep({ keys, onDeployed, onCancel }: Props) {
  const [step, setStep] = useState(0);
  const [keyRoot, setKeyRoot] = useState<string | null>(null);
  const key = keys.find((k) => k.pkRoot === keyRoot) ?? keys[0] ?? null;
  const [route, setRoute] = useState<"0" | "1">("0");
  const [scopes, setScopes] = useState<string[]>(["1", "2"]);
  const [modes, setModes] = useState<string[]>([...MODES]);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const owner = key?.pkRoot ?? null;
  const ready = [owner !== null, true, scopes.length > 0 && modes.length > 0, true];

  const deploy = async () => {
    setDeploying(true);
    setError(null);
    try {
      const body = { route: Number(route), scopes: scopes.reduce((n, s) => n | Number(s), 0), modes };
      onDeployed(await api<Account>("/api/pg/deploy", { ...body, pkSeed: key?.pkSeed, pkRoot: key?.pkRoot }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeploying(false);
    }
  };

  const title = ["Who signs for it", "How calls run", "What it may do", "Check and create"][step];
  const description = [
    "A SPHINCS key made in this browser. Every transaction the account sends carries its signature, and no quantum computer can forge it.",
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
              <p className="text-sm text-muted-foreground">
                <Hint text={`${SIGNER_HINT}. No elliptic curve anywhere, so breaking it means breaking keccak256.`}>Hash-based, checked by the account itself in its VERIFY frame.</Hint>{" "}
                The key never leaves this browser and never pays gas.
              </p>
              {keys.length === 0 ? (
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
                Post-quantum key {owner && <CopyAddress address={owner} />}
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
