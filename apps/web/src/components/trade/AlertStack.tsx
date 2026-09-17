"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Info, X } from "lucide-react";
import type { AlertMsg } from "@/hooks/useRealtime";
import { cn } from "@/lib/cn";

/**
 * Floating toast stack for targeted trader alerts (margin warnings, forced
 * liquidations, deal pushes). Auto-dismisses non-urgent alerts.
 */
export function AlertStack({ alerts }: { alerts: AlertMsg[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // Auto-expire info/warning toasts after a few seconds.
  useEffect(() => {
    const timers = alerts
      .filter((a) => a.level !== "urgent" && !dismissed.has(a.id))
      .map((a) =>
        setTimeout(() => {
          setDismissed((d) => new Set(d).add(a.id));
        }, 6000),
      );
    return () => timers.forEach(clearTimeout);
  }, [alerts, dismissed]);

  const visible = alerts.filter((a) => !dismissed.has(a.id)).slice(0, 4);
  if (visible.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      {visible.map((a) => (
        <div
          key={a.id}
          role="status"
          className={cn(
            "pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm shadow-lg backdrop-blur-xl",
            a.level === "urgent"
              ? "border-down/40 bg-down-subtle text-down"
              : a.level === "warning"
                ? "border-warning/40 bg-surface-2 text-warning"
                : "border-border bg-surface-2 text-text",
          )}
        >
          {a.level === "info" ? (
            <Info className="mt-0.5 size-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          )}
          <p className="flex-1 leading-snug">{a.message}</p>
          <button
            onClick={() => setDismissed((d) => new Set(d).add(a.id))}
            className="shrink-0 text-faint hover:text-text"
            aria-label="Dismiss"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
