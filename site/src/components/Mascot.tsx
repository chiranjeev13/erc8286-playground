import type { Run } from "@/steps/ResultStep";

/** The pixel wizard in the header. Floats while idle, casts while a transaction is in
 * flight, hops once when it mines, slumps when it is refused. CSS in index.css. */
export function Mascot({ run }: { run: Run | null }) {
  const s = run?.status;
  const state = !s ? "idle" : s === "signing" || s === "simulating" || s === "submitted" ? "casting" : s === "mined" ? "hop" : s === "refused" || s === "error" || s === "reverted" ? "slump" : "idle";
  return <img src="/wizard.png" alt="" aria-hidden="true" className="mascot size-9 select-none" data-state={state} key={run?.id ?? 0} />;
}
