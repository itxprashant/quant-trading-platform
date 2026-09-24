"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
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

function InstrumentRow({
  instrument,
  prices,
  portfolio,
  selected,
  onSelect,
}: {
  instrument: MarketInstrument;
  prices: Map<string, PricePoint>;
  portfolio: Portfolio | null;
  selected: boolean;
  onSelect: (row: MarketInstrument, price?: number) => void;
}) {
  const live = prices.get(instrument.symbol)?.price;
  const price = live ?? instrument.initialPrice;
  const change =
    instrument.initialPrice > 0
      ? (price - instrument.initialPrice) / instrument.initialPrice
      : 0;
  const held =
    portfolio?.positions.find((p) => p.symbol === instrument.symbol)
      ?.quantity ?? 0;
  const title =
    instrument.kind === "option" && instrument.strike != null
      ? `${instrument.name ?? instrument.symbol} ${instrument.strike}`
      : (instrument.name ?? "");
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${instrument.symbol}, ${title}, ${money(price)}${held ? `, holding ${held}` : ""}`}
        onClick={() => onSelect(instrument, price)}
        className={cn(
          "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
          selected ? "bg-accent-subtle" : "hover:bg-surface-2",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <KindChip kind={instrument.kind} optionType={instrument.optionType} />
          <span
            className={cn(
              "truncate text-xs font-semibold",
              selected && "text-accent",
            )}
          >
            {instrument.kind === "option" && instrument.strike != null
              ? `${instrument.name ?? instrument.symbol} ${instrument.strike}`
              : instrument.symbol}
          </span>
        </span>
        <span className="mono text-right text-sm">{money(price)}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-faint">
          <span className="truncate">
            {instrument.kind === "option"
              ? instrument.optionType === "put"
                ? "Put"
                : "Call"
              : (instrument.name ?? instrument.kind)}
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
}

/** Instrument watchlist: spots and ETFs inline; options open in a side sheet. */
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
  const listed = instruments.filter((s) => s.kind !== "option");
  const options = instruments.filter((s) => s.kind === "option");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [sheetPos, setSheetPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const optionsRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const optionSelected = options.some((s) => s.symbol === active);

  useLayoutEffect(() => {
    if (!optionsOpen) {
      setSheetPos(null);
      return;
    }
    const place = () => {
      const anchor = optionsRef.current?.querySelector("button");
      const rect = anchor?.getBoundingClientRect();
      if (!rect) return;
      const width = 280;
      const height = Math.min(400, options.length * 58 + 44);
      const left = Math.min(
        rect.right + 8,
        Math.max(8, window.innerWidth - width - 8),
      );
      const top = Math.min(
        rect.top,
        Math.max(8, window.innerHeight - height - 8),
      );
      setSheetPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [optionsOpen, options.length]);

  useEffect(() => {
    if (!optionsOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (optionsRef.current?.contains(t) || sheetRef.current?.contains(t))
        return;
      setOptionsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOptionsOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [optionsOpen]);

  return (
    <Panel className={cn("relative flex min-w-0 flex-col overflow-visible", className)}>
      <PanelHeader title="Markets" className="min-h-9 px-3 py-1.5">
        <span className="text-[11px] text-muted">
          {listed.length} instruments
        </span>
      </PanelHeader>
      {listed.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-faint">
          No instruments are listed yet.
        </p>
      ) : (
        <ul
          aria-label="Select trading instrument"
          className="min-h-0 flex-1 divide-y divide-border overflow-y-auto"
        >
          {listed.map((s) => (
            <InstrumentRow
              key={`${s.kind}:${s.symbol}`}
              instrument={s}
              prices={prices}
              portfolio={portfolio}
              selected={active === s.symbol}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
      {options.length > 0 ? (
        <div ref={optionsRef} className="relative shrink-0 border-t border-border">
          <button
            type="button"
            aria-expanded={optionsOpen}
            aria-controls="market-options-sheet"
            onClick={() => setOptionsOpen((v) => !v)}
            className={cn(
              "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
              optionsOpen || optionSelected
                ? "bg-accent-subtle text-accent"
                : "text-muted hover:bg-surface-2 hover:text-text",
            )}
          >
            <span>Options</span>
            <span className="flex items-center gap-1 text-[11px] text-faint">
              {options.length}
              <ChevronRight className="size-3.5" aria-hidden />
            </span>
          </button>
          {optionsOpen && sheetPos
            ? createPortal(
                <div
                  ref={sheetRef}
                  id="market-options-sheet"
                  role="dialog"
                  aria-label="Option contracts"
                  className="fixed z-50 w-[min(280px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-surface shadow-md"
                  style={{ top: sheetPos.top, left: sheetPos.left }}
                >
                  <PanelHeader title="Options" className="min-h-9 px-3 py-1.5">
                    <span className="text-[11px] text-muted">
                      {options.length}
                    </span>
                  </PanelHeader>
                  <ul className="max-h-72 divide-y divide-border overflow-y-auto">
                    {options.map((s) => (
                      <InstrumentRow
                        key={`${s.kind}:${s.symbol}`}
                        instrument={s}
                        prices={prices}
                        portfolio={portfolio}
                        selected={active === s.symbol}
                        onSelect={(row, price) => {
                          onSelect(row, price);
                          setOptionsOpen(false);
                        }}
                      />
                    ))}
                  </ul>
                </div>,
                document.body,
              )
            : null}
        </div>
      ) : null}
    </Panel>
  );
}
