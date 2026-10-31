import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Hint } from "@/components/Hint";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toastManager } from "@/components/ui/toast";

/** One contiguous part of a signature, for the byte map. */
interface Segment {
  name: string;
  bytes: number;
  color: string;
  hint: string;
}

const N = 16;
/** sphincs-g: R, then 19 FORS trees (secret + 9-node auth path), then 5 hypertree layers
 * (35 WOTS chains + 4-node auth path). 16 + 19*160 + 5*624 = 6176. */
const PQ_SEGMENTS: Segment[] = [
  { name: "R", bytes: N, color: "bg-foreground", hint: "Randomizer, 16 bytes: keccak(skPrf || message). Everything after is derived from H_msg(R, pk, message)." },
  ...Array.from({ length: 19 }, (_, i) => ({
    name: `FORS ${i + 1}`,
    bytes: N * (1 + 9),
    color: i % 2 ? "bg-info" : "bg-info/60",
    hint: `FORS tree ${i + 1} of 19: one revealed secret (16 bytes) and a 9-node authentication path (144 bytes). Each tree signs 9 bits of the digest.`,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    name: `Layer ${i + 1}`,
    bytes: N * (35 + 4),
    color: i % 2 ? "bg-warning" : "bg-warning/60",
    hint: `Hypertree layer ${i + 1} of 5: a WOTS+ signature of the layer below (35 chains, 560 bytes) and a 4-node authentication path (64 bytes). Layer 5 reaches pkRoot.`,
  })),
];
const ECDSA_SEGMENTS: Segment[] = [
  { name: "r", bytes: 32, color: "bg-info", hint: "x-coordinate of the nonce point, 32 bytes" },
  { name: "s", bytes: 32, color: "bg-warning", hint: "proof scalar, 32 bytes" },
  { name: "v", bytes: 1, color: "bg-foreground", hint: "recovery id, 1 byte" },
];
const PQ_BYTES = 6176;
const ECDSA_BYTES = 65;

export interface SignatureInfo {
  hex: string;
  /** Milliseconds spent signing in this browser. */
  ms?: number;
}

/** A signature's structure, as a bar of bytes to scale. The hex is behind a toggle. */
export function SignatureView({ sig }: { sig: SignatureInfo }) {
  const [copied, setCopied] = useState(false);
  const bytes = (sig.hex.length - 2) / 2;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sig.hex);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toastManager.add({ type: "error", title: "Could not copy" });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>The post-quantum signature</CardTitle>
        <CardDescription>
          <Hint text="sphincs-g, hash-based. The validator recomputes the FORS roots and walks the hypertree back up to pkRoot: about 389k gas of keccak256.">
            {bytes.toLocaleString("en-US")} bytes, {Math.round(PQ_BYTES / ECDSA_BYTES)} times an ECDSA signature. It is nothing but hashes and the preimages that open them.
          </Hint>
          {sig.ms !== undefined && <> Signed in this browser in {Math.round(sig.ms).toLocaleString("en-US")} ms.</>}
        </CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <ByteBar segments={PQ_SEGMENTS} total={PQ_BYTES} label="This signature" />
          <ByteBar segments={ECDSA_SEGMENTS} total={PQ_BYTES} label="An ECDSA signature, to the same scale" />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {[PQ_SEGMENTS[0]!, PQ_SEGMENTS[1]!, PQ_SEGMENTS[20]!].map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              <span className={`inline-block size-2.5 rounded-sm ${s.color}`} />
              <Hint text={s.hint}>
                {s.name.startsWith("FORS") ? "19 FORS trees, 160 bytes each" : s.name.startsWith("Layer") ? "5 hypertree layers, 624 bytes each" : `${s.name}, ${s.bytes} byte${s.bytes > 1 ? "s" : ""}`}
              </Hint>
            </span>
          ))}
        </div>
        <Collapsible>
          <div className="flex items-center gap-2">
            <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>Show the bytes</CollapsibleTrigger>
            <Button variant="ghost" size="sm" onClick={() => void copy()}>
              {copied ? <Check className="text-success" /> : <Copy />} Copy
            </Button>
          </div>
          <CollapsiblePanel>
            <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap">{sig.hex}</pre>
          </CollapsiblePanel>
        </Collapsible>
      </CardPanel>
    </Card>
  );
}

function ByteBar({ segments, total, label }: { segments: Segment[]; total: number; label: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex h-5 w-full overflow-hidden rounded-sm bg-muted">
        {segments.map((s, i) => (
          <span key={i} className={`h-full ${s.color} border-e border-background last:border-e-0`} style={{ width: `${(s.bytes / total) * 100}%`, minWidth: s.bytes >= 16 ? 2 : 1 }} title={`${s.name}: ${s.bytes} bytes`} />
        ))}
      </div>
    </div>
  );
}
