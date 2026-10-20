import { useState } from "react";
import { Eye, EyeOff, KeyRound, Trash2 } from "lucide-react";
import { CopyAddress } from "@/components/CopyAddress";
import { Hint } from "@/components/Hint";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Account } from "@/lib/api";
import { createPqKey, forgetPqKey, type PqKey } from "@/lib/pq";

/** The post-quantum keys kept in this browser, with their secrets hidden until asked. */
export function PqKeys({ keys, accounts }: { keys: PqKey[]; accounts: Account[] }) {
  /** Secrets shown in clear, by public key. */
  const [revealed, setRevealed] = useState<string[]>([]);

  return (
    <Card>
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
        <Button variant="outline" onClick={() => createPqKey()}>
          <KeyRound /> Generate a key
        </Button>
      </CardFooter>
    </Card>
  );
}
