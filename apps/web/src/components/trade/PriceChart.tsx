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
import type {
  ChartPriceSeries,
  OrderBookSnapshot,
  PricePoint,
} from "@qtp/shared";
import { midFromBook } from "@qtp/shared";
import { get } from "@/lib/api";
import { cn } from "@/lib/cn";

// RGB fallbacks for the workbench tokens: lightweight-charts cannot parse OKLCH or CSS variables.
const CHART = {
  muted: "#aaa49a",
  grid: "rgba(239, 232, 221, 0.045)",
  border: "rgba(239, 232, 221, 0.12)",
  up: "#86b99a",
  down: "#dd817b",
  line: "#ff8058",
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
    const bucket = Math.floor(p.timestamp / 1000 / intervalSec) * intervalSec;
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

  return [...buckets.values()].sort(
    (a, b) => (a.time as number) - (b.time as number),
  );
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
  const [historyStatus, setHistoryStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [retry, setRetry] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const colorsRef = useRef<Record<keyof typeof CHART, string>>(CHART);
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

  const applyHistory = useCallback(
    (points: PricePoint[], chartMode: ChartMode) => {
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
    },
    [],
  );

  const mountSeries = useCallback(
    (chart: IChartApi, chartMode: ChartMode) => {
      if (seriesRef.current) {
        chart.removeSeries(seriesRef.current);
        seriesRef.current = null;
      }

      if (chartMode === "candle") {
        seriesRef.current = chart.addSeries(CandlestickSeries, {
          upColor: colorsRef.current.up,
          downColor: colorsRef.current.down,
          borderVisible: false,
          wickUpColor: colorsRef.current.up,
          wickDownColor: colorsRef.current.down,
          priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        });
      } else {
        seriesRef.current = chart.addSeries(LineSeries, {
          color: colorsRef.current.line,
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

    const styles = getComputedStyle(el);
    const tokens = {
      muted: "--color-muted",
      border: "--color-border",
      up: "--color-up",
      down: "--color-down",
      line: "--color-accent",
    } as const;
    const colors = { ...CHART } as Record<keyof typeof CHART, string>;
    for (const key of Object.keys(tokens) as Array<keyof typeof tokens>) {
      const value = styles.getPropertyValue(tokens[key]).trim();
      // Keep unsupported modern color syntax out of the library's color parser.
      if (/^(#[\da-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(value))
        colors[key] = value;
    }
    colorsRef.current = colors;

    const chart = createChart(el, {
      layout: {
        background: { color: "transparent" },
        textColor: colors.muted,
        fontFamily:
          styles.getPropertyValue("--font-geist-mono").trim() || "monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      rightPriceScale: { borderColor: colors.border },
      timeScale: {
        borderColor: colors.border,
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
    const frame = requestAnimationFrame(syncSize);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
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
    setHistoryStatus("loading");
    seriesRef.current?.setData([]);
    let cancelled = false;
    get<PricePoint[]>(
      `/api/market/${challengeId}/${symbol}/history?limit=500&series=${priceSeries}`,
    )
      .then((points) => {
        if (cancelled) return;
        applyHistory(points, modeRef.current);
        setHistoryStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setHistoryStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [challengeId, symbol, priceSeries, applyHistory, retry]);

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
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-2 py-2">
        <span className="text-[10px] uppercase tracking-wide text-faint">
          {mode === "candle" ? "5s candles" : "Price history"}
        </span>
        <div className="flex flex-wrap gap-1.5">
          <div
            className="flex rounded-md border border-border bg-surface-2 p-0.5"
            role="group"
            aria-label="Price series"
          >
            <button
              type="button"
              onClick={() => setPriceSeries("mid")}
              aria-pressed={priceSeries === "mid"}
              className={cn(
                "rounded px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent",
                priceSeries === "mid"
                  ? "bg-accent-subtle text-text"
                  : "text-muted hover:text-text",
              )}
            >
              Mid price
            </button>
            <button
              type="button"
              onClick={() => setPriceSeries("last")}
              aria-pressed={priceSeries === "last"}
              className={cn(
                "rounded px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent",
                priceSeries === "last"
                  ? "bg-accent-subtle text-text"
                  : "text-muted hover:text-text",
              )}
            >
              Last trade
            </button>
          </div>
          <div
            className="flex rounded-md border border-border bg-surface-2 p-0.5"
            role="group"
            aria-label="Chart type"
          >
            <button
              type="button"
              onClick={() => setMode("candle")}
              aria-pressed={mode === "candle"}
              className={cn(
                "rounded px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent",
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
              aria-pressed={mode === "line"}
              className={cn(
                "rounded px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent",
                mode === "line"
                  ? "bg-accent-subtle text-text"
                  : "text-muted hover:text-text",
              )}
            >
              Line
            </button>
          </div>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          role="img"
          aria-label={`${symbol} ${priceSeries === "mid" ? "mid-price" : "last-trade"} chart${live ? `, latest ${live.price.toFixed(2)}` : ""}`}
          className="absolute inset-0"
        />
        {!hasData && (
          <div className="absolute inset-0 grid place-items-center">
            <div
              role="status"
              className="space-y-2 px-4 text-center text-xs text-muted"
            >
              <p>
                {historyStatus === "loading"
                  ? "Loading price history..."
                  : historyStatus === "error"
                    ? "Price history is unavailable."
                    : "Waiting for the first market tick."}
              </p>
              {historyStatus === "error" && (
                <button
                  type="button"
                  onClick={() => setRetry((n) => n + 1)}
                  className="rounded px-2 py-1 text-accent hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Retry history
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      {hasData && historyStatus === "error" && (
        <p role="status" className="px-2 py-1 text-[11px] text-warning">
          History unavailable. Showing live ticks only.
        </p>
      )}
    </div>
  );
}
