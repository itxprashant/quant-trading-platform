"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import type { PricePoint } from "@qtp/shared";
import { get } from "@/lib/api";
import { cn } from "@/lib/cn";

// sRGB equivalents of the OKLCH design tokens (lightweight-charts cannot parse oklch()).
const CHART = {
  muted: "#a7a5b0", // --color-muted  oklch(0.73 0.012 280)
  grid: "#2b2a33", // --color-surface-2  oklch(0.23 0.014 280)
  border: "#3a3942", // --color-border  oklch(0.3 0.014 280)
  up: "#34d39e", // --color-up  oklch(0.76 0.14 168)
  down: "#e86868", // --color-down  oklch(0.67 0.165 22)
  line: "#9b86e8", // --color-accent  oklch(0.64 0.185 285)
} as const;

/** Bucket width for OHLC candles (engine ticks ~1s apart). */
const CANDLE_SEC = 5;

type ChartMode = "candle" | "line";
type Ohlc = CandlestickData<UTCTimestamp>;

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
  live,
}: {
  challengeId: string;
  symbol: string;
  live?: PricePoint;
}) {
  const [mode, setMode] = useState<ChartMode>("candle");
  const [hasData, setHasData] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<
    ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null
  >(null);
  const historyRef = useRef<PricePoint[]>([]);
  const currentCandleRef = useRef<Ohlc | null>(null);
  const modeRef = useRef<ChartMode>("candle");

  modeRef.current = mode;

  const applyHistory = useCallback((points: PricePoint[], chartMode: ChartMode) => {
    historyRef.current = points;
    if (points.length > 0) setHasData(true);
    const series = seriesRef.current;
    if (!series) return;

    if (chartMode === "candle") {
      const candles = ticksToCandles(points, CANDLE_SEC);
      (series as ISeriesApi<"Candlestick">).setData(candles);
      const last = candles.at(-1);
      currentCandleRef.current = last ? { ...last } : null;
    } else {
      (series as ISeriesApi<"Line">).setData(ticksToLine(points));
      currentCandleRef.current = null;
    }
    chartRef.current?.timeScale().fitContent();
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
        fontFamily: "var(--font-mono-geist), monospace",
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
      },
      crosshair: { mode: 0 },
      width: el.clientWidth,
      height: el.clientHeight,
    });

    chartRef.current = chart;

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);

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
    get<PricePoint[]>(`/api/market/${challengeId}/${symbol}/history?limit=500`)
      .then((points) => {
        if (cancelled) return;
        applyHistory(points, modeRef.current);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [challengeId, symbol, applyHistory]);

  // Append live ticks.
  useEffect(() => {
    if (!live || !seriesRef.current) return;
    setHasData(true);

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
  }, [live]);

  return (
    <div className="relative h-full w-full">
      <div
        className="absolute right-2 top-2 z-10 flex rounded-md border border-border bg-surface/90 p-0.5 backdrop-blur-sm"
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
