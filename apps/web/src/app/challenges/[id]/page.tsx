"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ChevronLeft,
  LineChart,
  Trophy,
  Vote,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  isTraderPanelVisible,
  traderVisibilityOf,
  type Challenge,
  type LeaderboardEntry,
  type NewsItem,
  type OrderBookSnapshot,
  type Portfolio,
} from "@qtp/shared";
import { ApiError, get } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useRealtime } from "@/hooks/useRealtime";
import { useAuction } from "@/hooks/useAuction";
import { useChartVisible } from "@/hooks/useChartVisible";
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
import {
  MarketList,
  type MarketInstrument,
  type MarketKind,
} from "@/components/trade/MarketList";
import { DockPopup } from "@/components/trade/DockPopup";
import { NewsFeed, earlyLeadSec } from "@/components/trade/NewsFeed";
import { EventTimers } from "@/components/trade/EventTimers";
import { BankPanel } from "@/components/trade/BankPanel";
import { AlertStack, type NewsToast } from "@/components/trade/AlertStack";
import { OptionsPanel } from "@/components/trade/OptionsPanel";
import { MarketsPanel } from "@/components/trade/MarketsPanel";
import { BondPanel, useBondMarket } from "@/components/trade/BondPanel";
import { DealDesk } from "@/components/trade/DealDesk";
import { AuctionPopup } from "@/components/trade/AuctionPopup";
import { VotePanel } from "@/components/trade/VotePanel";
import { GrantBanner } from "@/components/trade/GrantBanner";
import { money, signed, dirClass } from "@/lib/format";
import { cn } from "@/lib/cn";

/** Desktop desk: page is viewport-locked; only the center column scrolls. */
const DESK_SHELL =
  "flex min-h-dvh flex-col lg:h-dvh lg:max-h-dvh lg:overflow-hidden";
const DESK_MAIN =
  "grid min-w-0 flex-1 gap-3 p-3 pb-14 sm:px-4 lg:min-h-0 lg:grid-cols-[232px_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)] lg:overflow-hidden lg:pb-3 xl:grid-cols-[232px_minmax(0,1fr)_260px] 2xl:grid-cols-[260px_minmax(0,1fr)_292px]";
const DESK_SIDE =
  "min-w-0 lg:h-full lg:min-h-0 lg:flex-col lg:gap-3 lg:overflow-hidden";
const DESK_CENTER =
  "@container min-w-0 space-y-3 lg:h-full lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:pb-14";

