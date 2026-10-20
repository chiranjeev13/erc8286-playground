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
import { ethStr, settingsFrames, FAUCET, MODES, ROUTE_HINT, ROUTE_WORD, type Account, type FrameSpec, type ModeName, type Paymaster } from "@/lib/api";

interface Props {
  /** The selected account, whose on-chain settings can be changed here. */
  account: Account | null;
  /** Frames that change the account's settings; the caller sends them. */
  onSettings: (frames: FrameSpec[]) => void;
  paymaster: Paymaster | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The settings button in the header, opening a side panel with the account's settings and the paymasters. */
export function SettingsSheet({ account, onSettings, paymaster, open, onOpenChange: setOpen }: Props) {
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="Settings" />}>
        <Settings />
      </SheetTrigger>
      <SheetPopup side="right" className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>The selected account, and the paymaster.</SheetDescription>
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
          <Paymasters paymaster={paymaster} />
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

function Paymasters({ paymaster }: { paymaster: Paymaster | null }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="font-medium">Paymaster</h3>
        <p className="text-sm text-muted-foreground">
          <Hint text="One common Paymaster. Its pay frame approves payment for whatever reaches it: no signature, no policy. Funded by people at the faucet.">
            Shared by everyone; pays for anything.
          </Hint>
        </p>
      </div>
      {paymaster ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
            <CopyAddress address={paymaster.address} />
            <span className="tabular-nums">{ethStr(paymaster.balance)} ETH</span>
          </div>
          {paymaster.low && (
            <p className="text-sm text-warning-foreground">
              Running low. Copy its address and top it up at the{" "}
              <a className="underline underline-offset-4" href={FAUCET} target="_blank" rel="noreferrer">
                faucet
              </a>
              .
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Being set up...</p>
      )}
    </section>
  );
}
