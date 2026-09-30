"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronLeft, Maximize2 } from "lucide-react";
import type { Challenge, LeaderboardEntry } from "@qtp/shared";
import { get } from "@/lib/api";
import { useRealtime } from "@/hooks/useRealtime";
import { AdminGuard } from "@/components/AdminGuard";
import { Leaderboard } from "@/components/trade/Leaderboard";
import { PriceChart } from "@/components/trade/PriceChart";
import { Panel } from "@/components/ui/Panel";
import { StatusBadge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { dirClass, money, signed } from "@/lib/format";

function StatsInner() {
  const { id } = useParams<{ id: string }>();
  const rt = useRealtime(id);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const loaded = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let stop = false;
    loaded.current = false;
    async function tick() {
      try {
        const next = await get<Challenge>(`/api/challenges/${id}`);
        const ranks = await get<LeaderboardEntry[]>(
          `/api/leaderboard/${id}`,
        ).catch(() => [] as LeaderboardEntry[]);
        if (stop) return;
        loaded.current = true;
        setChallenge(next);
        if (ranks.length > 0) setBoard(ranks);
        setError(null);
      } catch {
        if (!stop && !loaded.current) setError("Could not load this event.");
      }
    }
    void tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [id]);

  useEffect(() => {
    if (rt.leaderboard.length > 0) setBoard(rt.leaderboard);
  }, [rt.leaderboard]);

  const symbols = useMemo(() => {
    const rows = new Map<string, { symbol: string; name?: string }>();
    for (const symbol of challenge?.config.symbols ?? []) {
      rows.set(symbol.symbol, { symbol: symbol.symbol, name: symbol.name });
    }
    for (const etf of challenge?.config.eden?.etfs ?? []) {
      if (!rows.has(etf.symbol)) {
        rows.set(etf.symbol, { symbol: etf.symbol, name: etf.name });
      }
    }
    for (const listed of rt.listedSymbols) {
      if (listed.kind === "option" || rows.has(listed.symbol)) continue;
      rows.set(listed.symbol, { symbol: listed.symbol, name: listed.name });
    }
    return [...rows.values()];
  }, [challenge, rt.listedSymbols]);

  const entries = board;
  const mm = challenge?.type === "market_making";

  return (
    <div className="grid h-dvh grid-rows-[auto_minmax(0,1fr)] bg-bg text-text">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3">
        <Link
          href={`/admin/${id}`}
          className="inline-flex items-center gap-1 rounded-sm text-xs text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ChevronLeft className="size-3.5" /> Event
        </Link>
        <div className="min-w-0">
          <p className="mono text-[10px] uppercase tracking-[0.16em] text-muted">
            Room display
          </p>
          <h1 className="truncate text-lg font-semibold tracking-tight">
            {challenge?.name ?? "Event stats"}
          </h1>
        </div>
        {challenge && <StatusBadge status={challenge.status} />}
        {challenge?.frozen && challenge.status === "live" && (
          <span className="rounded-sm border border-warning/30 bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
            Frozen
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <time className="mono text-sm tabular-nums text-muted" dateTime={now.toISOString()}>
            {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </time>
          <button
            type="button"
            onClick={() => void document.documentElement.requestFullscreen?.()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-xs font-medium hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Maximize2 className="size-3.5" /> Fill screen
          </button>
        </div>
      </header>

      {error && !challenge ? (
        <div role="alert" className="grid place-items-center px-6 text-sm text-muted">
          {error}
        </div>
      ) : !challenge ? (
        <div className="grid gap-3 p-4 lg:grid-cols-[22rem_minmax(0,1fr)]" role="status">
          <Skeleton className="h-full min-h-64" />
          <Skeleton className="h-full min-h-64" />
        </div>
      ) : (
        <div className="grid min-h-0 lg:grid-cols-[minmax(280px,24rem)_minmax(0,1fr)]">
          <div className="min-h-0 border-b border-border lg:border-b-0 lg:border-r">
            <Leaderboard
              className="h-full rounded-none border-0"
              entries={entries}
              metric={mm ? "score" : "pnl"}
              mm={mm}
              hidden={challenge.leaderboardHidden}
              isAdmin
              final={challenge.status === "ended"}
              room
            />
          </div>
          <div
            className={cn(
              "grid min-h-0 gap-3 overflow-auto p-3",
              symbols.length <= 1 && "grid-rows-1",
              symbols.length === 2 && "grid-rows-2",
              symbols.length > 2 &&
                "auto-rows-[minmax(240px,1fr)] sm:grid-cols-2",
            )}
          >
            {symbols.map((symbol) => {
              const point = rt.prices.get(symbol.symbol);
              const price = point?.price;
              return (
                <Panel
                  key={symbol.symbol}
                  className="flex h-full min-h-[220px] flex-col overflow-hidden"
                >
                  <div className="flex items-baseline justify-between gap-3 border-b border-border px-3 py-2">
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-semibold tracking-wide">
                        {symbol.symbol}
                      </h2>
                      {symbol.name && symbol.name !== symbol.symbol && (
                        <p className="truncate text-[11px] text-muted">{symbol.name}</p>
                      )}
                    </div>
                    <p className={cn("mono text-lg tabular-nums", price == null ? "text-muted" : dirClass(point?.change ?? 0))}>
                      {price == null ? "—" : money(price)}
                      {point && point.change !== 0 && (
                        <span className="ml-2 text-xs">{signed(point.change)}</span>
                      )}
                    </p>
                  </div>
                  <div className="relative min-h-0 flex-1">
                    <PriceChart
                      challengeId={id}
                      symbol={symbol.symbol}
                      lastPrice={point}
                      book={rt.books.get(symbol.symbol)}
                      presentation
                    />
                  </div>
                </Panel>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function EventStatsPage() {
  return (
    <AdminGuard>
      <StatsInner />
    </AdminGuard>
  );
}
