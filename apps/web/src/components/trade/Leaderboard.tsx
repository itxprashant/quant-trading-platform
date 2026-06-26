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

export function Leaderboard({
  entries,
  meId,
  metric = "score",
  mm = false,
}: {
  entries: LeaderboardEntry[];
  meId?: string;
  metric?: "score" | "pnl";
  mm?: boolean;
}) {
  const me = entries.find((e) => e.userId === meId);
  const top = entries.slice(0, 12);
  const cols = mm
    ? "grid-cols-[auto_1fr_auto_auto]"
    : "grid-cols-[auto_1fr_auto]";

  const Row = ({ e, highlight }: { e: LeaderboardEntry; highlight?: boolean }) => (
    <div
      className={cn(
        "grid items-center gap-3 px-3 py-1.5 text-xs",
        cols,
        highlight ? "bg-accent-subtle/40" : "hover:bg-surface-2",
      )}
    >
      <Rank rank={e.rank} />
      <span className={cn("truncate", highlight ? "font-semibold text-accent" : "")}>
        {e.displayName}
        {highlight && <span className="ml-1 text-faint">(you)</span>}
      </span>
      {mm && (
        <span className="mono text-right text-up" title="Spread capture">
          {money(e.metrics?.spreadCapture ?? 0)}
        </span>
      )}
      <span className={cn("mono text-right", dirClass(metric === "pnl" ? e.pnl : e.score))}>
        {signed(metric === "pnl" ? e.pnl : e.score)}
      </span>
    </div>
  );

  return (
    <Panel className="flex h-full flex-col">
      <PanelHeader title="Leaderboard" />
      <div className="flex-1 overflow-y-auto">
        <div className={cn("grid gap-3 px-3 py-1.5 text-[10px] uppercase tracking-wide text-faint", cols)}>
          <span className="w-6 text-center">#</span>
          <span>Trader</span>
          {mm && <span className="text-right">Spread</span>}
          <span className="text-right">{metric === "pnl" ? "PnL" : "Score"}</span>
        </div>
        {top.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-faint">
            No rankings yet
          </div>
        ) : (
          top.map((e) => <Row key={e.userId} e={e} highlight={e.userId === meId} />)
        )}
      </div>
      {me && me.rank > 12 && (
        <div className="border-t border-border">
          <Row e={me} highlight />
        </div>
      )}
    </Panel>
  );
}
