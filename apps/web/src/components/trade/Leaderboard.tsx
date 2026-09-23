"use client";

import type { LeaderboardEntry } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { money, signed, dirClass } from "@/lib/format";
import { cn } from "@/lib/cn";

/**
 * Rank cell. Top three get a quiet monochrome "podium" chip (weight + surface
 * lift, no medals, no color) so the leader reads as a moment without breaking
 * the restrained palette. Everyone else is a plain faint number.
 */
function Rank({ rank }: { rank: number }) {
  const podium = rank <= 3;
  return (
    <span
      aria-label={`Rank ${rank}`}
      className={cn(
        "mono inline-flex h-5 w-6 items-center justify-center justify-self-center rounded-sm tabular-nums",
        rank === 1 && "bg-surface-3 font-semibold text-text",
        rank === 2 && "bg-surface-2 font-medium text-text",
        rank === 3 && "bg-surface-2 text-muted",
        !podium && "text-faint",
      )}
    >
      {rank}
    </span>
  );
}

function Row({
  e,
  highlight,
  cols,
  metric,
  mm,
}: {
  e: LeaderboardEntry;
  highlight?: boolean;
  cols: string;
  metric: "score" | "pnl";
  mm: boolean;
}) {
  return (
    <div
      className={cn(
        "grid items-center gap-3 px-3 py-1.5 text-xs",
        cols,
        highlight ? "bg-accent-subtle" : "hover:bg-surface-2",
      )}
    >
      <Rank rank={e.rank} />
      <span
        className={cn("truncate", highlight ? "font-semibold text-accent" : "")}
      >
        {e.displayName}
        {highlight && <span className="ml-1 text-faint">(you)</span>}
      </span>
      {mm && (
        <span className="mono text-right text-up" title="Spread capture">
          {money(e.metrics?.spreadCapture ?? 0)}
        </span>
      )}
      <span
        className={cn(
          "mono text-right",
          dirClass(metric === "pnl" ? e.pnl : e.score),
        )}
      >
        {signed(metric === "pnl" ? e.pnl : e.score)}
      </span>
    </div>
  );
}

export function Leaderboard({
  entries,
  meId,
  metric = "score",
  mm = false,
  compact = false,
  hidden = false,
  isAdmin = false,
  className,
}: {
  entries: LeaderboardEntry[];
  meId?: string;
  metric?: "score" | "pnl";
  mm?: boolean;
  /** Sidebar variant: top 10, no spread column, no minimum width. */
  compact?: boolean;
  /** Host has withheld rankings from traders. */
  hidden?: boolean;
  isAdmin?: boolean;
  className?: string;
}) {
  if (hidden && !isAdmin) {
    return (
      <Panel className={cn("min-w-0 overflow-hidden", className)}>
        <PanelHeader title="Leaderboard" />
        <p className="px-3 py-6 text-center text-xs text-faint">
          Rankings are hidden by the host.
        </p>
      </Panel>
    );
  }
  const showSpread = mm && !compact;
  const limit = compact ? 10 : 12;
  const me = entries.find((e) => e.userId === meId);
  const top = entries.slice(0, limit);
  const cols = compact
    ? "grid-cols-[24px_minmax(0,1fr)_minmax(72px,auto)]"
    : showSpread
      ? "grid-cols-[24px_minmax(80px,1fr)_96px_96px]"
      : "grid-cols-[24px_minmax(80px,1fr)_104px]";
  const minWidth = compact
    ? ""
    : showSpread
      ? "min-w-[360px]"
      : "min-w-[280px]";

  return (
    <Panel
      className={cn("flex h-full min-w-0 flex-col overflow-hidden", className)}
    >
      <PanelHeader title="Leaderboard">
        {hidden ? (
          <span className="rounded-sm border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
            Hidden from traders
          </span>
        ) : (
          <span className="text-[11px] text-muted">
            {entries.length} traders
          </span>
        )}
      </PanelHeader>
      <div
        tabIndex={0}
        role="region"
        aria-label="Trader rankings"
        className={cn(
          "flex-1 overflow-auto focus-visible:outline-offset-[-2px]",
          !compact && "max-h-[320px]",
        )}
      >
        <div className={minWidth}>
          <div
            className={cn(
              "sticky top-0 z-10 grid gap-3 bg-surface-2 px-3 py-2 text-[10px] uppercase tracking-wide text-muted",
              cols,
            )}
          >
            <span className="w-6 text-center">#</span>
            <span>Trader</span>
            {showSpread && <span className="text-right">Spread</span>}
            <span className="text-right">
              {metric === "pnl" ? "PnL" : "Score"}
            </span>
          </div>
          {top.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-faint">
              Rankings appear once scoring begins.
            </div>
          ) : (
            top.map((e) => (
              <Row
                key={e.userId}
                e={e}
                highlight={e.userId === meId}
                cols={cols}
                metric={metric}
                mm={showSpread}
              />
            ))
          )}
        </div>
      </div>
      {me && me.rank > limit && (
        <div
          tabIndex={0}
          role="region"
          aria-label="Your ranking"
          className="overflow-x-auto border-t border-border focus-visible:outline-offset-[-2px]"
        >
          <div className={minWidth}>
            <Row e={me} highlight cols={cols} metric={metric} mm={showSpread} />
          </div>
        </div>
      )}
    </Panel>
  );
}
