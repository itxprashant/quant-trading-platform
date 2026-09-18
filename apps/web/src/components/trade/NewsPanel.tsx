"use client";

import { Newspaper } from "lucide-react";
import type { NewsItem, NewsLevel } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { cn } from "@/lib/cn";

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function levelDot(level: NewsLevel): string {
  switch (level) {
    case "urgent":
      return "bg-down";
    case "warning":
      return "bg-warning";
    default:
      return "bg-faint";
  }
}

/**
 * Market news feed — separate from the operational announcements ticker. Shows
 * host-published (and scheduled) market/flavor headlines in a dedicated panel.
 */
export function NewsPanel({ items }: { items: NewsItem[] }) {
  return (
    <Panel className="min-w-0 overflow-hidden">
      <PanelHeader
        title={
          <span className="flex items-center gap-1.5">
            <Newspaper className="size-3.5 text-faint" aria-hidden />
            Market news
          </span>
        }
      />
      {items.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-faint">
          No market news yet.
        </p>
      ) : (
        <ul className="max-h-[320px] divide-y divide-border overflow-y-auto">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-2.5 px-3 py-2.5">
              <span
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  levelDot(item.level),
                )}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm leading-snug text-text">
                  {item.message}
                </p>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-faint">
                  <span className="mono tabular-nums">
                    {formatTime(item.createdAt)}
                  </span>
                  {item.authorDisplayName && (
                    <span className="truncate">— {item.authorDisplayName}</span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
