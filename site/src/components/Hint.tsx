import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";

/** Plain words on the page; the protocol detail in a tooltip for whoever wants it. */
export function Hint({ text, children, className = "" }: { text: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className={`inline-flex cursor-help items-center gap-1 ${className}`} />}>
        {children}
        <Info className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup className="max-w-xs font-mono text-xs">{text}</TooltipPopup>
    </Tooltip>
  );
}
