"use client";

import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import {
  formatInstrumentLabel,
  type LeaderboardEntry,
} from "@qtp/shared";
import { get, post } from "@/lib/api";
import { money } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";

function Rank({ rank }: { rank: number }) {
  return (
    <span
      aria-label={`Rank ${rank}`}
      className={cn(
        "mono inline-flex h-5 w-6 items-center justify-center rounded-sm tabular-nums",
        rank === 1 && "bg-surface-3 font-semibold text-text",
        rank === 2 && "bg-surface-2 font-medium text-text",
        rank === 3 && "bg-surface-2 text-muted",
        rank > 3 && "text-faint",
      )}
    >
      {rank}
    </span>
  );
}

export function FinalStandingsDialog({
  entries,
  open,
  onClose,
  meId,
}: {
  entries: LeaderboardEntry[];
  open: boolean;
  onClose: () => void;
  meId?: string;
}) {
  const titleId = useId();
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-bg/80 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[min(40rem,90dvh)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold tracking-tight">
              Final standings
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Ending settlement is free cash plus each position marked at the
              book mid.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close final standings"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div
          tabIndex={0}
          role="region"
          aria-label="Final settlement rankings"
          className="min-h-0 flex-1 overflow-auto"
        >
          <div className="sticky top-0 z-10 grid grid-cols-[24px_minmax(80px,1fr)_88px_88px_104px] gap-3 bg-surface-2 px-4 py-2 text-[10px] uppercase tracking-wide text-muted">
            <span className="w-6 text-center">#</span>
            <span>Trader</span>
            <span className="text-right">Cash</span>
            <span className="text-right">Positions</span>
            <span className="text-right">Settlement</span>
          </div>
          {entries.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-faint">
              No traders were enrolled.
            </p>
          ) : (
            entries.map((e) => {
              const settlement = e.settlement ?? e.pnl;
              const cash = e.cash;
              const positionValue =
                e.assets?.reduce((sum, a) => sum + a.value, 0) ??
                (cash != null ? settlement - cash : null);
              const mine = e.userId === meId;
              const expanded = openId === e.userId;
              return (
                <div
                  key={e.userId}
                  className={cn(mine && "bg-accent-subtle")}
                >
                  <button
                    type="button"
                    aria-expanded={expanded}
                    className="grid w-full grid-cols-[24px_minmax(80px,1fr)_88px_88px_104px] items-center gap-3 px-4 py-2 text-left text-xs hover:bg-surface-2"
                    onClick={() =>
                      setOpenId((id) => (id === e.userId ? null : e.userId))
                    }
                  >
                    <Rank rank={e.rank} />
                    <span
                      className={cn("truncate", mine && "font-semibold text-accent")}
                    >
                      {e.displayName}
                      {mine && <span className="ml-1 text-faint">(you)</span>}
                    </span>
                    <span className="mono text-right">
                      {cash != null ? money(cash) : "—"}
                    </span>
                    <span className="mono text-right">
                      {positionValue != null ? money(positionValue) : "—"}
                    </span>
                    <span className="mono text-right font-medium">
                      {money(settlement)}
                    </span>
                  </button>
                  {expanded && (
                    <ul className="space-y-0.5 border-t border-border bg-surface-2/60 px-4 py-2 text-xs text-muted">
                      {cash != null && (
                        <li className="flex justify-between gap-4">
                          <span>Free cash</span>
                          <span className="mono">{money(cash)}</span>
                        </li>
                      )}
                      {(e.assets ?? []).map((asset) => (
                        <li
                          key={asset.symbol}
                          className="flex justify-between gap-4"
                        >
                          <span>
                            {formatInstrumentLabel(asset.symbol)}{" "}
                            <span className="mono text-faint">
                              {asset.quantity} × {money(asset.mid)}
                            </span>
                          </span>
                          <span className="mono">{money(asset.value)}</span>
                        </li>
                      ))}
                      {(!e.assets || e.assets.length === 0) && cash == null && (
                        <li>No settlement breakdown is stored for this row.</li>
                      )}
                    </ul>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/** Host control: reveal rankings to traders and open the final board. */
export function ShowFinalLeaderboard({
  challengeId,
  hidden,
  onRevealed,
  meId,
  label = "Show leaderboard",
}: {
  challengeId: string;
  hidden?: boolean;
  onRevealed?: () => void;
  meId?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);

  async function show() {
    setBusy(true);
    setError(null);
    try {
      if (hidden) {
        await post(`/api/admin/${challengeId}/leaderboard-visibility`, {
          hidden: false,
        });
        onRevealed?.();
      }
      const rows = await get<LeaderboardEntry[]>(
        `/api/leaderboard/${challengeId}`,
      );
      setEntries(rows);
      setOpen(true);
    } catch {
      setError("Could not load the final leaderboard.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={show} loading={busy} size="sm">
        {label}
      </Button>
      {error && (
        <p role="alert" className="text-[11px] text-down">
          {error}
        </p>
      )}
      <FinalStandingsDialog
        entries={entries}
        open={open}
        onClose={() => setOpen(false)}
        meId={meId}
      />
    </div>
  );
}
