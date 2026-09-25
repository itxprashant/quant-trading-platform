"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import type {
  Auction,
  EtfWindowClock,
  GrantMission,
  LeaderboardEntry,
  NewsItem,
  OptionContract,
  OrderBookSnapshot,
  OtcOffer,
  Portfolio,
  PricePoint,
  ServerMessage,
  SymbolConfig,
  TraderVisibility,
  VoteProposal,
} from "@qtp/shared";
import { TOKEN_KEY, WS_URL } from "@/lib/config";
import { get } from "@/lib/api";
import { applyPortfolioUpdate } from "@/lib/portfolio";

export interface TradePrint {
  symbol: string;
  price: number;
  quantity: number;
  takerSide: "buy" | "sell";
  ts: number;
}

export interface OrderEvent {
  orderId: string;
  symbol: string;
  side: "buy" | "sell";
  status: string;
  remainingQuantity: number;
  ts: number;
}

export interface AlertMsg {
  id: string;
  level: "info" | "warning" | "urgent";
  message: string;
  ts: number;
}

const NEWS_MAX = 50;
const ALERT_MAX = 8;

export interface RealtimeState {
  status: "connecting" | "open" | "closed";
  prices: Map<string, PricePoint>;
  books: Map<string, OrderBookSnapshot>;
  trades: TradePrint[];
  portfolio: Portfolio | null;
  leaderboard: LeaderboardEntry[];
  /** null until the gateway reports the host's visibility setting. */
  leaderboardHidden: boolean | null;
  /** null until the gateway reports which Eden panels traders may see. */
  traderVisibility: TraderVisibility | null;
  news: NewsItem[];
  /** Latest headline delivered live (never from a snapshot); drives toasts. */
  lastNews: { item: NewsItem; seq: number } | null;
  lastOrder: OrderEvent | null;
  /** Targeted trader alerts (margin warnings, liquidations, deal pushes). */
  alerts: AlertMsg[];
  /** New Eden: published fair value per symbol. */
  fairValues: Map<string, number>;
  /** New Eden: live option contracts in the current cycle(s). */
  optionContracts: OptionContract[];
  /** New Eden: pending Deal Desk offers addressed to this trader. */
  otcOffers: OtcOffer[];
  otcResult: Extract<ServerMessage, { type: "otc_result" }>["data"] | null;
  /** New Eden: current premium-feed blind auction (open or resolved). */
  auction: Auction | null;
  /** New Eden: whether this trader won premium access in the latest auction. */
  auctionWon: boolean;
  /** New Eden: current policy vote proposal. */
  vote: VoteProposal | null;
  /** New Eden: current government grant mission. */
  grant: GrantMission | null;
  /** Instruments introduced live (spot/ETF/option) after the initial config. */
  listedSymbols: Array<SymbolConfig & { kind: "spot" | "etf" | "option" }>;
  /** Live ETF create/redeem window clock for the navbar timer. */
  etfWindow: EtfWindowClock | null;
  /** null until the gateway snapshot or a freeze toggle arrives. */
  frozen: boolean | null;
}

type Action =
  | { t: "reset" }
  | { t: "restore"; v: Partial<RealtimeState> }
  | { t: "status"; v: RealtimeState["status"] }
  | { t: "msg"; v: ServerMessage };

