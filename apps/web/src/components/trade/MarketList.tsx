"use client";

import type { Portfolio, PricePoint } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { money, signed, dirClass } from "@/lib/format";
import { cn } from "@/lib/cn";

export type MarketKind = "spot" | "etf" | "option";

/** One selectable row in the workbench watchlist. */
export interface MarketInstrument {
  kind: MarketKind;
  symbol: string;
  name?: string;
  initialPrice: number;
  optionType?: "call" | "put";
  strike?: number;
}

function KindChip({ kind, optionType }: { kind: MarketKind; optionType?: "call" | "put" }) {
  if (kind === "spot") return null;
  if (kind === "option") {
    return (
      <span
        className={cn(
          "rounded-sm px-1 text-[10px] font-semibold uppercase",
          optionType === "put" ? "bg-down-subtle text-down" : "bg-up-subtle text-up",
        )}
      >
        {optionType === "put" ? "P" : "C"}
      </span>
    );
  }
  return (
    <span className="rounded-sm bg-surface-3 px-1 text-[10px] font-semibold uppercase text-faint">
      ETF
    </span>
  );
}

/** Instrument watchlist: the selected row drives book, ticket, options, and ETFs. */
export function MarketList({
  instruments,
  prices,
  portfolio,
  active,
  onSelect,
  className,
}: {
  instruments: MarketInstrument[];
  prices: Map<string, PricePoint>;
  portfolio: Portfolio | null;
  active: string;
  onSelect: (row: MarketInstrument, price?: number) => void;
  className?: string;
}) {
  return (
    <Panel className={cn("flex min-w-0 flex-col overflow-hidden", className)}>
      <PanelHeader title="Markets" className="min-h-9 px-3 py-1.5">
        <span className="text-[11px] text-muted">
          {instruments.length} instruments
        </span>
      </PanelHeader>
      {instruments.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-faint">
          No instruments are listed yet.
        </p>
      ) : (
        <ul
          aria-label="Select trading instrument"
          className="min-h-0 flex-1 divide-y divide-border overflow-y-auto"
        >
          {instruments.map((s) => {
            const live = prices.get(s.symbol)?.price;
            const price = live ?? s.initialPrice;
            const change =
              s.initialPrice > 0 ? (price - s.initialPrice) / s.initialPrice : 0;
            const held =
              portfolio?.positions.find((p) => p.symbol === s.symbol)
                ?.quantity ?? 0;
            const selected = active === s.symbol;
            const title =
              s.kind === "option" && s.strike != null
                ? `${s.name ?? s.symbol} ${s.strike}`
                : (s.name ?? "");
            return (
              <li key={`${s.kind}:${s.symbol}`}>
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-label={`${s.symbol}, ${title}, ${money(price)}${held ? `, holding ${held}` : ""}`}
                  onClick={() => onSelect(s, price)}
                  className={cn(
                    "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
                    selected
                      ? "bg-accent-subtle"
                      : "hover:bg-surface-2",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <KindChip kind={s.kind} optionType={s.optionType} />
                    <span
                      className={cn(
                        "truncate text-xs font-semibold",
                        selected && "text-accent",
                      )}
                    >
                      {s.kind === "option" && s.strike != null
                        ? `${s.name ?? s.symbol} ${s.strike}`
                        : s.symbol}
                    </span>
                  </span>
                  <span className="mono text-right text-sm">{money(price)}</span>
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-faint">
                    <span className="truncate">
                      {s.kind === "option"
                        ? (s.optionType === "put" ? "Put" : "Call")
                        : (s.name ?? s.kind)}
                    </span>
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
