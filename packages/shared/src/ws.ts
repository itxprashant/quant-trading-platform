import type {
  LeaderboardEntry,
  NewsItem,
  OrderBookSnapshot,
  Portfolio,
  PricePoint,
} from "./schemas.js";
import type { OrderSide, OrderStatus } from "./domain.js";

/* ------------------------------------------------------------------ *
 * Client -> Server
 * ------------------------------------------------------------------ */
export type ClientMessage =
  | { type: "subscribe"; challengeId: string }
  | { type: "unsubscribe"; challengeId: string }
  | { type: "ping" };

/* ------------------------------------------------------------------ *
 * Server -> Client
 * ------------------------------------------------------------------ */
export type ServerMessage =
  | { type: "pong" }
  | { type: "subscribed"; challengeId: string }
  | { type: "price"; challengeId: string; data: PricePoint }
  | {
      type: "prices";
      challengeId: string;
      data: PricePoint[];
    }
  | {
      type: "book";
      challengeId: string;
      data: OrderBookSnapshot;
    }
  | {
      type: "trade";
      challengeId: string;
      data: {
        symbol: string;
        price: number;
        quantity: number;
        takerSide: OrderSide;
        ts: number;
      };
    }
  | {
      type: "order";
      challengeId: string;
      data: {
        orderId: string;
        symbol: string;
        side: OrderSide;
        status: OrderStatus;
        remainingQuantity: number;
        ts: number;
      };
    }
  | { type: "portfolio"; challengeId: string; data: Portfolio }
  | { type: "leaderboard"; challengeId: string; data: LeaderboardEntry[] }
  | { type: "news"; challengeId: string; data: NewsItem }
  | { type: "news_feed"; challengeId: string; data: NewsItem[] };

export type ServerMessageType = ServerMessage["type"];

/**
 * Pub/sub envelope used between the engine and gateway nodes. `target` is
 * either "all" (every subscriber of the challenge) or a specific user id.
 */
export interface BroadcastEnvelope {
  target: "all" | string;
  msg: ServerMessage;
}
