"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, LineChart, Wifi, WifiOff } from "lucide-react";
import type {
  Challenge,
  LeaderboardEntry,
  NewsItem,
  OrderBookSnapshot,
  Portfolio,
  SymbolConfig,
} from "@qtp/shared";
import { ApiError, get } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useRealtime } from "@/hooks/useRealtime";
import { useAuction } from "@/hooks/useAuction";
import { useChartVisible } from "@/hooks/useChartVisible";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { TopBar } from "@/components/TopBar";
import { StatusBadge } from "@/components/ui/Badge";
import { Panel } from "@/components/ui/Panel";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { PriceChart } from "@/components/trade/PriceChart";
import { OrderBook } from "@/components/trade/OrderBook";
import { TradeTicket } from "@/components/trade/TradeTicket";
import { PortfolioPanel } from "@/components/trade/PortfolioPanel";
import { OpenOrders } from "@/components/trade/OpenOrders";
import { Leaderboard } from "@/components/trade/Leaderboard";
import { MarketList } from "@/components/trade/MarketList";
import { NewsFeed, earlyLeadSec } from "@/components/trade/NewsFeed";
import { EventTimers } from "@/components/trade/EventTimers";
import { BankPanel } from "@/components/trade/BankPanel";
import { AlertStack, type NewsToast } from "@/components/trade/AlertStack";
import { OptionsPanel } from "@/components/trade/OptionsPanel";
import { MarketsPanel } from "@/components/trade/MarketsPanel";
import { DealDesk } from "@/components/trade/DealDesk";
import { AuctionPopup } from "@/components/trade/AuctionPopup";
import { VotePanel } from "@/components/trade/VotePanel";
import { GrantBanner } from "@/components/trade/GrantBanner";
import { money, signed, dirClass } from "@/lib/format";
import { cn } from "@/lib/cn";

/** Sidebars stick below the navbar and fill the rest of the viewport. */
const STICKY_SIDEBAR =
  "sticky top-[calc(var(--topbar-h,68px)_+_0.75rem)] h-[calc(100dvh_-_var(--topbar-h,68px)_-_1.5rem)] self-start";

