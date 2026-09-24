"use client";

import { useEffect, useMemo, useState } from "react";
import { Newspaper } from "lucide-react";
import type { NewsItem, NewsLevel } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { cn } from "@/lib/cn";

type Filter = "all" | "news" | "announcement";

/** How long a live headline keeps its arrival tint. */
const FRESH_MS = 15_000;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "news", label: "Market" },
  { id: "announcement", label: "Announcements" },
];

function feedOf(item: NewsItem): Exclude<Filter, "all"> {
  return item.feed === "news" ? "news" : "announcement";
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function levelBorder(level: NewsLevel): string {
  switch (level) {
    case "urgent":
      return "border-l-down";
    case "warning":
      return "border-l-warning";
    default:
      return "border-l-accent";
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

/** Seconds until an embargoed headline goes public, or null once it has. */
export function earlyLeadSec(item: NewsItem, now: number): number | null {
  if (!item.embargoUntil) return null;
  const ms = new Date(item.embargoUntil).getTime() - now;
  return ms > 0 ? Math.ceil(ms / 1000) : null;
}

function Meta({
  item,
  now,
  premium,
}: {
  item: NewsItem;
  now: number;
  premium: boolean;
}) {
  const lead = premium ? earlyLeadSec(item, now) : null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint">
      <span className="rounded-sm border border-border px-1 py-px text-[10px] uppercase tracking-wide text-muted">
        {feedOf(item) === "news" ? "Market" : "Announcement"}
      </span>
      <span className="mono tabular-nums">{formatTime(item.createdAt)}</span>
      {lead != null && (
        <span className="rounded-sm bg-accent-subtle px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-accent">
          Early · public in {lead}s
        </span>
      )}
      {item.authorDisplayName && (
        <span className="min-w-0 truncate">{item.authorDisplayName}</span>
      )}
    </div>
  );
}

/**
 * Combined host announcements and market wire. The newest headline in the
 * active filter is set as a lead card; live arrivals keep a tint briefly.
 */
export function NewsFeed({
  items,
  receivedAt,
  premium = false,
  className,
}: {
  items: NewsItem[];
  /** Wall time each headline arrived over the live feed. */
  receivedAt: Record<string, number>;
  /** Trader won the latest auction: market headlines arrive early. */
  premium?: boolean;
  className?: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const counts = useMemo(() => {
    let news = 0;
    for (const item of items) if (feedOf(item) === "news") news += 1;
    return { all: items.length, news, announcement: items.length - news };
  }, [items]);
  const visible =
    filter === "all" ? items : items.filter((i) => feedOf(i) === filter);
  const [lead, ...rest] = visible;
  const isFresh = (item: NewsItem) => {
    const at = receivedAt[item.id];
    return at != null && now - at < FRESH_MS;
  };

  return (
    <Panel
      className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden", className)}
    >
      <PanelHeader
        title={
          <span className="flex items-center gap-1.5">
            <Newspaper className="size-3.5 text-faint" aria-hidden />
            News
          </span>
        }
        className="min-h-9 px-3 py-1.5"
      >
        {premium && (
          <span
            className="rounded-sm border border-accent/40 bg-accent-subtle px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent"
            title="Premium feed: market headlines arrive early"
          >
            Premium
          </span>
        )}
      </PanelHeader>
      <div
        role="group"
        aria-label="Filter news"
        className="flex gap-1 border-b border-border px-2 py-1.5"
      >
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "flex items-center gap-1 rounded-sm px-2 py-1 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-accent",
              filter === f.id
                ? "bg-surface-3 text-text"
                : "text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            {f.label}
            <span className="mono text-[10px] text-faint">{counts[f.id]}</span>
          </button>
        ))}
      </div>
      {!lead ? (
        <p className="px-4 py-8 text-center text-xs text-faint">
          {filter === "announcement"
            ? "No announcements yet."
            : filter === "news"
              ? "No market headlines yet."
              : "No news yet. Host announcements and market headlines appear here."}
        </p>
      ) : (
        <div
          role="region"
          tabIndex={0}
          aria-label="News feed"
          className="min-h-0 flex-1 overflow-y-auto focus-visible:outline-offset-[-2px]"
        >
          <article
            className={cn(
              "border-b border-l-[3px] border-b-border px-3 py-3 transition-colors duration-[1500ms]",
              levelBorder(lead.level),
              isFresh(lead) ? "bg-accent-subtle" : "bg-surface-2",
            )}
          >
            <p className="break-words text-[15px] font-medium leading-snug text-text">
              {lead.message}
            </p>
            <Meta item={lead} now={now} premium={premium} />
          </article>
          <ul className="divide-y divide-border">
            {rest.map((item) => (
              <li
                key={item.id}
                className={cn(
                  "flex items-start gap-2.5 px-3 py-2.5 transition-colors duration-[1500ms]",
                  isFresh(item) && "bg-accent-subtle",
                )}
              >
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
                  <Meta item={item} now={now} premium={premium} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