export default function TradePage() {
  const params = useParams<{ id: string }>();
  const challengeId = params.id;
  const user = useAuth((s) => s.user);
  const isAdmin = user?.role === "admin";

  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [activeSymbol, setActiveSymbol] = useState<string>("");
  const [activeKind, setActiveKind] = useState<MarketKind>("spot");
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

  const isEden = challenge?.type === "new_eden";
  const rt = useRealtime(challengeId, isEden);
  const vis = traderVisibilityOf(
    rt.traderVisibility ?? challenge?.traderVisibility,
  );
  const showPanel = (panel: Parameters<typeof isTraderPanelVisible>[1]) =>
    isTraderPanelVisible(vis, panel, isAdmin);
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
        setActiveKind("spot");
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
  }, [challengeId, activeSymbol, activeKind, rt.status]);

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
          early: Boolean(auction.premium && earlyLeadSec(last.item, now) != null),
          receivedAt: now,
        },
        ...toasts.filter((t) => t.item.id !== last.item.id),
      ].slice(0, 8),
    );
    setNewsReceivedAt((seen) => ({ ...seen, [last.item.id]: now }));
  }, [rt.lastNews, auction.premium]);

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
  const showBank = showPanel("bank");
  const showBonds = showPanel("bonds");
  const showEtfs = showPanel("etfs");
  const showOptions = showPanel("options");
  const showDealDesk = showPanel("dealDesk");
  const showVotes = showPanel("votes");
  const showAuctions = showPanel("auctions");
  const bonds = useBondMarket(challengeId, showBonds || isAdmin);

  // Sidebar list: spots, then ETFs / options when the host shows them.
  const instruments = useMemo<MarketInstrument[]>(() => {
    const base = challenge?.config.symbols ?? [];
    const rows: MarketInstrument[] = base.map((s) => ({
      kind: "spot" as const,
      symbol: s.symbol,
      name: s.name,
      initialPrice: s.initialPrice,
    }));
    if (showEtfs) {
      for (const e of challenge?.config.eden?.etfs ?? []) {
        if (rows.some((r) => r.symbol === e.symbol)) continue;
        rows.push({
          kind: "etf",
          symbol: e.symbol,
          name: e.name,
          initialPrice: e.basket.reduce(
            (sum, leg) =>
              sum +
              leg.weight *
                (base.find((s) => s.symbol === leg.symbol)?.initialPrice ?? 0),
            0,
          ),
        });
      }
      for (const s of rt.listedSymbols.filter((x) => x.kind === "etf")) {
        if (rows.some((r) => r.symbol === s.symbol)) continue;
        rows.push({
          kind: "etf",
          symbol: s.symbol,
          name: s.name,
          initialPrice: s.initialPrice,
        });
      }
    }
    for (const s of rt.listedSymbols.filter((x) => x.kind === "spot")) {
      if (rows.some((r) => r.symbol === s.symbol)) continue;
      rows.push({
        kind: "spot",
        symbol: s.symbol,
        name: s.name,
        initialPrice: s.initialPrice,
      });
    }
    if (showOptions) {
      for (const c of rt.optionContracts.filter((x) => x.status !== "expired")) {
        if (rows.some((r) => r.symbol === c.symbol)) continue;
        rows.push({
          kind: "option",
          symbol: c.symbol,
          name: c.underlying,
          initialPrice: 0,
          optionType: c.optionType,
          strike: c.strike,
        });
      }
    }
    return rows;
  }, [
    challenge,
    rt.listedSymbols,
    rt.optionContracts,
    showEtfs,
    showOptions,
  ]);

  useEffect(() => {
    const first = instruments[0];
    if (!first) return;
    if (instruments.some((r) => r.symbol === activeSymbol)) return;
    setActiveSymbol(first.symbol);
    setActiveKind(first.kind);
    setLimitPrice("");
  }, [instruments, activeSymbol]);

  const activeRow = instruments.find((s) => s.symbol === activeSymbol);
  const book =
    rt.books.get(activeSymbol) ??
    (restBook?.symbol === activeSymbol ? restBook : undefined);
  const livePrice = rt.prices.get(activeSymbol);

  const metric = challenge?.type === "market_making" ? "score" : "pnl";

  const selectInstrument = (row: MarketInstrument, price?: number) => {
    setActiveSymbol(row.symbol);
    setActiveKind(row.kind);
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
      <div className={DESK_SHELL}>
        <TopBar fluid className="shrink-0" />
        <main
          id="main"
          aria-busy="true"
          aria-label="Loading trading workbench"
          className={DESK_MAIN}
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
    activeRow && livePrice && activeRow.initialPrice > 0
      ? (livePrice.price - activeRow.initialPrice) / activeRow.initialPrice
      : null;
  const leaderboardEntries = rt.leaderboard.length
    ? rt.leaderboard
    : restLeaderboard;
  const myRank = leaderboardEntries.find((e) => e.userId === user?.id)?.rank;
  const voteOpen = rt.vote?.status === "open";

  const newsFeed = (className?: string) => (
    <NewsFeed
      items={news}
      receivedAt={newsReceivedAt}
      premium={auction.premium}
      className={className}
    />
  );
  const dealDesk = (className?: string) =>
    isEden && showDealDesk ? (
      <DealDesk
        docked
        offers={rt.otcOffers}
        result={rt.otcResult}
        className={className}
      />
    ) : null;
  const optionsTicket = (showBook: boolean) =>
    showOptions ? (
      <OptionsPanel
        challengeId={challengeId}
        contracts={rt.optionContracts}
        prices={rt.prices}
        books={rt.books}
        portfolio={portfolio}
        activeSymbol={activeSymbol}
        showBook={showBook}
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
          scripted && activeKind === "spot"
            ? "Options open after halftime, at game minute 70."
            : undefined
        }
      />
    ) : null;
  const marketsTicket = (
    <MarketsPanel
      challengeId={challengeId}
      activeSymbol={activeSymbol}
      activeKind={activeKind}
      onChange={() => {
        void bonds.reload();
        setOrderRefresh((n) => n + 1);
      }}
      frozen={marketFrozen || challenge.status !== "live"}
    />
  );

  return (
    <div className={DESK_SHELL}>
      <TopBar
        fluid
        className="shrink-0"
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
        className={DESK_MAIN}
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
                {instruments.length} instruments
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
          aria-label="Markets"
          className={cn(DESK_SIDE, "lg:flex lg:overflow-visible")}
        >
          <MarketList
            instruments={instruments}
            prices={rt.prices}
            portfolio={portfolio}
            active={activeSymbol}
            onSelect={selectInstrument}
            className="max-h-72 lg:max-h-none lg:min-h-0 lg:flex-1"
          />
          {isEden && showBank && (
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
              className="shrink-0"
            />
          )}
          {showVotes && rt.vote ? (
            <DockPopup
              label="Policy vote"
              placement="end"
              className="shrink-0"
              openSignal={voteOpen ? rt.vote?.id : null}
              icon={<Vote className="size-3.5" aria-hidden />}
              badge={
                voteOpen ? (
                  <span className="absolute -right-1 -top-1 size-2 rounded-full bg-warning" />
                ) : null
              }
            >
              <VotePanel
                challengeId={challengeId}
                liveVote={rt.vote}
                className="shadow-md"
              />
            </DockPopup>
          ) : null}
        </aside>

        <div className={DESK_CENTER}>
          <Panel className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">
                {activeKind === "option" && activeRow?.strike != null
                  ? `${activeRow.name ?? activeSymbol} ${activeRow.strike}`
                  : activeSymbol || "No instrument selected"}
              </h2>
              {activeRow?.name && activeKind !== "option" && (
                <span className="block truncate text-xs text-muted">
                  {activeRow.name}
                </span>
              )}
              {activeKind === "option" && (
                <span className="block truncate text-xs text-muted">
                  {activeRow?.optionType === "put" ? "Put" : "Call"}
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
            </div>
          </Panel>

          {/* Book, account and ticket share a row once the column is wide
              enough; below that the portfolio drops under book + ticket. */}
          <div className="grid min-w-0 gap-3 @min-[560px]:grid-cols-2 @min-[832px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_280px]">
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
                activeSymbol={activeSymbol}
                mm={challenge.type === "market_making"}
              />
            </div>
            <div className="order-2 min-w-0 @min-[832px]:order-none">
              {activeKind === "option" ? (
                optionsTicket(false)
              ) : activeRow ? (
                <div className="space-y-3">
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
                  {activeKind === "etf" ? marketsTicket : null}
                </div>
              ) : (
                <Panel className="grid h-full min-h-48 place-items-center p-6 text-center text-sm text-muted">
                  Order entry opens when an instrument is listed.
                </Panel>
              )}
            </div>
          </div>

          <OpenOrders
            challengeId={challengeId}
            refreshKey={orderRefresh}
            maxOpenOrders={challenge.config.maxOpenOrders ?? 25}
          />

          <div className="flex min-h-0 flex-col gap-3 xl:hidden">
            {newsFeed("max-h-[360px]")}
            {dealDesk("max-h-[320px]")}
          </div>

          {activeKind === "spot" ? optionsTicket(true) : null}
          {isEden && showBonds && (
            <BondPanel
              challengeId={challengeId}
              templates={bonds.templates}
              holdings={bonds.holdings}
              portfolio={portfolio}
              endsAt={challenge.endsAt}
              refreshError={bonds.error}
              onChange={() => {
                void bonds.reload();
                setOrderRefresh((n) => n + 1);
              }}
              frozen={marketFrozen || challenge.status !== "live"}
            />
          )}

          <Panel className="min-w-0 overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-2.5">
              <h2 className="text-xs font-medium tracking-wide text-muted">
                Chart
              </h2>
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
                {chartVisible ? "Hide" : "Show"}
              </button>
            </div>
            {chartVisible ? (
              <div className="h-[360px] border-t border-border p-1 2xl:h-[440px]">
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
            ) : null}
          </Panel>
        </div>

        <aside
          aria-label="News and deal desk"
          className={cn("hidden xl:flex", DESK_SIDE)}
        >
          {newsFeed("min-h-0 flex-1")}
          {dealDesk("min-h-0 max-h-[42%] shrink")}
        </aside>
      </main>

      <div className="fixed bottom-3 left-3 z-40">
        <DockPopup
          label="Leaderboard"
          icon={<Trophy className="size-3.5" aria-hidden />}
          badge={
            myRank != null && !(leaderboardHidden && !isAdmin) ? (
              <span className="absolute -right-1.5 -top-1.5 mono rounded-sm bg-surface-3 px-1 text-[10px] tabular-nums text-text">
                {myRank}
              </span>
            ) : null
          }
        >
          <Leaderboard
            entries={leaderboardEntries}
            meId={user?.id}
            metric={metric}
            mm={challenge.type === "market_making"}
            hidden={leaderboardHidden}
            isAdmin={isAdmin}
            className="max-h-[min(480px,70dvh)] shadow-md"
          />
        </DockPopup>
      </div>

      {isEden && showAuctions && (
        <AuctionPopup
          state={auction}
          terms={challenge.config.eden}
          minimized={auctionMinimized}
          onMinimizedChange={setAuctionMinimized}
        />
      )}
    </div>
  );
}
