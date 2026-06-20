import type { OrderSide, OrderStatus, OrderType } from "./domain.js";

/* ------------------------------------------------------------------ *
 * Commands: API -> Engine (per-challenge command stream)
 * ------------------------------------------------------------------ */
export type EngineCommand =
  | {
      type: "place_order";
      orderId: string;
      challengeId: string;
      userId: string;
      symbol: string;
      side: OrderSide;
      orderType: OrderType;
      quantity: number;
      price: number | null;
      ts: number;
    }
  | {
      type: "cancel_order";
      orderId: string;
      challengeId: string;
      userId: string;
      symbol: string;
      side: OrderSide;
      ts: number;
    }
  | {
      /** Autonomous price nudge produced by the engine's own clock. */
      type: "price_tick";
      challengeId: string;
      ts: number;
    };

/* ------------------------------------------------------------------ *
 * Events: Engine -> world (per-challenge event stream)
 * ------------------------------------------------------------------ */
export type TradeEvent = {
  type: "trade";
  challengeId: string;
  tradeId: string;
  symbol: string;
  price: number;
  quantity: number;
  /** Side of the aggressor (taker). */
  takerSide: OrderSide;
  buyOrderId: string;
  sellOrderId: string;
  buyerId: string;
  sellerId: string;
  ts: number;
};

export type OrderUpdateEvent = {
  type: "order_update";
  challengeId: string;
  orderId: string;
  userId: string;
  symbol: string;
  side: OrderSide;
  status: OrderStatus;
  quantity: number;
  remainingQuantity: number;
  price: number | null;
  ts: number;
};

export type BookUpdateEvent = {
  type: "book_update";
  challengeId: string;
  symbol: string;
  bids: Array<{ price: number; quantity: number; orders: number }>;
  asks: Array<{ price: number; quantity: number; orders: number }>;
  sequence: number;
  ts: number;
};

export type PriceUpdateEvent = {
  type: "price_update";
  challengeId: string;
  symbol: string;
  price: number;
  change: number;
  ts: number;
};

export type EngineEvent =
  | TradeEvent
  | OrderUpdateEvent
  | BookUpdateEvent
  | PriceUpdateEvent;

export type EngineEventType = EngineEvent["type"];
