"use client";

import type { OrderBookSnapshot, PriceLevel } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { money } from "@/lib/format";
import { cn } from "@/lib/cn";

/** Matches engine `snapshot(12)` so the ladder height never collapses. */
const BOOK_DEPTH = 12;

function cumulative(levels: PriceLevel[]): { level: PriceLevel; total: number }[] {
  let running = 0;
  return levels.map((level) => {
    running += level.quantity;
    return { level, total: running };
  });
}

function Side({
  rows,
  side,
  max,
  onPick,
}: {
  rows: { level: PriceLevel; total: number }[];
  side: "bid" | "ask";
  max: number;
  onPick?: (price: number) => void;
}) {
  const isBid = side === "bid";
  const slots = Array.from({ length: BOOK_DEPTH }, (_, i) => rows[i] ?? null);

  return (
    <div className="flex-1">
      <div className="grid grid-cols-2 px-2 pb-1 text-[10px] uppercase tracking-wide text-faint">
        {isBid ? (
          <>
            <span>Price</span>
            <span className="text-right">Size</span>
          </>
        ) : (
          <>
            <span>Size</span>
            <span className="text-right">Price</span>
          </>
        )}
      </div>
      <div>
        {slots.map((row, i) => {
          const level = row?.level;
          const total = row?.total ?? 0;
          return (
            <button
              key={`${side}-${i}`}
              type="button"
              disabled={!level}
              onClick={() => level && onPick?.(level.price)}
              className={cn(
                "relative grid w-full grid-cols-2 px-2 py-[3px] text-xs",
                level ? "hover:bg-surface-2" : "cursor-default",
              )}
            >
              {level && (
                <span
                  className={cn(
                    "absolute inset-y-0",
                    isBid ? "right-0 bg-up-subtle" : "left-0 bg-down-subtle",
                  )}
                  style={{ width: `${(total / max) * 100}%`, opacity: 0.5 }}
                  aria-hidden
                />
              )}
              {isBid ? (
                <>
                  <span className={cn("relative z-10 mono", level ? "text-up" : "text-faint/40")}>
                    {level ? money(level.price) : "—"}
                  </span>
                  <span className={cn("relative z-10 mono text-right", level ? "text-muted" : "text-faint/40")}>
                    {level ? level.quantity : "—"}
                  </span>
                </>
              ) : (
                <>
                  <span className={cn("relative z-10 mono", level ? "text-muted" : "text-faint/40")}>
                    {level ? level.quantity : "—"}
                  </span>
                  <span className={cn("relative z-10 mono text-right", level ? "text-down" : "text-faint/40")}>
                    {level ? money(level.price) : "—"}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function OrderBook({
  snapshot,
  onPick,
}: {
  snapshot?: OrderBookSnapshot;
  onPick?: (price: number) => void;
}) {
  const bids = cumulative(snapshot?.bids ?? []);
  const asks = cumulative(snapshot?.asks ?? []);
  const max = Math.max(
    1,
    bids.at(-1)?.total ?? 0,
    asks.at(-1)?.total ?? 0,
  );
  const bestBid = snapshot?.bids[0]?.price;
  const bestAsk = snapshot?.asks[0]?.price;
  const spread =
    bestBid != null && bestAsk != null ? bestAsk - bestBid : null;

  return (
    <Panel className="flex h-full flex-col">
      <PanelHeader title="Order Book">
        {spread != null && (
          <span className="text-xs text-faint">
            Spread <span className="mono text-muted">{money(spread)}</span>
          </span>
        )}
      </PanelHeader>
      <div className="flex flex-1 gap-px overflow-y-auto py-2">
        <Side rows={bids} side="bid" max={max} onPick={onPick} />
        <div className="w-px bg-border" />
        <Side rows={asks} side="ask" max={max} onPick={onPick} />
      </div>
    </Panel>
  );
}