function reducer(state: RealtimeState, action: Action): RealtimeState {
  if (action.t === "reset") return initial;
  if (action.t === "restore") return { ...state, ...action.v };
  if (action.t === "status") return { ...state, status: action.v };
  const msg = action.v;
  switch (msg.type) {
    case "price": {
      const prices = new Map(state.prices);
      prices.set(msg.data.symbol, msg.data);
      return { ...state, prices };
    }
    case "book": {
      const books = new Map(state.books);
      books.set(msg.data.symbol, msg.data);
      return { ...state, books };
    }
    case "trade": {
      const trades = [msg.data, ...state.trades].slice(0, 50);
      return { ...state, trades };
    }
    case "portfolio":
      return {
        ...state,
        portfolio: applyPortfolioUpdate(state.portfolio, msg.data),
      };
    case "leaderboard":
      return { ...state, leaderboard: msg.data };
    case "leaderboard_visibility":
      return { ...state, leaderboardHidden: msg.data.hidden };
    case "trader_visibility":
      return { ...state, traderVisibility: msg.data };
    case "news": {
      // Premium holders receive a scripted headline early and again at release.
      const seen = state.news.some((n) => n.id === msg.data.id);
      return {
        ...state,
        news: [
          msg.data,
          ...state.news.filter((n) => n.id !== msg.data.id),
        ].slice(0, NEWS_MAX),
        lastNews: seen
          ? state.lastNews
          : { item: msg.data, seq: (state.lastNews?.seq ?? 0) + 1 },
      };
    }
    case "news_feed":
      return { ...state, news: msg.data.slice(0, NEWS_MAX) };
    case "order":
      return { ...state, lastOrder: msg.data };
    case "fair_value": {
      const fairValues = new Map(state.fairValues);
      fairValues.set(msg.data.symbol, msg.data.fairValue);
      return { ...state, fairValues };
    }
    case "alert": {
      const alert: AlertMsg = {
        id: `${msg.data.ts}:${msg.data.message}`,
        level: msg.data.level,
        message: msg.data.message,
        ts: msg.data.ts,
      };
      return { ...state, alerts: [alert, ...state.alerts].slice(0, ALERT_MAX) };
    }
    case "margin_call": {
      const id = msg.data.liquidated ? "mc:flat" : "mc:warn";
      const alert: AlertMsg = {
        id,
        level: "urgent",
        message: msg.data.liquidated
          ? `Margin call — positions liquidated (free cash $${msg.data.freeCash.toFixed(0)}).`
          : `Margin warning — free cash $${msg.data.freeCash.toFixed(0)}.`,
        ts: msg.data.ts,
      };
      return {
        ...state,
        alerts: [alert, ...state.alerts.filter((a) => a.id !== id)].slice(
          0,
          ALERT_MAX,
        ),
      };
    }
    case "option_cycle":
      return { ...state, optionContracts: msg.data.contracts };
    case "otc_offer":
      return {
        ...state,
        otcOffers: [
          msg.data,
          ...state.otcOffers.filter((o) => o.id !== msg.data.id),
        ],
      };
    case "otc_result":
      return {
        ...state,
        otcResult: msg.data,
        otcOffers: state.otcOffers.filter((o) => o.id !== msg.data.offerId),
      };
    case "auction":
      return {
        ...state,
        auction: msg.data,
        auctionWon:
          state.auction?.id === msg.data.id ? state.auctionWon : false,
      };
    case "auction_result":
      return {
        ...state,
        auctionWon: msg.data.won,
        auction: state.auction
          ? { ...state.auction, status: "resolved", cutoff: msg.data.cutoff }
          : state.auction,
      };
    case "vote":
      return { ...state, vote: msg.data };
    case "grant":
      return { ...state, grant: msg.data };
    case "etf_window":
      return { ...state, etfWindow: msg.data };
    case "market_status":
      return { ...state, frozen: msg.data.frozen };
    case "symbol_listed": {
      const { config, kind } = msg.data;
      if (state.listedSymbols.some((s) => s.symbol === config.symbol)) {
        return state;
      }
      return {
        ...state,
        listedSymbols: [...state.listedSymbols, { ...config, kind }],
      };
    }
    default:
      return state;
  }
}

const initial: RealtimeState = {
  status: "connecting",
  prices: new Map(),
  books: new Map(),
  trades: [],
  portfolio: null,
  leaderboard: [],
  leaderboardHidden: null,
  traderVisibility: null,
  news: [],
  lastNews: null,
  lastOrder: null,
  alerts: [],
  fairValues: new Map(),
  optionContracts: [],
  otcOffers: [],
  otcResult: null,
  auction: null,
  auctionWon: false,
  vote: null,
  grant: null,
  listedSymbols: [],
  etfWindow: null,
  frozen: null,
};

