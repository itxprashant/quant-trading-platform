"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  LineSeries,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";
import type { ChartPriceSeries, OrderBookSnapshot, PricePoint } from "@qtp/shared";
import { midFromBook } from "@qtp/shared";
import { get } from "@/lib/api";
import { cn } from "@/lib/cn";

// Concrete colors mirroring the design tokens (lightweight-charts cannot parse css vars / rgba tokens).
const CHART = {
  muted: "#a1a1aa", // --color-muted (zinc-400)
  grid: "rgba(255, 255, 255, 0.06)", // --color-surface-2
  border: "rgba(255, 255, 255, 0.12)", // --color-border
  up: "#34d399", // --color-up (emerald-400)
  down: "#f87171", // --color-down (red-400)
  line: "#22d3ee", // --color-accent (cyan-400)
} as const;

/** Bucket width for OHLC candles (engine ticks ~1s apart). */
const CANDLE_SEC = 5;

/** Gaps longer than this start a new session (e.g. challenge paused overnight). */
const SESSION_GAP_MS = 5 * 60 * 1000;

/** Default number of bars visible on load; avoids fitContent squashing. */
const VISIBLE_BARS = 120;

type ChartMode = "candle" | "line";
type Ohlc = CandlestickData<UTCTimestamp>;

/** Keep only the latest contiguous run so stale Redis history does not stretch the axis. */
function latestSession(points: PricePoint[]): PricePoint[] {
  if (points.length <= 1) return points;

  let start = 0;
  for (let i = 1; i < points.length; i++) {
    const cur = points[i];
    const prev = points[i - 1];
    if (cur && prev && cur.timestamp - prev.timestamp > SESSION_GAP_MS) {
      start = i;
    }
  }
  return points.slice(start);
}

function focusRecentBars(chart: IChartApi, barCount: number) {
  if (barCount <= 0) return;
  const visible = Math.min(VISIBLE_BARS, barCount);
  chart.timeScale().setVisibleLogicalRange({
    from: barCount - visible,
    to: barCount - 1,
  });
}

function ticksToCandles(points: PricePoint[], intervalSec: number): Ohlc[] {
  const buckets = new Map<number, Ohlc>();

  for (const p of points) {
    const bucket =
      Math.floor(p.timestamp / 1000 / intervalSec) * intervalSec;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, {
        time: bucket as UTCTimestamp,
        open: p.price,
        high: p.price,
        low: p.price,
        close: p.price,
      });
    } else {
      existing.high = Math.max(existing.high, p.price);
      existing.low = Math.min(existing.low, p.price);
      existing.close = p.price;
    }
  }

  return [...buckets.values()].sort((a, b) => (a.time as number) - (b.time as number));
}

