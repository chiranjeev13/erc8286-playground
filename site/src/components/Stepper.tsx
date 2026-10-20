import { Check } from "lucide-react";

/** Numbered steps joined by a line. A progress indicator only: Next and Back buttons move it. */
export function Stepper({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Progress">
      {steps.map((s, i) => {
        const done = i < current;
        const here = i === current;
        return (
          <li key={s} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none" aria-current={here ? "step" : undefined}>
            <span
              className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs tabular-nums transition-colors ${
                done ? "bg-primary text-primary-foreground" : here ? "bg-primary text-primary-foreground ring-4 ring-primary/15" : "bg-muted text-muted-foreground"
              }`}
            >
              {done ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={`truncate text-sm ${here ? "font-medium" : "text-muted-foreground"} ${here ? "" : "max-sm:hidden"}`}>{s}</span>
            {i < steps.length - 1 && <span className={`h-px min-w-4 flex-1 ${done ? "bg-primary/60" : "bg-border"}`} />}
          </li>
        );
      })}
    </ol>
  );
}
