"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Megaphone } from "lucide-react";
import type { NewsItem, NewsLevel } from "@qtp/shared";
import { cn } from "@/lib/cn";

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function levelStyles(level: NewsLevel): string {
  switch (level) {
    case "urgent":
      return "border-down/40 bg-down-subtle/40 text-down";
    case "warning":
      return "border-warning/30 bg-accent-subtle/50 text-warning";
    default:
      return "border-border bg-surface-2 text-muted";
  }
}

function NewsRow({ item, prominent }: { item: NewsItem; prominent?: boolean }) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-md border px-2.5 py-1.5",
        levelStyles(item.level),
        prominent ? "text-sm" : "text-xs",
      )}
    >
      <span className="mono shrink-0 tabular-nums opacity-80">
        {formatTime(item.createdAt)}
      </span>
      <span className="min-w-0 flex-1 leading-snug">{item.message}</span>
      {item.authorDisplayName && (
        <span className="shrink-0 text-faint">— {item.authorDisplayName}</span>
      )}
    </div>
  );
}

export function NewsTicker({ items }: { items: NewsItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(mq.matches);
    const onChange = () => setReduceMotion(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  if (items.length === 0) return null;

  const latest = items[0]!;
  const history = items.slice(1, expanded ? 20 : 0);

  return (
    <div className="border-b border-border bg-surface px-3 py-2">
      <div className="mx-auto flex max-w-[1600px] items-start gap-2">
        <Megaphone className="mt-1 size-3.5 shrink-0 text-faint" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1.5">
          <NewsRow item={latest} prominent />
          {history.map((item) => (
            <NewsRow key={item.id} item={item} />
          ))}
        </div>
        {items.length > 1 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text"
            aria-expanded={expanded}
          >
            {expanded ? (
              <>
                Collapse <ChevronUp className="size-3.5" />
              </>
            ) : (
              <>
                {items.length - 1} more{" "}
                {!reduceMotion && <ChevronDown className="size-3.5" />}
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
