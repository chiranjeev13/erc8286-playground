import { useMemo } from "react";

/** A slow rain of the pixel wizard behind the page. Transform and opacity only; stilled
 * under reduced motion. Positions are fixed per page load so the drops never jump. */
export function Rain({ count = 18 }: { count?: number }) {
  const drops = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        size: 20 + Math.random() * 28,
        duration: 14 + Math.random() * 16,
        delay: -Math.random() * 30,
        sway: (Math.random() - 0.5) * 60,
        spin: (Math.random() - 0.5) * 40,
      })),
    [count],
  );
  return (
    <div className="rain" aria-hidden="true">
      {drops.map((d) => (
        <img
          key={d.id}
          src="/wizard.png"
          alt=""
          className="rain-drop"
          style={{
            left: `${d.left}%`,
            width: d.size,
            height: d.size,
            animationDuration: `${d.duration}s`,
            animationDelay: `${d.delay}s`,
            ["--sway" as string]: `${d.sway}px`,
            ["--spin" as string]: `${d.spin}deg`,
          }}
        />
      ))}
    </div>
  );
}
