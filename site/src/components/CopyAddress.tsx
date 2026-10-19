import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toastManager } from "@/components/ui/toast";
import { short } from "@/lib/api";

/** An address that copies itself to the clipboard when clicked. */
export function CopyAddress({ address, full = false, className = "" }: { address: string; full?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toastManager.add({ type: "error", title: "Could not copy", description: address });
    }
  };
  return (
    <button
      type="button"
      onClick={(e) => void copy(e)}
      title={copied ? "Copied" : `Copy ${address}`}
      className={`inline-flex max-w-full cursor-pointer items-center gap-1 rounded font-mono hover:text-foreground hover:underline underline-offset-4 ${className}`}
    >
      <span className="truncate">{full ? address : short(address)}</span>
      {copied ? <Check className="size-3.5 shrink-0 text-success" /> : <Copy className="size-3.5 shrink-0 opacity-60" />}
    </button>
  );
}
