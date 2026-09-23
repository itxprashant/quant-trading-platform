"use client";

import type { Portfolio, PricePoint, SymbolConfig } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { money, signed, dirClass } from "@/lib/format";
import { cn } from "@/lib/cn";

/** Instrument watchlist: selecting a row points the book and ticket at it. */
export function MarketList({
  symbols,
  prices,
  portfolio,
  active,
  onSelect,
  className,
}: {
  symbols: SymbolConfig[];
  prices: Map<string, PricePoint>;
  portfolio: Portfolio | null;
  active: string;
  onSelect: (symbol: string, price: number) => void;
  className?: string;
}) {
  return (
    <Panel className={cn("flex min-w-0 flex-col overflow-hidden", className)}>
      <PanelHeader title="Markets">
        <span className="text-[11px] text-muted">
          {symbols.length} instruments
        </span>
      </PanelHeader>
      {symbols.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-faint">
          No instruments are listed yet.
        </p>
      ) : (
        <ul
          aria-label="Select trading instrument"
          className="min-h-0 flex-1 divide-y divide-border overflow-y-auto"
        >
          {symbols.map((s) => {
            const price = prices.get(s.symbol)?.price ?? s.initialPrice;
            const change =
              s.initialPrice > 0 ? (price - s.initialPrice) / s.initialPrice : 0;
            const held =
              portfolio?.positions.find((p) => p.symbol === s.symbol)
                ?.quantity ?? 0;
            const selected = active === s.symbol;
            return (
              <li key={s.symbol}>
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={`${s.symbol}, ${s.name ?? ""}, ${money(price)}, ${signed(change * 100)} percent since start${held ? `, holding ${held}` : ""}`}
                  onClick={() => onSelect(s.symbol, price)}
                  className={cn(
                    "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-l-2 px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
                    selected
                      ? "border-l-accent bg-accent-subtle"
                      : "border-l-transparent hover:bg-surface-2",
                  )}
                >
                  <span
                    className={cn(
                      "truncate text-xs font-semibold",
                      selected && "text-accent",
                    )}
                  >
                    {s.symbol}
                  </span>
                  <span className="mono text-right text-sm">{money(price)}</span>
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-faint">
                    <span className="truncate">{s.name}</span>
                    {held !== 0 && (
                      <span
                        className={cn(
                          "mono shrink-0 rounded-sm bg-surface-3 px-1",
                          dirClass(held),
                        )}
                      >
                        {held > 0 ? "+" : ""}
                        {held}
                      </span>
                    )}
                  </span>
                  <span className={cn("mono text-right text-[11px]", dirClass(change))}>
                    {signed(change * 100)}%
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
