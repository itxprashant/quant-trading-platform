"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import type {
  LeaderboardEntry,
  NewsItem,
  OrderBookSnapshot,
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

const NEWS_MAX = 50;

export interface RealtimeState {
  status: "connecting" | "open" | "closed";
  prices: Map<string, PricePoint>;
  books: Map<string, OrderBookSnapshot>;
  trades: TradePrint[];
  portfolio: Portfolio | null;
  leaderboard: LeaderboardEntry[];
  news: NewsItem[];
  lastOrder: OrderEvent | null;
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
