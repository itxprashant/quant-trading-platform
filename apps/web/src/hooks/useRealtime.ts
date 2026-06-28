"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import type {
  LeaderboardEntry,
  NewsItem,
  OptionContract,
  OrderBookSnapshot,
  OtcOffer,
  Portfolio,
  PricePoint,
  ServerMessage,
} from "@qtp/shared";
import { TOKEN_KEY, WS_URL } from "@/lib/config";

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
  news: NewsItem[];
  lastOrder: OrderEvent | null;
  /** Targeted trader alerts (margin warnings, liquidations, deal pushes). */
  alerts: AlertMsg[];
  /** New Eden: published fair value per symbol. */
  fairValues: Map<string, number>;
  /** New Eden: live option contracts in the current cycle(s). */
  optionContracts: OptionContract[];
  /** New Eden: pending Deal Desk offers addressed to this trader. */
  otcOffers: OtcOffer[];
}

type Action =
  | { t: "status"; v: RealtimeState["status"] }
  | { t: "msg"; v: ServerMessage };

function reducer(state: RealtimeState, action: Action): RealtimeState {
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
      return { ...state, portfolio: msg.data };
    case "leaderboard":
      return { ...state, leaderboard: msg.data };
    case "news":
      return {
        ...state,
        news: [msg.data, ...state.news.filter((n) => n.id !== msg.data.id)].slice(
          0,
          NEWS_MAX,
        ),
      };
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
      const alert: AlertMsg = {
        id: `mc:${msg.data.ts}`,
        level: "urgent",
        message: msg.data.liquidated
          ? `Margin call — positions liquidated (free cash $${msg.data.freeCash.toFixed(0)}).`
          : `Margin warning — free cash $${msg.data.freeCash.toFixed(0)}.`,
        ts: msg.data.ts,
      };
      return { ...state, alerts: [alert, ...state.alerts].slice(0, ALERT_MAX) };
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
        otcOffers: state.otcOffers.filter((o) => o.id !== msg.data.offerId),
      };
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
  news: [],
  lastOrder: null,
  alerts: [],
  fairValues: new Map(),
  optionContracts: [],
  otcOffers: [],
};

export function useRealtime(challengeId: string | null): RealtimeState {
  const [state, dispatch] = useReducer(reducer, initial);
  const wsRef = useRef<WebSocket | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    if (!challengeId) return;
    let closed = false;
    let attempts = 0;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

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
        try {
          const msg = JSON.parse(ev.data as string) as ServerMessage;
          dispatch({ t: "msg", v: msg });
        } catch {
          /* ignore */
        }
      };

      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
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
      wsRef.current?.close();
    };
  }, [challengeId]);

  return state;
}
