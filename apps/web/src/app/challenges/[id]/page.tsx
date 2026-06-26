"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, Wifi, WifiOff } from "lucide-react";
import type { Challenge, LeaderboardEntry, NewsItem, Portfolio } from "@qtp/shared";
import { get } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useRealtime } from "@/hooks/useRealtime";
import { TopBar } from "@/components/TopBar";
import { Countdown } from "@/components/Countdown";
import { StatusBadge } from "@/components/ui/Badge";
import { Panel } from "@/components/ui/Panel";
import { Skeleton } from "@/components/ui/Skeleton";
import { PriceChart } from "@/components/trade/PriceChart";
import { OrderBook } from "@/components/trade/OrderBook";
import { TradeTicket } from "@/components/trade/TradeTicket";
import { PortfolioPanel } from "@/components/trade/PortfolioPanel";
import { OpenOrders } from "@/components/trade/OpenOrders";
import { Leaderboard } from "@/components/trade/Leaderboard";
import { NewsTicker } from "@/components/trade/NewsTicker";
import { money, signed, dirClass } from "@/lib/format";
import { cn } from "@/lib/cn";

export default function TradePage() {
  const params = useParams<{ id: string }>();
  const challengeId = params.id;
  const user = useAuth((s) => s.user);

  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [activeSymbol, setActiveSymbol] = useState<string>("");
  const [limitPrice, setLimitPrice] = useState("");
  const [restPortfolio, setRestPortfolio] = useState<Portfolio | null>(null);
  const [restLeaderboard, setRestLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [restNews, setRestNews] = useState<NewsItem[]>([]);
  const [orderRefresh, setOrderRefresh] = useState(0);

  const rt = useRealtime(challengeId);

  useEffect(() => {
    get<Challenge>(`/api/challenges/${challengeId}`)
      .then((c) => {
        setChallenge(c);
        setActiveSymbol(c.config.symbols[0]?.symbol ?? "");
      })
      .catch(() => setNotFound(true));
  }, [challengeId]);

  // Initial / refreshed portfolio via REST (WS pushes live updates after).
  useEffect(() => {
    if (!user) return;
    get<Portfolio>(`/api/portfolio/${challengeId}`)
      .then(setRestPortfolio)
      .catch(() => {});
  }, [challengeId, user, orderRefresh]);

  // Refresh open orders + portfolio when an order event arrives.
  useEffect(() => {
    if (rt.lastOrder) setOrderRefresh((n) => n + 1);
  }, [rt.lastOrder]);

  // Initial leaderboard so it paints before the first WS tick.
  useEffect(() => {
    get<LeaderboardEntry[]>(`/api/leaderboard/${challengeId}`)
      .then(setRestLeaderboard)
      .catch(() => {});
  }, [challengeId]);

  // Bootstrap news until WS news_feed snapshot arrives.
  useEffect(() => {
    get<{ items: NewsItem[] }>(`/api/challenges/${challengeId}/news`)
      .then((r) => setRestNews(r.items))
      .catch(() => {});
  }, [challengeId]);

  const news = rt.news.length ? rt.news : restNews;

  // Seed the limit price input when switching symbols.
  useEffect(() => {
    const p = rt.prices.get(activeSymbol)?.price;
    if (p != null && !limitPrice) setLimitPrice(p.toFixed(2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSymbol, rt.prices.get(activeSymbol)?.price]);

  const portfolio = rt.portfolio ?? restPortfolio;
  const activeCfg = challenge?.config.symbols.find((s) => s.symbol === activeSymbol);
  const book = rt.books.get(activeSymbol);
  const livePrice = rt.prices.get(activeSymbol);

  const metric = challenge?.type === "market_making" ? "score" : "pnl";

  const symbolStrip = useMemo(
    () =>
      challenge?.config.symbols.map((s) => {
        const price = rt.prices.get(s.symbol)?.price ?? s.initialPrice;
        const change = (price - s.initialPrice) / s.initialPrice;
        return { symbol: s.symbol, name: s.name, price, change };
      }) ?? [],
    [challenge, rt.prices],
  );

  if (notFound) {
    return (
      <div className="min-h-dvh">
        <TopBar />
        <div className="mx-auto max-w-md px-4 py-24 text-center">
          <h1 className="text-lg font-semibold">Challenge not found</h1>
          <Link href="/" className="mt-2 inline-block text-sm text-accent hover:underline">
            Back to challenges
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh">
      <TopBar
        center={
          challenge && (
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">{challenge.name}</span>
              <StatusBadge status={challenge.status} />
              {challenge.endsAt && challenge.status === "live" && (
                <span className="hidden lg:block">
                  <Countdown target={challenge.endsAt} />
                </span>
              )}
            </div>
          )
        }
      />

      {news.length > 0 && <NewsTicker items={news} />}

      <main id="main" className="mx-auto max-w-[1600px] space-y-3 p-3">
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-1 text-sm text-muted hover:text-text"
          >
            <ChevronLeft className="size-4" /> Challenges
          </Link>
          <span
            className={cn(
              "flex items-center gap-1.5 text-xs",
              rt.status === "open" ? "text-up" : "text-faint",
            )}
          >
            {rt.status === "open" ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
            {rt.status === "open" ? "Live" : rt.status === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
        </div>

        {/* Symbol strip */}
        {!challenge ? (
          <Skeleton className="h-14 w-full" />
        ) : (
          <div className="flex gap-2 overflow-x-auto">
            {symbolStrip.map((s) => (
              <button
                key={s.symbol}
                onClick={() => {
                  setActiveSymbol(s.symbol);
                  setLimitPrice(s.price.toFixed(2));
                }}
                className={cn(
                  "flex min-w-[140px] flex-col items-start rounded-lg border px-3 py-2 transition-colors",
                  activeSymbol === s.symbol
                    ? "border-accent bg-accent-subtle/30"
                    : "border-border bg-surface hover:border-border-strong",
                )}
              >
                <span className="text-xs font-medium">{s.symbol}</span>
                <div className="flex items-baseline gap-2">
                  <span className="mono text-sm">{money(s.price)}</span>
                  <span className={cn("mono text-xs", dirClass(s.change))}>
                    {signed(s.change * 100)}%
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Chart — full width, fixed height (do not stretch to match sidebar) */}
        <Panel>
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold">{activeSymbol || "—"}</span>
              {activeCfg?.name && (
                <span className="text-xs text-muted">{activeCfg.name}</span>
              )}
            </div>
            {livePrice && (
              <span className="mono text-sm font-semibold">{money(livePrice.price)}</span>
            )}
          </div>
          <div className="h-[300px] p-1 sm:h-[340px] lg:h-[380px]">
            {activeSymbol && (
              <PriceChart
                challengeId={challengeId}
                symbol={activeSymbol}
                lastPrice={livePrice}
                book={book}
              />
            )}
          </div>
        </Panel>

        {/* Portfolio + trade ticket */}
        <div className="grid gap-3 lg:grid-cols-2">
          <PortfolioPanel
            portfolio={portfolio}
            prices={rt.prices}
            mm={challenge?.type === "market_making"}
          />
          {activeCfg && (
            <TradeTicket
              challengeId={challengeId}
              symbol={activeSymbol}
              maxQuantity={challenge?.config.maxOrderQuantity ?? 50}
              price={limitPrice}
              onPriceChange={setLimitPrice}
              refPrice={livePrice?.price}
            />
          )}
        </div>

        {/* Order book, open orders, leaderboard */}
        <div className="grid gap-3 xl:grid-cols-12">
          <div className="xl:col-span-4">
            <OrderBook
              snapshot={book}
              onPick={(p) => setLimitPrice(p.toFixed(2))}
            />
          </div>
          <div className="xl:col-span-4">
            <OpenOrders challengeId={challengeId} refreshKey={orderRefresh} />
          </div>
          <div className="xl:col-span-4">
            <Leaderboard
              entries={rt.leaderboard.length ? rt.leaderboard : restLeaderboard}
              meId={user?.id}
              metric={metric}
              mm={challenge?.type === "market_making"}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
