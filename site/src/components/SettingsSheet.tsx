import { useEffect, useState } from "react";
import { Settings } from "lucide-react";
import { CopyAddress } from "@/components/CopyAddress";
import { Hint } from "@/components/Hint";
import { PermissionBoxes, ShapeBoxes } from "@/components/PolicyBoxes";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ethStr, settingsFrames, MODES, ROUTE_HINT, ROUTE_WORD, type Account, type FrameSpec, type ModeName, type Paymaster } from "@/lib/api";

interface Props {
  /** The selected account, whose on-chain settings can be changed here. */
  account: Account | null;
  /** Frames that change the account's settings; the caller sends them. */
  onSettings: (frames: FrameSpec[]) => void;
  paymasters: Paymaster[];
  onPaymasterDeployed: (p: Paymaster) => void;
}

/** The settings button in the header, opening a side panel with the account's settings and the paymasters. */
export function SettingsSheet({ account, onSettings, paymasters, onPaymasterDeployed }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="Settings" />}>
        <Settings />
      </SheetTrigger>
      <SheetPopup side="right" className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>The selected account, and the paymasters.</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-8">
          {account ? (
            <AccountSettings
              key={account.address}
              account={account}
              onSettings={(f) => {
                setOpen(false);
                onSettings(f);
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Select an account to change its settings.</p>
          )}
          <Separator />
          <Paymasters paymasters={paymasters} onDeployed={onPaymasterDeployed} />
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}

/** Edits the account's on-chain settings. Applying builds the frames that change them. */
function AccountSettings({ account, onSettings }: { account: Account; onSettings: (frames: FrameSpec[]) => void }) {
  const [scopes, setScopes] = useState<string[]>([]);
  const [modes, setModes] = useState<string[]>([]);
  useEffect(() => {
    setScopes([account.scopes & 1 ? "1" : "", account.scopes & 2 ? "2" : ""].filter(Boolean));
    setModes(MODES.filter((m) => account.modes[m]));
  }, [account]);

  const wantScopes = scopes.reduce((n, s) => n | Number(s), 0);
  const wantModes = Object.fromEntries(MODES.map((m) => [m, modes.includes(m)])) as Record<ModeName, boolean>;
  const frames = settingsFrames(account, wantScopes, wantModes);
  const dropsExecution = (wantScopes & 2) === 0 && (account.scopes & 2) !== 0;
  const canReach = (account.scopes & 2) !== 0;

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h3 className="flex items-center gap-2 font-medium">Account <CopyAddress address={account.address} /></h3>
        <p className="text-sm text-muted-foreground">
          <Hint text="Setters are onlySelf: a SENDER frame from the account calls setApprovalScopes / setExecutionMode. Apply builds that transaction; you review and sign it like any other.">
            Changes are a transaction the account sends to itself.
          </Hint>
        </p>
      </div>
      <Field>
        <FieldLabel>How calls run</FieldLabel>
        <Hint text={ROUTE_HINT(account.route)} className="self-start">
          <Badge variant="secondary">{ROUTE_WORD(account.route)}</Badge>
        </Hint>
        <FieldDescription>Fixed at creation.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>What the account may approve</FieldLabel>
        <PermissionBoxes value={scopes} onChange={setScopes} />
        {dropsExecution && <FieldDescription className="text-warning-foreground">Cannot be undone: without executing, the account can never change its settings again.</FieldDescription>}
      </Field>
      <Field>
        <FieldLabel>Transaction shapes it allows</FieldLabel>
        <ShapeBoxes value={modes} onChange={setModes} />
      </Field>
      {!canReach && (
        <Alert variant="warning">
          <AlertTitle>This account cannot change its settings</AlertTitle>
          <AlertDescription>It is not allowed to execute calls, so it can never reach its own settings.</AlertDescription>
        </Alert>
      )}
      {!account.deployed && frames.length > 0 && <p className="text-sm text-muted-foreground">The account is created by the same transaction.</p>}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{frames.length === 0 ? "No changes." : `${frames.length} change${frames.length > 1 ? "s" : ""}.`}</span>
        <Button onClick={() => onSettings(frames)} disabled={frames.length === 0 || wantScopes === 0 || !canReach}>
          Apply changes
        </Button>
      </div>
    </section>
  );
}

function Paymasters({ paymasters, onDeployed }: { paymasters: Paymaster[]; onDeployed: (p: Paymaster) => void }) {
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deploy = async () => {
    setDeploying(true);
    setError(null);
    try {
      onDeployed(await api<Paymaster>("/api/pg/deploy-paymaster", {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeploying(false);
    }
  };
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="font-medium">Paymasters</h3>
        <p className="text-sm text-muted-foreground">
          <Hint text="Paymaster: pays for any transaction whose pay frame reaches it, no signature, no policy. Starts with 0.05 test ETH. Shared by everyone here.">
            Pay gas for anyone.
          </Hint>
        </p>
      </div>
      {paymasters.length === 0 ? (
        <p className="text-sm text-muted-foreground">None yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Paymaster</TableHead>
              <TableHead className="text-end">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paymasters.map((p) => (
              <TableRow key={p.address}>
                <TableCell className="text-xs"><CopyAddress address={p.address} /></TableCell>
                <TableCell className="text-end tabular-nums">{ethStr(p.balance)} ETH</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {error && (
        <Alert variant="error">
          <AlertTitle>Could not create the paymaster</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button variant="outline" className="self-start" onClick={() => void deploy()} loading={deploying}>
        {deploying ? "Creating..." : "Create a paymaster"}
      </Button>
    </section>
  );
}
