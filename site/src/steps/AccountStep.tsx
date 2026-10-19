import { useState } from "react";
import { Eye, EyeOff, KeyRound, Trash2, Wallet } from "lucide-react";
import { CopyAddress } from "@/components/CopyAddress";
import { Hint } from "@/components/Hint";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { PermissionBoxes, ShapeBoxes } from "@/components/PolicyBoxes";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ethStr, short, FAUCET, MODES, SIGNER_HINT, type Account, type Signer } from "@/lib/api";
import { createPqKey, forgetPqKey, type PqKey } from "@/lib/pq";
import { hasWallet } from "@/lib/wallet";

interface Props {
  accounts: Account[];
  active: string | null;
  wallet: string | null;
  /** Post-quantum keys kept in this browser. */
  keys: PqKey[];
  connecting: boolean;
  onConnect: () => void;
  onSelect: (address: string) => void;
  onDeployed: (a: Account) => void;
  onNext: () => void;
}

export function AccountStep({ accounts, active, wallet, keys, connecting, onConnect, onSelect, onDeployed, onNext }: Props) {
  const current = accounts.find((a) => a.address === active) ?? null;
  const [signer, setSigner] = useState<Signer>("wallet");
  const [keyRoot, setKeyRoot] = useState<string | null>(null);
  const key = keys.find((k) => k.pkRoot === keyRoot) ?? keys[0] ?? null;
  const [route, setRoute] = useState<"0" | "1">("0");
  const [scopes, setScopes] = useState<string[]>(["1", "2"]);
  const [modes, setModes] = useState<string[]>([...MODES]);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Secrets shown in clear, by public key. */
  const [revealed, setRevealed] = useState<string[]>([]);

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


  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Create an account</CardTitle>
          <CardDescription>
            <Hint text="The address is CREATE2(factory, salt, clone code || config), known before any code exists. The first transaction's deploy frame calls factory.createAccount; the configuration lives in the clone's code, so creation writes no storage.">
              Created by its first transaction.
            </Hint>{" "}
            Fund it at the faucet, or let the paymaster pay.
          </CardDescription>
        </CardHeader>
        <CardPanel className="flex flex-col gap-6">
          <Field>
            <FieldLabel>
              <Hint text="The frame validator installed at creation; nonce_keys[0] selects it on every transaction">Who signs for it</Hint>
            </FieldLabel>
            <RadioGroup value={signer} onValueChange={(v) => setSigner(v as Signer)} className="gap-3">
              <Label className="flex items-start gap-3 font-normal">
                <Radio value="wallet" />
                <span>
                  <span className="block font-medium"><Hint text={`${SIGNER_HINT.wallet}. The wallet approves transactions and never pays gas.`}>Your wallet</Hint></span>
                </span>
              </Label>
              <Label className="flex items-start gap-3 font-normal">
                <Radio value="pq" />
                <span>
                  <span className="block font-medium"><Hint text={`${SIGNER_HINT.pq}. Made in this browser; no elliptic curve anywhere, so breaking it means breaking keccak256.`}>A post-quantum key</Hint></span>
                </span>
              </Label>
            </RadioGroup>
            {signer === "wallet" ? (
              wallet ? (
                <div className="flex items-center gap-2 text-sm">
                  <Badge variant="info">
                    <Wallet /> <CopyAddress address={wallet} />
                  </Badge>
                </div>
              ) : (
                <Button variant="outline" size="sm" className="self-start" onClick={onConnect} loading={connecting} disabled={!hasWallet()}>
                  <Wallet /> {hasWallet() ? "Connect wallet to own the account" : "No wallet found"}
                </Button>
              )
            ) : keys.length === 0 ? (
              <Button variant="outline" size="sm" className="self-start" onClick={() => setKeyRoot(createPqKey().pkRoot)}>
                <KeyRound /> Generate a post-quantum key
              </Button>
            ) : (
              <RadioGroup value={key?.pkRoot ?? ""} onValueChange={(v) => setKeyRoot(String(v))} className="gap-2">
                {keys.map((k) => (
                  <Label key={k.pkRoot} className="flex items-center gap-3 font-normal">
                    <Radio value={k.pkRoot} />
                    <KeyRound className="size-4 text-muted-foreground" />
                    <span className="text-xs"><CopyAddress address={k.pkRoot} /></span>
                  </Label>
                ))}
              </RadioGroup>
            )}
          </Field>

          <Field>
            <FieldLabel>
              <Hint text="executionRoute(): 0x00 protocol or 0x01 contract">How calls run</Hint>
            </FieldLabel>
            <RadioGroup value={route} onValueChange={(v) => setRoute(v as "0" | "1")} className="gap-3">
              <Label className="flex items-start gap-3 font-normal">
                <Radio value="0" />
                <span>
                  <span className="block font-medium"><Hint text="executionRoute() = 0x00 protocol: each SENDER frame calls its target, no account code runs">Directly</Hint></span>
                </span>
              </Label>
              <Label className="flex items-start gap-3 font-normal">
                <Radio value="1" />
                <span>
                  <span className="block font-medium"><Hint text="executionRoute() = 0x01 contract: every SENDER frame calls the account's execute(), which can apply its own rules">Through the account</Hint></span>
                </span>
              </Label>
            </RadioGroup>
          </Field>

          <Field>
            <FieldLabel>What the account may approve</FieldLabel>
            <PermissionBoxes value={scopes} onChange={setScopes} />
          </Field>

          <Field>
            <FieldLabel>Transaction shapes it allows</FieldLabel>
            <ShapeBoxes value={modes} onChange={setModes} />
          </Field>

          {error && (
            <Alert variant="error">
              <AlertTitle>Could not create the account</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardPanel>
        <CardFooter>
          <Button onClick={() => void deploy()} loading={deploying} disabled={scopes.length === 0 || modes.length === 0 || (signer === "wallet" ? !wallet : !key)}>
            {deploying ? "Reserving..." : "Create account"}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your accounts</CardTitle>
          <CardDescription>
            Copy an address and fund it at the{" "}
            <a className="underline underline-offset-4" href={FAUCET} target="_blank" rel="noreferrer">
              faucet
            </a>
            .
          </CardDescription>
        </CardHeader>
        <CardPanel>
          {accounts.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No accounts yet</EmptyTitle>
                <EmptyDescription>Create one on the left.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <RadioGroup value={active ?? ""} onValueChange={(v) => onSelect(String(v))}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Account</TableHead>
                    <TableHead className="text-end">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.map((a) => (
                    <TableRow key={a.address} className={a.stale ? "opacity-60" : "cursor-pointer"} onClick={() => !a.stale && onSelect(a.address)}>
                      <TableCell>
                        <Radio value={a.address} aria-label={`Use ${short(a.address)}`} disabled={a.stale} />
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <CopyAddress address={a.address} />
                          {a.stale && <Badge variant="error" size="sm">outdated</Badge>}
                          {!a.deployed && (
                            <Hint text="No code at this address yet. The first transaction carries a deploy frame that creates it.">
                              <Badge variant="warning" size="sm">not created yet</Badge>
                            </Hint>
                          )}
                          {a.signer === "pq" && (
                            <Hint text={SIGNER_HINT.pq}>
                              <Badge variant="info" size="sm"><KeyRound /> post-quantum</Badge>
                            </Hint>
                          )}
                        </div>
                        <div className="font-mono text-muted-foreground">{a.nonce} sent</div>
                      </TableCell>
                      <TableCell className="text-end tabular-nums">{ethStr(a.balance)} ETH</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </RadioGroup>
          )}
        </CardPanel>
        <CardFooter className="justify-end">
          <Button onClick={onNext} disabled={!current || current.stale}>
            Next: transaction
          </Button>
        </CardFooter>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Post-quantum keys</CardTitle>
          <CardDescription>
            <Hint text="sphincs-g (n=16 h=20 d=5 a=9 k=19 w=16, keccak256), kept in localStorage. No wallet can hold one yet; the account checks the signature itself in its VERIFY frame. Demo storage, test funds only.">
              SPHINCS keys kept in this browser.
            </Hint>{" "}
            Verifier by{" "}
            <a className="inline-flex items-center gap-1 align-middle underline underline-offset-4" href="https://github.com/RivaLabs-Core/Post-Quantum-AA-Infra" target="_blank" rel="noreferrer">
              <img src="/rivalabs.png" alt="" className="size-4 rounded-sm" />
              RivaLabs
            </a>
            .
          </CardDescription>
        </CardHeader>
        <CardPanel>
          {keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Hint text="pkRoot: the root of the top hypertree layer. pkSeed: the public seed every tweakable hash is keyed with. Both 16 bytes, stored on chain in the account.">Public key</Hint>
                  </TableHead>
                  <TableHead>
                    <Hint text="The 32-byte secret in localStorage. skSeed, skPrf and pkSeed derive from it with domain-separated keccak.">Secret key</Hint>
                  </TableHead>
                  <TableHead>Accounts</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => {
                  const owned = accounts.filter((a) => a.owner.toLowerCase() === k.pkRoot.toLowerCase()).length;
                  return (
                    <TableRow key={k.pkRoot}>
                      <TableCell className="text-xs">
                        <div className="flex items-center gap-2"><span className="w-10 text-muted-foreground">root</span><CopyAddress address={k.pkRoot} /></div>
                        <div className="flex items-center gap-2"><span className="w-10 text-muted-foreground">seed</span><CopyAddress address={k.pkSeed} /></div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="flex items-center gap-1">
                          {revealed.includes(k.pkRoot) ? <CopyAddress address={k.secret} /> : <span className="font-mono text-muted-foreground">{"*".repeat(14)}</span>}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={revealed.includes(k.pkRoot) ? "Hide secret" : "Show secret"}
                            onClick={() => setRevealed((xs) => (xs.includes(k.pkRoot) ? xs.filter((x) => x !== k.pkRoot) : [...xs, k.pkRoot]))}
                          >
                            {revealed.includes(k.pkRoot) ? <EyeOff /> : <Eye />}
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell className="tabular-nums">{owned}</TableCell>
                      <TableCell className="text-muted-foreground">{new Date(k.created).toLocaleString("en-US")}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" aria-label="Forget key" title={owned ? "Its accounts can never be used again" : "Forget this key"} onClick={() => forgetPqKey(k.pkRoot)}>
                          <Trash2 />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardPanel>
        <CardFooter>
          <Button variant="outline" onClick={() => setKeyRoot(createPqKey().pkRoot)}>
            <KeyRound /> Generate a key
          </Button>
        </CardFooter>
      </Card>

    </div>
  );
}