export default function TradePage() {
  const params = useParams<{ id: string }>();
  const challengeId = params.id;
  const user = useAuth((s) => s.user);
  const isAdmin = user?.role === "admin";

  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [activeSymbol, setActiveSymbol] = useState<string>("");
  const [limitPrice, setLimitPrice] = useState("");
  const [restPortfolio, setRestPortfolio] = useState<Portfolio | null>(null);
  const [restLeaderboard, setRestLeaderboard] = useState<LeaderboardEntry[]>(
    [],
  );
  const [restNews, setRestNews] = useState<NewsItem[]>([]);
  const [orderRefresh, setOrderRefresh] = useState(0);
  const [restBook, setRestBook] = useState<OrderBookSnapshot>();
  const [newsToasts, setNewsToasts] = useState<NewsToast[]>([]);
  const [newsReceivedAt, setNewsReceivedAt] = useState<Record<string, number>>(
    {},
  );
  const [auctionMinimized, setAuctionMinimized] = useState(false);
  const [chartVisible, toggleChart] = useChartVisible();
  const isLg = useMediaQuery("(min-width: 1024px)");
  const isXl = useMediaQuery("(min-width: 1280px)");

  const isEden = challenge?.type === "new_eden";
  const rt = useRealtime(challengeId, isEden);
  const auction = useAuction({
    challengeId,
    enabled: isEden && !!user,
    liveAuction: rt.auction,
    liveWon: rt.auctionWon,
    connectionStatus: rt.status,
  });
  const leaderboardHidden =
    rt.leaderboardHidden ?? challenge?.leaderboardHidden ?? false;

  useEffect(() => {
    let cancelled = false;
    setChallenge(null);
    setLoadError(null);
    setRestPortfolio(null);
    get<Challenge>(`/api/challenges/${challengeId}`)
      .then((c) => {
        if (cancelled) return;
        setChallenge(c);
        setActiveSymbol(c.config.symbols[0]?.symbol ?? "");
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiError && err.status === 404
            ? "Challenge not found"
            : "Unable to load this challenge",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [challengeId, retry]);

  // Initial / refreshed portfolio via REST (WS pushes live updates after).
  useEffect(() => {
    if (rt.portfolio?.challengeId === challengeId)
      setRestPortfolio(rt.portfolio);
  }, [rt.portfolio, challengeId]);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    get<Portfolio>(`/api/portfolio/${challengeId}`)
      .then((p) => {
        if (!cancelled) setRestPortfolio(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [challengeId, user, orderRefresh, rt.status, rt.otcResult]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      get<Challenge>(`/api/challenges/${challengeId}`)
        .then((c) => {
          if (!cancelled) setChallenge(c);
        })
        .catch(() => {});
    const timer = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [challengeId, rt.status]);

  useEffect(() => {
    setRestBook(undefined);
    if (!activeSymbol) return;
    let cancelled = false;
    const refresh = () =>
      get<OrderBookSnapshot>(
        `/api/market/${challengeId}/${encodeURIComponent(activeSymbol)}/orderbook`,
      )
        .then((b) => {
          if (!cancelled) setRestBook(b);
        })
        .catch(() => {});
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [challengeId, activeSymbol, rt.status]);

  // Refresh open orders + portfolio when an order event arrives.
  useEffect(() => {
    if (rt.lastOrder) setOrderRefresh((n) => n + 1);
  }, [rt.lastOrder]);

  // Paint rankings before the first WS tick; refetch when the host toggles
  // visibility (the API answers 403 to traders while hidden).
  useEffect(() => {
    let cancelled = false;
    get<LeaderboardEntry[]>(`/api/leaderboard/${challengeId}`)
      .then((entries) => {
        if (!cancelled) setRestLeaderboard(entries);
      })
      .catch(() => {
        if (!cancelled) setRestLeaderboard([]);
      });
    return () => {
      cancelled = true;
    };
  }, [challengeId, leaderboardHidden, user?.id]);

  // Bootstrap news until WS news_feed snapshot arrives.
  useEffect(() => {
    get<{ items: NewsItem[] }>(`/api/challenges/${challengeId}/news`)
      .then((r) => setRestNews(r.items))
      .catch(() => {});
  }, [challengeId]);

  // Each live headline pops once, flagged early if it beat the public release.
  useEffect(() => {
    const last = rt.lastNews;
    if (!last) return;
    const now = Date.now();
    setNewsToasts((toasts) =>
      [
        {
          item: last.item,
          early: earlyLeadSec(last.item, now) != null,
          receivedAt: now,
        },
        ...toasts.filter((t) => t.item.id !== last.item.id),
      ].slice(0, 8),
    );
    setNewsReceivedAt((seen) => ({ ...seen, [last.item.id]: now }));
  }, [rt.lastNews]);

  useEffect(() => {
    setAuctionMinimized(false);
  }, [auction.auction?.id]);

  const news = rt.news.length ? rt.news : restNews;

  // Seed the limit price input when switching symbols.
  useEffect(() => {
    const p = rt.prices.get(activeSymbol)?.price;
    if (p != null && !limitPrice) setLimitPrice(p.toFixed(2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSymbol, rt.prices.get(activeSymbol)?.price]);

  const portfolio = restPortfolio;

  // Base config symbols plus any spot/ETF instruments introduced live.
  const tradableSymbols = useMemo<SymbolConfig[]>(() => {
    const base = challenge?.config.symbols ?? [];
    const etfs = (challenge?.config.eden?.etfs ?? []).map((e) => ({
      symbol: e.symbol,
      name: e.name,
      tickSize: 0.01,
      volatility: 0,
      initialPrice: e.basket.reduce(
        (sum, leg) =>
          sum +
          leg.weight *
            (base.find((s) => s.symbol === leg.symbol)?.initialPrice ?? 0),
        0,
      ),
    }));
    const extra = rt.listedSymbols
      .filter((s) => s.kind === "spot" || s.kind === "etf")
      .filter((s) => !base.some((b) => b.symbol === s.symbol))
      .map(({ kind: _kind, ...cfg }) => cfg);
    return Array.from(
      new Map([...base, ...etfs, ...extra].map((s) => [s.symbol, s])).values(),
    );
  }, [challenge, rt.listedSymbols]);

  const activeCfg = tradableSymbols.find((s) => s.symbol === activeSymbol);
  const book =
    rt.books.get(activeSymbol) ??
    (restBook?.symbol === activeSymbol ? restBook : undefined);
  const livePrice = rt.prices.get(activeSymbol);

  const metric = challenge?.type === "market_making" ? "score" : "pnl";
  const hasOptions = isEden || rt.optionContracts.length > 0;
  const hasEtfs =
    isEden ||
    !!challenge?.config.eden?.etfs?.length ||
    rt.listedSymbols.some((s) => s.kind === "etf");

  const selectSymbol = (symbol: string, price?: number) => {
    setActiveSymbol(symbol);
    setLimitPrice(price != null ? price.toFixed(2) : "");
  };

  if (loadError) {
    return (
      <div className="min-h-dvh">
        <TopBar fluid />
        <main id="main" className="mx-auto max-w-md px-4 py-24 text-center">
          <h1 className="text-xl font-semibold">{loadError}</h1>
          <p role="alert" className="mt-2 text-sm text-muted">
            {loadError === "Challenge not found"
              ? "This challenge may have been removed. Choose another market to continue."
              : "Check your connection and try again. Your orders have not been changed."}
          </p>
          <Button className="mt-6" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </Button>
          <Link
            href="/challenges"
            className="mt-4 block text-sm text-accent hover:underline"
          >
            Back to challenges
          </Link>
        </main>
      </div>
    );
  }

  if (!challenge) {
    return (
      <div className="min-h-dvh">
        <TopBar fluid />
        <main
          id="main"
          aria-busy="true"
          aria-label="Loading trading workbench"
          className="grid gap-3 p-3 sm:px-4 lg:grid-cols-[232px_minmax(0,1fr)] xl:grid-cols-[232px_minmax(0,1fr)_300px] 2xl:grid-cols-[260px_minmax(0,1fr)_340px]"
        >
          <span role="status" className="sr-only">
            Loading challenge and market data
          </span>
          <Skeleton className="col-span-full h-10 w-72 max-w-full" />
          <div className="hidden space-y-3 lg:block">
            <Skeleton className="h-72" />
            <Skeleton className="h-80" />
          </div>
          <div className="min-w-0 space-y-3">
            <Skeleton className="h-16" />
            <div className="grid gap-3 md:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-[420px]" />
              ))}
            </div>
            <Skeleton className="h-[360px]" />
          </div>
          <Skeleton className="hidden h-[640px] xl:block" />
        </main>
      </div>
    );
  }

  const marketFrozen = rt.frozen ?? challenge.frozen ?? false;
  const scripted = isEden && !!challenge.config.eden?.eventScript;
  const change =
    activeCfg && livePrice && activeCfg.initialPrice > 0
      ? (livePrice.price - activeCfg.initialPrice) / activeCfg.initialPrice
      : null;
  const leaderboardEntries = rt.leaderboard.length
    ? rt.leaderboard
    : restLeaderboard;
  const leaderboardFills = !(leaderboardHidden && !isAdmin);

  const leaderboard = (className?: string) => (
    <Leaderboard
      compact
      entries={leaderboardEntries}
      meId={user?.id}
      metric={metric}
      mm={challenge.type === "market_making"}
      hidden={leaderboardHidden}
      isAdmin={isAdmin}
      className={className}
    />
  );
  const newsFeed = (className?: string) => (
    <NewsFeed
      items={news}
      receivedAt={newsReceivedAt}
      premium={auction.premium}
      className={className}
    />
  );

  return (
    <div className="min-h-dvh">
      <TopBar
        fluid
        center={
          <EventTimers
            challenge={challenge}
            auction={auction.auction}
            contracts={rt.optionContracts}
            premium={auction.premium}
            onAuctionClick={() => setAuctionMinimized(false)}
          />
        }
      />

      {isEden && <GrantBanner grant={rt.grant} />}

      <AlertStack alerts={rt.alerts} news={newsToasts} />

      <main
        id="main"
        className="grid min-w-0 gap-3 p-3 sm:px-4 lg:grid-cols-[232px_minmax(0,1fr)] xl:grid-cols-[232px_minmax(0,1fr)_300px] 2xl:grid-cols-[260px_minmax(0,1fr)_340px]"
      >
        <header className="col-span-full min-w-0 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <Link
                href="/challenges"
                aria-label="All challenges"
                className="grid size-7 place-items-center rounded-md border border-border text-muted transition-colors hover:border-border-strong hover:text-text"
              >
                <ChevronLeft className="size-4" aria-hidden />
              </Link>
              <h1 className="break-words text-lg font-semibold tracking-tight">
                {challenge.name}
              </h1>
              <StatusBadge status={challenge.status} />
              {marketFrozen && (
                <span className="rounded-sm border border-warning/30 bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
                  Frozen
                </span>
              )}
              <span className="text-xs text-muted">
                {isEden
                  ? "New Eden"
                  : challenge.type === "market_making"
                    ? "Market making"
                    : "Directional trading"}
                <span className="mx-2 text-faint" aria-hidden>
                  /
                </span>
                {tradableSymbols.length} instruments
              </span>
            </div>
            <span
              role="status"
              className={cn(
                "flex items-center gap-1.5 text-xs",
                rt.status === "open" ? "text-up" : "text-warning",
              )}
            >
              {rt.status === "open" ? (
                <Wifi className="size-3.5" aria-hidden />
              ) : (
                <WifiOff className="size-3.5" aria-hidden />
              )}
              {rt.status === "open"
                ? "Feed connected"
                : rt.status === "connecting"
                  ? "Connecting..."
                  : "Reconnecting..."}
            </span>
          </div>
          {marketFrozen && (
            <div
              role="status"
              className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
            >
              Market frozen — you can only cancel pending orders.
            </div>
          )}
          {rt.status !== "open" && (
            <p className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted">
              Live prices may be delayed until the feed reconnects.
            </p>
          )}
        </header>

        <aside
          aria-label="Markets and rankings"
          className={cn(
            "min-w-0",
            isLg && cn(STICKY_SIDEBAR, "flex flex-col gap-3"),
          )}
        >
          <MarketList
            symbols={tradableSymbols}
            prices={rt.prices}
            portfolio={portfolio}
            active={activeSymbol}
            onSelect={selectSymbol}
            className={cn(
              isLg ? "max-h-[55%] shrink-0" : "max-h-72",
            )}
          />
          {isLg && leaderboard(leaderboardFills ? "min-h-0 flex-1" : "")}
        </aside>

        <div className="@container min-w-0 space-y-3">
          <Panel className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">
                {activeSymbol || "No instrument selected"}
              </h2>
              {activeCfg?.name && (
                <span className="block truncate text-xs text-muted">
                  {activeCfg.name}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {isEden && rt.fairValues.get(activeSymbol) != null && (
                <span className="flex items-baseline gap-1 text-xs text-muted">
                  <span className="text-[10px] uppercase tracking-wide text-faint">
                    Fair value
                  </span>
                  <span className="mono">
                    {money(rt.fairValues.get(activeSymbol)!)}
                  </span>
                </span>
              )}
              {livePrice && (
                <span className="flex items-baseline gap-2">
                  <span className="mono text-xl font-medium">
                    {money(livePrice.price)}
                  </span>
                  {change != null && (
                    <span className={cn("mono text-xs", dirClass(change))}>
                      {signed(change * 100)}%
                    </span>
                  )}
                </span>
              )}
              <button
                type="button"
                aria-pressed={chartVisible}
                onClick={toggleChart}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                  chartVisible
                    ? "border-accent/40 bg-accent-subtle text-accent"
                    : "border-border text-muted hover:border-border-strong hover:text-text",
                )}
              >
                <LineChart className="size-3.5" aria-hidden />
                Chart
              </button>
            </div>
          </Panel>

          {/* Book, account and ticket share a row once the column is wide
              enough; below that the portfolio drops under book + ticket. */}
          <div className="grid min-w-0 gap-3 @min-[560px]:grid-cols-2 @min-[832px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_300px]">
            <div className="order-1 min-w-0 @min-[832px]:order-none">
              <OrderBook
                snapshot={book}
                onPick={(p) => setLimitPrice(p.toFixed(2))}
              />
            </div>
            <div className="order-3 min-w-0 @min-[560px]:col-span-2 @min-[832px]:order-none @min-[832px]:col-span-1">
              <PortfolioPanel
                portfolio={portfolio}
                prices={rt.prices}
                mm={challenge.type === "market_making"}
              />
            </div>
            <div className="order-2 min-w-0 @min-[832px]:order-none">
              {activeCfg ? (
                <TradeTicket
                  challengeId={challengeId}
                  symbol={activeSymbol}
                  maxQuantity={challenge.config.maxOrderQuantity ?? 50}
                  minPosition={
                    isEden
                      ? -(challenge.config.eden?.rules.positionCap ?? 100)
                      : challenge.config.minPosition
                  }
                  maxPosition={
                    isEden
                      ? (challenge.config.eden?.rules.positionCap ?? 100)
                      : challenge.config.maxPosition
                  }
                  maxOpenOrders={challenge.config.maxOpenOrders ?? 25}
                  refreshKey={orderRefresh}
                  price={limitPrice}
                  onPriceChange={setLimitPrice}
                  refPrice={livePrice?.price}
                  frozen={marketFrozen}
                  positionQty={
                    portfolio?.positions.find((p) => p.symbol === activeSymbol)
                      ?.quantity ?? 0
                  }
                />
              ) : (
                <Panel className="grid h-full min-h-48 place-items-center p-6 text-center text-sm text-muted">
                  Order entry opens when an instrument is listed.
                </Panel>
              )}
            </div>
          </div>

          {chartVisible && (
            <Panel className="h-[360px] min-w-0 overflow-hidden p-1 2xl:h-[440px]">
              {activeSymbol ? (
                <PriceChart
                  challengeId={challengeId}
                  symbol={activeSymbol}
                  lastPrice={livePrice}
                  book={book}
                />
              ) : (
                <p className="grid h-full place-items-center text-sm text-muted">
                  No instruments are listed yet.
                </p>
              )}
            </Panel>
          )}

          <OpenOrders
            challengeId={challengeId}
            refreshKey={orderRefresh}
            maxOpenOrders={challenge.config.maxOpenOrders ?? 25}
          />

          {!isXl && newsFeed("max-h-[480px]")}

          {/* Options and ETFs can be introduced live into any challenge type;
              banking and votes stay New Eden. */}
          {hasOptions && (
            <OptionsPanel
              challengeId={challengeId}
              contracts={rt.optionContracts}
              prices={rt.prices}
              books={rt.books}
              portfolio={portfolio}
              maxQuantity={challenge.config.maxOrderQuantity}
              positionCap={
                challenge.config.eden?.rules.positionCap ??
                challenge.config.maxPosition
              }
              exerciseWindowSec={
                challenge.config.eden?.options?.exerciseWindowSec ?? 15
              }
              onChange={() => setOrderRefresh((n) => n + 1)}
              frozen={marketFrozen || challenge.status !== "live"}
              closedHint={
                scripted
                  ? "Options open after halftime, at game minute 70."
                  : undefined
              }
            />
          )}
          {hasEtfs && (
            <MarketsPanel
              challengeId={challengeId}
              prices={rt.prices}
              onSelectSymbol={(symbol) => {
                selectSymbol(symbol);
                window.scrollTo({ top: 0, behavior: "instant" });
              }}
              onChange={() => setOrderRefresh((n) => n + 1)}
              frozen={marketFrozen || challenge.status !== "live"}
            />
          )}
          {isEden && (
            <div className="flex min-w-0 flex-wrap gap-3 *:min-w-0 *:flex-[1_1_360px]">
              <BankPanel
                challengeId={challengeId}
                portfolio={portfolio}
                multiplier={
                  challenge.config.eden?.rules.loanRepayMultiplier ?? 2
                }
                endsAt={challenge.endsAt}
                carryRate={
                  challenge.config.eden?.rules.costOfCarryPerUnitPerMinute ?? 1
                }
                disabled={challenge.status !== "live"}
                onChange={() => setOrderRefresh((n) => n + 1)}
              />
              <VotePanel challengeId={challengeId} liveVote={rt.vote} />
            </div>
          )}

          {!isLg && leaderboard()}
        </div>

        {isXl && (
          <aside aria-label="News" className={cn(STICKY_SIDEBAR, "min-w-0")}>
            {newsFeed("h-full")}
          </aside>
        )}
      </main>

      {isEden && (
        <AuctionPopup
          state={auction}
          terms={challenge.config.eden}
          minimized={auctionMinimized}
          onMinimizedChange={setAuctionMinimized}
        />
      )}
      {isEden && <DealDesk offers={rt.otcOffers} result={rt.otcResult} />}
    </div>
  );
}
