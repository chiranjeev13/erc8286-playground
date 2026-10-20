/** Two hues taken from the address, so each account keeps the same colors everywhere. */
function accountHues(address: string): [number, number] {
  const h = parseInt(address.slice(2, 8), 16) || 0;
  return [h % 360, (h >> 9) % 360];
}

/** A round gradient standing in for an account. */
export function AccountAvatar({ address, className = "size-9" }: { address: string; className?: string }) {
  const [a, b] = accountHues(address);
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-full ring-1 ring-black/5 dark:ring-white/10 ${className}`}
      style={{ background: `linear-gradient(135deg, hsl(${a} 75% 60%), hsl(${b} 70% 45%))` }}
    />
  );
}
