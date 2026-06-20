"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { PricePoint } from "@qtp/shared";
import { get } from "@/lib/api";

// sRGB equivalents of the OKLCH design tokens (lightweight-charts cannot parse oklch()).
const CHART = {
  muted: "#a7a5b0", // --color-muted  oklch(0.73 0.012 280)
  grid: "#2b2a33", // --color-surface-2  oklch(0.23 0.014 280)
  border: "#3a3942", // --color-border  oklch(0.3 0.014 280)
  up: "#34d39e", // --color-up  oklch(0.76 0.14 168)
  down: "#e86868", // --color-down  oklch(0.67 0.165 22)
} as const;

/** Bucket width for OHLC candles (engine ticks ~1s apart). */
const CANDLE_SEC = 5;

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

export function PriceChart({
  challengeId,
  symbol,
  live,
}: {
  challengeId: string;
  symbol: string;
  live?: PricePoint;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastTimeRef = useRef<number>(0);
  const currentCandleRef = useRef<Ohlc | null>(null);

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

    const series = chart.addSeries(CandlestickSeries, {
      upColor: CHART.up,
      downColor: CHART.down,
      borderVisible: false,
      wickUpColor: CHART.up,
      wickDownColor: CHART.down,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });

    chartRef.current = chart;
    seriesRef.current = series;

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

  // Load history when symbol changes.
  useEffect(() => {
    lastTimeRef.current = 0;
    currentCandleRef.current = null;
    let cancelled = false;
    get<PricePoint[]>(`/api/market/${challengeId}/${symbol}/history?limit=500`)
      .then((points) => {
        if (cancelled || !seriesRef.current) return;
        const candles = ticksToCandles(points, CANDLE_SEC);
        seriesRef.current.setData(candles);
        const last = candles.at(-1);
        if (last) {
          lastTimeRef.current = last.time as number;
          currentCandleRef.current = { ...last };
        }
        chartRef.current?.timeScale().fitContent();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [challengeId, symbol]);

  // Append live ticks into the current candle bucket.
  useEffect(() => {
    if (!live || !seriesRef.current) return;

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
    seriesRef.current.update(candle);
    lastTimeRef.current = bucket;
  }, [live]);

  return <div ref={containerRef} className="h-full w-full" />;
}