export function useRealtime(
  challengeId: string | null,
  recoverEden = false,
): RealtimeState {
  const [state, dispatch] = useReducer(reducer, initial);
  const wsRef = useRef<WebSocket | null>(null);
  const [, force] = useState(0);
  const revisions = useRef({ options: 0, otc: 0, grant: 0, vote: 0 });

  useEffect(() => {
    if (!challengeId) return;
    dispatch({ t: "reset" });
    let closed = false;
    let attempts = 0;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let bookFlush: ReturnType<typeof setTimeout> | undefined;
    const pendingBooks = new Map<string, ServerMessage>();

    function flushBooks() {
      bookFlush = undefined;
      for (const m of pendingBooks.values()) dispatch({ t: "msg", v: m });
      pendingBooks.clear();
    }

    function connect() {
      const token =
        typeof window !== "undefined"
          ? window.localStorage.getItem(TOKEN_KEY)
          : null;
      const url = `${WS_URL}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      dispatch({ t: "status", v: "connecting" });

      ws.onopen = () => {
        attempts = 0;
        dispatch({ t: "status", v: "open" });
        ws.send(JSON.stringify({ type: "subscribe", challengeId }));
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "ping" }));
        }, 25000);
      };

      ws.onmessage = (ev) => {
        if (closed) return;
        try {
          const msg = JSON.parse(ev.data as string) as ServerMessage;
          if (msg.type === "option_cycle") revisions.current.options++;
          if (msg.type === "otc_offer" || msg.type === "otc_result")
            revisions.current.otc++;
          if (msg.type === "grant") revisions.current.grant++;
          if (msg.type === "vote") revisions.current.vote++;
          // Bot cancel-replace can emit many book snapshots in one tick.
          // Keep only the latest per symbol and paint once the burst settles.
          if (msg.type === "book") {
            pendingBooks.set(msg.data.symbol, msg);
            if (!bookFlush) bookFlush = setTimeout(flushBooks, 0);
            return;
          }
          dispatch({ t: "msg", v: msg });
        } catch {
          /* ignore */
        }
      };

      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        if (closed) return;
        dispatch({ t: "status", v: "closed" });
        if (!closed) {
          attempts += 1;
          const delay = Math.min(1000 * 2 ** attempts, 15000);
          reconnectTimer = setTimeout(connect, delay);
        }
      };

      ws.onerror = () => ws.close();
    }

    connect();
    force((n) => n + 1);

    return () => {
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (bookFlush) clearTimeout(bookFlush);
      pendingBooks.clear();
      wsRef.current?.close();
    };
  }, [challengeId]);

  useEffect(() => {
    if (!challengeId) return;
    let cancelled = false;
    let loading = false;
    async function restore() {
      if (loading) return;
      loading = true;
      const started = { ...revisions.current };
      await Promise.allSettled([
        get<{ contracts: OptionContract[] }>(
          `/api/options/${challengeId}`,
        ).then((v) => {
          if (!cancelled && started.options === revisions.current.options)
            dispatch({ t: "restore", v: { optionContracts: v.contracts } });
        }),
        recoverEden &&
          get<OtcOffer[]>(`/api/otc/${challengeId}`).then((v) => {
            if (!cancelled && started.otc === revisions.current.otc)
              dispatch({ t: "restore", v: { otcOffers: v } });
          }),
        recoverEden &&
          get<{
            proposal: VoteProposal | null;
            grant: GrantMission | null;
          }>(`/api/votes/${challengeId}`).then((v) => {
            if (cancelled) return;
            const patch: Partial<RealtimeState> = {};
            if (started.grant === revisions.current.grant) patch.grant = v.grant;
            if (started.vote === revisions.current.vote) patch.vote = v.proposal;
            if (Object.keys(patch).length) dispatch({ t: "restore", v: patch });
          }),
      ]);
      loading = false;
    }
    void restore();
    const timer = setInterval(restore, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [challengeId, state.status, recoverEden]);

  return state;
}
