"use client";

import { useEffect, useState } from "react";

function parts(ms: number) {
  const clamp = Math.max(0, ms);
  const s = Math.floor(clamp / 1000) % 60;
  const m = Math.floor(clamp / 60000) % 60;
  const h = Math.floor(clamp / 3600000) % 24;
  const d = Math.floor(clamp / 86400000);
  return { d, h, m, s };
}

const pad = (n: number) => n.toString().padStart(2, "0");

export function Countdown({ target, label = "Ends in" }: { target: string | null; label?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!target) return null;
  const ms = new Date(target).getTime() - now;
  const { d, h, m, s } = parts(ms);

  const Unit = ({ v, u }: { v: number; u: string }) => (
    <div className="flex flex-col items-center">
      <span className="mono text-sm font-semibold leading-none">{pad(v)}</span>
      <span className="text-[10px] uppercase tracking-wide text-faint">{u}</span>
    </div>
  );

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-faint">{label}</span>
      <div className="flex items-center gap-1.5">
        {d > 0 && (
          <>
            <Unit v={d} u="days" />
            <span className="text-faint">:</span>
          </>
        )}
        <Unit v={h} u="hrs" />
        <span className="text-faint">:</span>
        <Unit v={m} u="min" />
        <span className="text-faint">:</span>
        <Unit v={s} u="sec" />
      </div>
    </div>
  );
}
