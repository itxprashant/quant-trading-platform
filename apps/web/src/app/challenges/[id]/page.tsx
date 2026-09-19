"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, Wifi, WifiOff } from "lucide-react";
import type {
  Challenge,
  LeaderboardEntry,
  NewsItem,
  Portfolio,
  SymbolConfig,
} from "@qtp/shared";
import { ApiError, get } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useRealtime } from "@/hooks/useRealtime";
import { TopBar } from "@/components/TopBar";
import { Countdown } from "@/components/Countdown";
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
import { NewsTicker } from "@/components/trade/NewsTicker";
import { NewsPanel } from "@/components/trade/NewsPanel";
import { BankPanel } from "@/components/trade/BankPanel";
import { AlertStack } from "@/components/trade/AlertStack";
import { OptionsPanel } from "@/components/trade/OptionsPanel";
import { MarketsPanel } from "@/components/trade/MarketsPanel";
import { DealDesk } from "@/components/trade/DealDesk";
import { AuctionPanel } from "@/components/trade/AuctionPanel";
import { VotePanel } from "@/components/trade/VotePanel";
import { GrantBanner } from "@/components/trade/GrantBanner";
import { money, signed, dirClass } from "@/lib/format";
import { cn } from "@/lib/cn";

export default function TradePage() {
  const params = useParams<{ id: string }>();
  const challengeId = params.id;
  const user = useAuth((s) => s.user);

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

  const rt = useRealtime(challengeId);

  useEffect(() => {
    let cancelled = false;
    setChallenge(null);
    setLoadError(null);
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
  // Announcements ticker vs the separate market-news panel. Items without an
  // explicit feed (legacy) default to the announcements ticker.
  const announcements = news.filter(
    (n) => (n.feed ?? "announcement") === "announcement",
  );
  const marketNews = news.filter((n) => n.feed === "news");

  // Seed the limit price input when switching symbols.
  useEffect(() => {
    const p = rt.prices.get(activeSymbol)?.price;
    if (p != null && !limitPrice) setLimitPrice(p.toFixed(2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSymbol, rt.prices.get(activeSymbol)?.price]);

  const portfolio = rt.portfolio ?? restPortfolio;

  // Base config symbols plus any spot/ETF instruments introduced live.
  const tradableSymbols = useMemo<SymbolConfig[]>(() => {
    const base = challenge?.config.symbols ?? [];
    const extra = rt.listedSymbols
      .filter((s) => s.kind === "spot" || s.kind === "etf")
      .filter((s) => !base.some((b) => b.symbol === s.symbol))
      .map(({ kind: _kind, ...cfg }) => cfg);
    return [...base, ...extra];
  }, [challenge, rt.listedSymbols]);

  const activeCfg = tradableSymbols.find((s) => s.symbol === activeSymbol);
  const book = rt.books.get(activeSymbol);
  const livePrice = rt.prices.get(activeSymbol);

  const metric = challenge?.type === "market_making" ? "score" : "pnl";
  const isEden = challenge?.type === "new_eden";
  const hasOptions = isEden || rt.optionContracts.length > 0;
  const hasEtfs = isEden || rt.listedSymbols.some((s) => s.kind === "etf");

  const symbolStrip = useMemo(
    () =>
      tradableSymbols.map((s) => {
        const price = rt.prices.get(s.symbol)?.price ?? s.initialPrice;
        const change = (price - s.initialPrice) / s.initialPrice;
        return { symbol: s.symbol, name: s.name, price, change };
      }),
    [tradableSymbols, rt.prices],
  );

  if (loadError) {
    return (
      <div className="min-h-dvh">
        <TopBar />
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
        <TopBar />
        <main
          id="main"
          aria-busy="true"
          aria-label="Loading trading workbench"
          className="mx-auto max-w-[1600px] space-y-4 p-3 sm:p-5"
        >
          <span role="status" className="sr-only">
            Loading challenge and market data
          </span>
          <Skeleton className="h-16 w-64 max-w-full" />
          <Skeleton className="h-20 w-full" />
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
            <Skeleton className="h-[440px]" />
            <Skeleton className="h-[440px]" />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-64" />
            ))}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-dvh">
      <TopBar />

      {announcements.length > 0 && <NewsTicker items={announcements} />}

      {isEden && <GrantBanner grant={rt.grant} />}

      <AlertStack alerts={rt.alerts} />

      <main
        id="main"
        className="mx-auto min-w-0 max-w-[1600px] space-y-3 p-3 sm:p-5"
      >
        <header className="flex flex-wrap items-end justify-between gap-3 pb-2">
          <div className="min-w-0">
            <Link
              href="/challenges"
              className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-text"
            >
              <ChevronLeft className="size-3.5" aria-hidden /> All challenges
            </Link>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="break-words text-xl font-semibold tracking-tight sm:text-2xl">
                {challenge.name}
              </h1>
              <StatusBadge status={challenge.status} />
            </div>
            <p className="mt-1 text-xs text-muted">
              {isEden
                ? "New Eden"
                : challenge.type === "market_making"
                  ? "Market making"
                  : "Directional trading"}
              <span className="mx-2 text-faint" aria-hidden>
                /
              </span>
              {tradableSymbols.length} instruments
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs">
            {challenge.endsAt && challenge.status === "live" && (
              <div className="flex items-center gap-2 text-muted">
                <span>Time left</span>
                <Countdown target={challenge.endsAt} />
              </div>
            )}
            <span
              role="status"
              className={cn(
                "flex items-center gap-1.5",
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
        </header>
        {rt.status !== "open" && (
          <p className="rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted">
            Live prices may be delayed until the feed reconnects.
          </p>
        )}

        {/* Symbol strip */}
        <div
          role="group"
          aria-label="Select trading instrument"
          className="flex min-w-0 gap-1 overflow-x-auto rounded-lg border border-border bg-surface p-1"
        >
          {symbolStrip.map((s) => (
            <button
              type="button"
              key={s.symbol}
              aria-pressed={activeSymbol === s.symbol}
              aria-label={`${s.symbol}, ${s.name}, ${money(s.price)}, ${signed(s.change * 100)} percent since start`}
              onClick={() => {
                setActiveSymbol(s.symbol);
                setLimitPrice(s.price.toFixed(2));
              }}
              className={cn(
                "flex min-w-[164px] shrink-0 flex-col items-start gap-1 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
                activeSymbol === s.symbol
                  ? "border-accent/40 bg-accent-subtle"
                  : "border-transparent hover:bg-surface-2",
              )}
            >
              <span
                className={cn(
                  "text-xs font-semibold",
                  activeSymbol === s.symbol && "text-accent",
                )}
              >
                {s.symbol}
              </span>
              <div className="flex w-full items-baseline justify-between gap-3">
                <span className="mono text-sm">{money(s.price)}</span>
                <span className={cn("mono text-xs", dirClass(s.change))}>
                  {signed(s.change * 100)}%
                </span>
              </div>
            </button>
          ))}
        </div>

        {/* Keep market context and order entry together at laptop widths. */}
        <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_360px]">
          <Panel className="flex min-w-0 flex-col overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
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
              <div className="flex flex-wrap items-baseline gap-4">
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
                  <span className="mono text-xl font-medium">
                    {money(livePrice.price)}
                  </span>
                )}
              </div>
            </div>
            <div className="h-[320px] min-w-0 p-1 sm:h-[380px] lg:min-h-[400px] lg:flex-1">
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
            </div>
          </Panel>

          {activeCfg ? (
            <TradeTicket
              challengeId={challengeId}
              symbol={activeSymbol}
              maxQuantity={challenge?.config.maxOrderQuantity ?? 50}
              maxOpenOrders={challenge.config.maxOpenOrders ?? 25}
              refreshKey={orderRefresh}
              price={limitPrice}
              onPriceChange={setLimitPrice}
              refPrice={livePrice?.price}
            />
          ) : (
            <Panel className="grid min-h-48 place-items-center p-6 text-sm text-muted">
              Order entry opens when an instrument is listed.
            </Panel>
          )}
        </div>

        {/* Working market and account state stay directly below the ticket. */}
        <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-12">
          <div className="min-w-0 xl:col-span-4">
            <OrderBook
              snapshot={book}
              onPick={(p) => setLimitPrice(p.toFixed(2))}
            />
          </div>
          <div className="min-w-0 xl:col-span-4">
            <PortfolioPanel
              portfolio={portfolio}
              prices={rt.prices}
              mm={challenge.type === "market_making"}
            />
          </div>
          <div className="min-w-0 md:col-span-2 xl:col-span-4">
            <OpenOrders
              challengeId={challengeId}
              refreshKey={orderRefresh}
              maxOpenOrders={challenge.config.maxOpenOrders ?? 25}
            />
          </div>
        </div>

        <div
          className={cn(
            "grid min-w-0 gap-3 md:grid-cols-2",
            isEden && marketNews.length > 0 && "xl:grid-cols-3",
          )}
        >
          <div className="min-w-0">
            <Leaderboard
              entries={rt.leaderboard.length ? rt.leaderboard : restLeaderboard}
              meId={user?.id}
              metric={metric}
              mm={challenge?.type === "market_making"}
            />
          </div>
          {isEden && (
            <BankPanel
              challengeId={challengeId}
              portfolio={portfolio}
              multiplier={challenge.config.eden?.rules.loanRepayMultiplier ?? 2}
              onChange={() => setOrderRefresh((n) => n + 1)}
            />
          )}
          {marketNews.length > 0 && <NewsPanel items={marketNews} />}
        </div>

        {/* Derivatives & structured products (options/ETFs can be introduced
            live into any challenge type; auctions/votes stay New Eden). */}
        {(hasOptions || hasEtfs) && (
          <div className="grid gap-3 lg:grid-cols-2">
            {hasOptions && (
              <OptionsPanel
                challengeId={challengeId}
                contracts={rt.optionContracts}
                prices={rt.prices}
                onChange={() => setOrderRefresh((n) => n + 1)}
              />
            )}
            {hasEtfs && (
              <MarketsPanel
                challengeId={challengeId}
                onChange={() => setOrderRefresh((n) => n + 1)}
              />
            )}
          </div>
        )}
        {isEden && (
          <div className="grid gap-3 lg:grid-cols-2">
            <AuctionPanel
              challengeId={challengeId}
              liveAuction={rt.auction}
              liveWon={rt.auctionWon}
            />
            <VotePanel challengeId={challengeId} liveVote={rt.vote} />
          </div>
        )}
      </main>

      {isEden && <DealDesk offers={rt.otcOffers} />}
    </div>
  );
}