function ticksToLine(points: PricePoint[]): LineData<UTCTimestamp>[] {
  const bySec = new Map<number, number>();
  for (const p of points) {
    bySec.set(Math.floor(p.timestamp / 1000), p.price);
  }
  return [...bySec.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

export function PriceChart({
  challengeId,
  symbol,
  lastPrice,
  book,
}: {
  challengeId: string;
  symbol: string;
  /** Last trade / mark price from the engine. */
  lastPrice?: PricePoint;
  /** Order book for live mid-price updates. */
  book?: OrderBookSnapshot;
}) {
  const [mode, setMode] = useState<ChartMode>("candle");
  const [priceSeries, setPriceSeries] = useState<ChartPriceSeries>("mid");
  const [hasData, setHasData] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<
    ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null
  >(null);
  const historyRef = useRef<PricePoint[]>([]);
  const currentCandleRef = useRef<Ohlc | null>(null);
  const modeRef = useRef<ChartMode>("candle");
  const priceSeriesRef = useRef<ChartPriceSeries>("mid");

  modeRef.current = mode;
  priceSeriesRef.current = priceSeries;

  const live = useMemo((): PricePoint | undefined => {
    if (priceSeries === "last") return lastPrice;
    const mid = book ? midFromBook(book.bids, book.asks) : null;
    if (mid == null) return lastPrice;
    return {
      symbol,
      price: mid,
      change: lastPrice?.change ?? 0,
      timestamp: lastPrice?.timestamp ?? Date.now(),
    };
  }, [priceSeries, lastPrice, book, symbol]);

  const applyHistory = useCallback((points: PricePoint[], chartMode: ChartMode) => {
    const session = latestSession(points);
    historyRef.current = session;
    if (session.length > 0) setHasData(true);
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;

    if (chartMode === "candle") {
      const candles = ticksToCandles(session, CANDLE_SEC);
      (series as ISeriesApi<"Candlestick">).setData(candles);
      const last = candles.at(-1);
      currentCandleRef.current = last ? { ...last } : null;
      focusRecentBars(chart, candles.length);
    } else {
      const line = ticksToLine(session);
      (series as ISeriesApi<"Line">).setData(line);
      currentCandleRef.current = null;
      focusRecentBars(chart, line.length);
    }
  }, []);

  const mountSeries = useCallback(
    (chart: IChartApi, chartMode: ChartMode) => {
      if (seriesRef.current) {
        chart.removeSeries(seriesRef.current);
        seriesRef.current = null;
      }

      if (chartMode === "candle") {
        seriesRef.current = chart.addSeries(CandlestickSeries, {
          upColor: CHART.up,
          downColor: CHART.down,
          borderVisible: false,
          wickUpColor: CHART.up,
          wickDownColor: CHART.down,
          priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        });
      } else {
        seriesRef.current = chart.addSeries(LineSeries, {
          color: CHART.line,
          lineWidth: 2,
          crosshairMarkerVisible: true,
          priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        });
      }

      if (historyRef.current.length > 0) {
        applyHistory(historyRef.current, chartMode);
      }
    },
    [applyHistory],
  );

  // Create chart once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { color: "transparent" },
        textColor: CHART.muted,
        fontFamily: "var(--font-geist-mono), monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: CHART.grid },
        horzLines: { color: CHART.grid },
      },
      rightPriceScale: { borderColor: CHART.border },
      timeScale: {
        borderColor: CHART.border,
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 8,
        barSpacing: 8,
        minBarSpacing: 4,
      },
      crosshair: { mode: 0 },
      width: el.clientWidth,
      height: el.clientHeight,
    });

    chartRef.current = chart;

    const syncSize = () => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    };

    const ro = new ResizeObserver(syncSize);
    ro.observe(el);
    // Flex layout may settle after first paint; ensure the chart fills the panel.
    requestAnimationFrame(syncSize);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Swap series when chart type changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    mountSeries(chart, mode);
  }, [mode, mountSeries]);

  // Load history when symbol changes.
  useEffect(() => {
    historyRef.current = [];
    currentCandleRef.current = null;
    setHasData(false);
    let cancelled = false;
    get<PricePoint[]>(
      `/api/market/${challengeId}/${symbol}/history?limit=500&series=${priceSeries}`,
    )
      .then((points) => {
        if (cancelled) return;
        applyHistory(points, modeRef.current);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [challengeId, symbol, priceSeries, applyHistory]);

  // Append live ticks.
  useEffect(() => {
    if (!live || !seriesRef.current) return;
    setHasData(true);

    const prev = historyRef.current.at(-1);
    if (prev && live.timestamp - prev.timestamp > SESSION_GAP_MS) {
      historyRef.current = [live];
      applyHistory([live], modeRef.current);
      return;
    }

    historyRef.current = [...historyRef.current, live].slice(-500);

    if (modeRef.current === "candle") {
      const bucket =
        Math.floor(live.timestamp / 1000 / CANDLE_SEC) * CANDLE_SEC;
      const cur = currentCandleRef.current;

      let candle: Ohlc;
      if (!cur || (cur.time as number) !== bucket) {
        candle = {
          time: bucket as UTCTimestamp,
          open: live.price,
          high: live.price,
          low: live.price,
          close: live.price,
        };
      } else {
        candle = {
          time: cur.time,
          open: cur.open,
          high: Math.max(cur.high, live.price),
          low: Math.min(cur.low, live.price),
          close: live.price,
        };
      }

      currentCandleRef.current = candle;
      (seriesRef.current as ISeriesApi<"Candlestick">).update(candle);
    } else {
      const time = Math.floor(live.timestamp / 1000) as UTCTimestamp;
      (seriesRef.current as ISeriesApi<"Line">).update({
        time,
        value: live.price,
      });
    }
  }, [live, applyHistory]);

  return (
    <div className="relative h-full w-full">
      <div className="absolute right-2 top-2 z-10 flex gap-1.5">
        <div
          className="flex rounded-lg border border-border bg-bg/70 p-0.5 backdrop-blur-md"
          role="group"
          aria-label="Price series"
        >
          <button
            type="button"
            onClick={() => setPriceSeries("mid")}
            className={cn(
              "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
              priceSeries === "mid"
                ? "bg-accent-subtle text-text"
                : "text-muted hover:text-text",
            )}
          >
            Mid
          </button>
          <button
            type="button"
            onClick={() => setPriceSeries("last")}
            className={cn(
              "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
              priceSeries === "last"
                ? "bg-accent-subtle text-text"
                : "text-muted hover:text-text",
            )}
          >
            Last
          </button>
        </div>
        <div
          className="flex rounded-lg border border-border bg-bg/70 p-0.5 backdrop-blur-md"
          role="group"
          aria-label="Chart type"
        >
        <button
          type="button"
          onClick={() => setMode("candle")}
          className={cn(
            "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
            mode === "candle"
              ? "bg-accent-subtle text-text"
              : "text-muted hover:text-text",
          )}
        >
          Candles
        </button>
        <button
          type="button"
          onClick={() => setMode("line")}
          className={cn(
            "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
            mode === "line"
              ? "bg-accent-subtle text-text"
              : "text-muted hover:text-text",
          )}
        >
          Line
        </button>
        </div>
      </div>
      <div ref={containerRef} className="h-full w-full" />
      {!hasData && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="flex items-center gap-2 text-xs text-faint">
            <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />
            Waiting for market data…
          </div>
        </div>
      )}
    </div>
  );
}
