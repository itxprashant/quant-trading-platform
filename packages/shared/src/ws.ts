import type {
  Auction,
  GrantMission,
  LeaderboardEntry,
  Loan,
  NewsItem,
  OptionContract,
  OrderBookSnapshot,
  OtcOffer,
  Portfolio,
  PricePoint,
  SymbolConfig,
  TraderVisibility,
  VoteProposal,
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
  | { type: "news_feed"; challengeId: string; data: NewsItem[] }
  /* ---- New Eden real-time messages ---- */
  | {
      type: "fair_value";
      challengeId: string;
      data: { symbol: string; fairValue: number; ts: number };
    }
  | {
      type: "margin_call";
      challengeId: string;
      data: { freeCash: number; liquidated: boolean; ts: number };
    }
  | { type: "loan"; challengeId: string; data: Loan }
  | {
      type: "alert";
      challengeId: string;
      data: {
        level: "info" | "warning" | "urgent";
        message: string;
        ts: number;
      };
    }
  | {
      type: "market_status";
      challengeId: string;
      data: { frozen: boolean };
    }
  | {
      /** Host toggled whether non-admins may see rankings. */
      type: "leaderboard_visibility";
      challengeId: string;
      data: { hidden: boolean };
    }
  | {
      /** Host toggled which Eden panels traders may see. */
      type: "trader_visibility";
      challengeId: string;
      data: TraderVisibility;
    }
  | { type: "otc_offer"; challengeId: string; data: OtcOffer }
  | {
      type: "otc_result";
      challengeId: string;
      data: { offerId: string; status: OtcOffer["status"]; ts: number };
    }
  | { type: "auction"; challengeId: string; data: Auction }
  | {
      type: "auction_result";
      challengeId: string;
      data: { auctionId: string; cutoff: number | null; won: boolean; ts: number };
    }
  | { type: "vote"; challengeId: string; data: VoteProposal }
  | { type: "grant"; challengeId: string; data: GrantMission }
  | {
      type: "option_cycle";
      challengeId: string;
      data: { contracts: OptionContract[]; ts: number };
    }
  | {
      /** A new tradable instrument was introduced into a live challenge. */
      type: "symbol_listed";
      challengeId: string;
      data: {
        config: SymbolConfig;
        /** Instrument family for UI grouping. */
        kind: "spot" | "etf" | "option";
        /** Whether the symbol is locked (untradeable) at listing time. */
        locked: boolean;
        ts: number;
      };
    };

export type ServerMessageType = ServerMessage["type"];

/**
 * Pub/sub envelope used between the engine and gateway nodes. `target` is
 * either "all" (every subscriber of the challenge) or a specific user id.
 */
export interface BroadcastEnvelope {
  target: "all" | string;
  msg: ServerMessage;
}
