"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Info, Newspaper, X } from "lucide-react";
import type { NewsItem } from "@qtp/shared";
import type { AlertMsg } from "@/hooks/useRealtime";
import { cn } from "@/lib/cn";

/** A headline that arrived live, captured with its premium lead at receipt. */
export interface NewsToast {
  item: NewsItem;
  early: boolean;
  receivedAt: number;
}

type Entry =
  | { key: string; ts: number; kind: "alert"; alert: AlertMsg }
  | { key: string; ts: number; kind: "news"; toast: NewsToast };

const MAX_VISIBLE = 4;

function lifetimeMs(entry: Entry): number | null {
  if (entry.kind === "alert")
    return entry.alert.level === "urgent" ? null : 6000;
  return entry.toast.item.level === "urgent" ? 15_000 : 8000;
}

/**
 * Floating toast stack for targeted trader alerts (margin warnings, forced
 * liquidations, deal pushes) and live headlines. Urgent alerts stay until
 * dismissed; everything else expires on its own.
 */
export function AlertStack({
  alerts,
  news = [],
}: {
  alerts: AlertMsg[];
  news?: NewsToast[];
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const dismiss = (key: string) =>
    setDismissed((d) => new Set(d).add(key));

  const entries: Entry[] = [
    ...alerts.map(
      (alert): Entry => ({
        key: `alert:${alert.id}`,
        ts: alert.ts,
        kind: "alert",
        alert,
      }),
    ),
    ...news.map(
      (toast): Entry => ({
        key: `news:${toast.item.id}`,
        ts: toast.receivedAt,
        kind: "news",
        toast,
      }),
    ),
  ]
    .filter((e) => !dismissed.has(e.key))
    .sort((a, b) => b.ts - a.ts);
  const visible = entries.slice(0, MAX_VISIBLE);
  const visibleKey = visible.map((e) => e.key).join("|");

  useEffect(() => {
    const timers = visible.flatMap((e) => {
      const life = lifetimeMs(e);
      if (life == null) return [];
      const remaining =
        e.kind === "news"
          ? Math.max(0, e.toast.receivedAt + life - Date.now())
          : life;
      return [setTimeout(() => dismiss(e.key), remaining)];
    });
    return () => timers.forEach(clearTimeout);
  }, [visibleKey]);

  if (visible.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      {visible.map((e) =>
        e.kind === "alert" ? (
          <div
            key={e.key}
            role="status"
            className={cn(
              "pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-surface px-3 py-2.5 text-sm shadow-sm",
              e.alert.level === "urgent"
                ? "border-down/40 text-down"
                : e.alert.level === "warning"
                  ? "border-warning/40 text-warning"
                  : "border-border text-text",
            )}
          >
            {e.alert.level === "info" ? (
              <Info className="mt-0.5 size-4 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            )}
            <p className="min-w-0 flex-1 break-words leading-snug">
              {e.alert.message}
            </p>
            <button
              onClick={() => dismiss(e.key)}
              className="shrink-0 text-faint hover:text-text"
              aria-label="Dismiss"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : (
          <NewsToastCard
            key={e.key}
            toast={e.toast}
            onDismiss={() => dismiss(e.key)}
          />
        ),
      )}
    </div>
  );
}

function NewsToastCard({
  toast,
  onDismiss,
}: {
  toast: NewsToast;
  onDismiss: () => void;
}) {
  const { item, early } = toast;
  return (
    <div
      role="status"
      className={cn(
        "pointer-events-auto flex items-start gap-2.5 rounded-lg border border-l-[3px] border-border bg-surface-2 px-3 py-2.5 shadow-sm",
        item.level === "urgent"
          ? "border-l-down"
          : item.level === "warning"
            ? "border-l-warning"
            : "border-l-accent",
      )}
    >
      <Newspaper className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted">
          {item.feed === "news" ? "Market news" : "Announcement"}
          {early && (
            <span className="rounded-sm bg-accent-subtle px-1 py-px font-semibold text-accent">
              Early
            </span>
          )}
        </div>
        <p className="mt-0.5 break-words text-sm font-medium leading-snug text-text">
          {item.message}
        </p>
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 text-faint hover:text-text"
        aria-label="Dismiss headline"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
