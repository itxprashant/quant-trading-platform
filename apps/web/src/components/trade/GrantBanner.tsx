"use client";

import { useEffect, useState } from "react";
import { Landmark } from "lucide-react";
import type { GrantMission } from "@qtp/shared";
import { money } from "@/lib/format";
import { cn } from "@/lib/cn";

function secsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

/**
 * Government grant banner (manufactured-bubble mission, comp_desc). The largest
 * holder of the target symbol at the deadline wins the prize — incentivizing a
 * scramble for inventory while it runs.
 */
export function GrantBanner({ grant }: { grant: GrantMission | null }) {
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!grant) return null;
  const open = grant.status === "open" && secsLeft(grant.expiresAt) > 0;
  const left = secsLeft(grant.expiresAt);

  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b px-4 py-2 text-sm",
        open
          ? "border-accent/30 bg-accent-subtle/40 text-text"
          : "border-border bg-surface-2 text-muted",
      )}
    >
      <Landmark className="size-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <span className="font-medium">Government grant</span>{" "}
        <span className="text-muted">{grant.description}</span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="mono text-xs">
          <span className="text-faint">prize </span>
          <span className="text-up">{money(grant.prize)}</span>
        </span>
        <span className="rounded-md bg-surface-3 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
          {grant.symbol}
        </span>
        {open ? (
          <span className={cn("mono text-xs", left <= 10 ? "text-down" : "text-warning")}>
            {left}s
          </span>
        ) : (
          <span className="rounded-md bg-up-subtle px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-up">
            Awarded
          </span>
        )}
      </div>
    </div>
  );
}
