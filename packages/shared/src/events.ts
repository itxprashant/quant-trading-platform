import type { OrderSide, OrderStatus, OrderType } from "./domain.js";
import type { FvEffect, OtcLeg } from "./schemas.js";

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
    }
  /* ---- New Eden host/trader commands ---- */
  | {
      /** Set a symbol's fair value absolutely (host control). */
      type: "set_fair_value";
      challengeId: string;
      symbol: string;
      fairValue: number;
      ts: number;
    }
  | {
      /** Apply additive FV deltas (signal news). */
      type: "apply_fv_delta";
      challengeId: string;
      effects: FvEffect[];
      ts: number;
    }
  | {
      /** Enable/disable trading on a symbol (dynamic asset unlock). */
      type: "set_tradeable";
      challengeId: string;
      symbol: string;
      tradeable: boolean;
      ts: number;
    }
  | {
      /** Issue a predatory loan to a trader. */
      type: "issue_loan";
      challengeId: string;
      userId: string;
      loanId: string;
      principal: number;
      ts: number;
    }
  | {
      /** Force-liquidate a trader at market (margin breach / assignment). */
      type: "force_liquidate";
      challengeId: string;
      userId: string;
      reason: string;
      ts: number;
    }
  | {
      /** Settle a binding OTC deal (multi-leg atomic transfer). */
      type: "execute_otc";
      challengeId: string;
      offerId: string;
      userId: string;
      legs: OtcLeg[];
      cashToTrader: number;
      ts: number;
    }
  | {
      /** Open an option cycle for an underlying. */
      type: "open_option_cycle";
      challengeId: string;
      cycleId: string;
      underlying: string;
      strikes: number[];
      expiresAt: number;
      ts: number;
    }
  | {
      /** Close an option cycle (begins exercise window). */
      type: "close_option_cycle";
      challengeId: string;
      cycleId: string;
      ts: number;
    }
  | {
      /** Trader exercises an option series. */
      type: "exercise_option";
      challengeId: string;
      userId: string;
      symbol: string;
      quantity: number;
      ts: number;
    }
  | {
      /** Trader buys a bond from the bank. */
      type: "purchase_bond";
      challengeId: string;
      userId: string;
      bondId: string;
      quantity: number;
      ts: number;
    }
  | {
      /** Open an ETF create/redeem window. */
      type: "etf_window";
      challengeId: string;
      etfSymbol: string;
      open: boolean;
      ts: number;
    }
  | {
      /** Trader creates or redeems ETF units against the basket. */
      type: "etf_trade";
      challengeId: string;
      userId: string;
      etfSymbol: string;
      action: "create" | "redeem";
      quantity: number;
      ts: number;
    }
  | {
      /** Redistribute wealth (solidarity tax) from top to bottom. */
      type: "apply_wealth_tax";
      challengeId: string;
      ratePct: number;
      topPct: number;
      bottomPct: number;
      ts: number;
    }
  | {
      /** Award a government grant to the largest holder of a symbol. */
      type: "award_grant";
      challengeId: string;
      grantId: string;
      symbol: string;
      prize: number;
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

/* ---- New Eden events ---- */
export type FairValueEvent = {
  type: "fair_value";
  challengeId: string;
  symbol: string;
  fairValue: number;
  ts: number;
};

export type MarginCallEvent = {
  type: "margin_call";
  challengeId: string;
  userId: string;
  freeCash: number;
  liquidated: boolean;
  ts: number;
};

export type LoanEvent = {
  type: "loan_update";
  challengeId: string;
  userId: string;
  loanId: string;
  principal: number;
  remaining: number;
  status: "active" | "repaid";
  ts: number;
};

export type CarryChargeEvent = {
  type: "carry_charge";
  challengeId: string;
  userId: string;
  amount: number;
  ts: number;
};

export type OtcSettledEvent = {
  type: "otc_settled";
  challengeId: string;
  offerId: string;
  userId: string;
  ts: number;
};

export type OptionEvent = {
  type: "option_assigned" | "option_exercised";
  challengeId: string;
  userId: string;
  symbol: string;
  quantity: number;
  ts: number;
};

export type GrantAwardedEvent = {
  type: "grant_awarded";
  challengeId: string;
  grantId: string;
  userId: string | null;
  symbol: string;
  prize: number;
  ts: number;
};

export type WealthTaxEvent = {
  type: "wealth_tax";
  challengeId: string;
  redistributed: number;
  ts: number;
};

/** Generic targeted alert for a single trader (margin warning, breach…). */
export type AlertEvent = {
  type: "alert";
  challengeId: string;
  userId: string;
  level: "info" | "warning" | "urgent";
  message: string;
  ts: number;
};

export type EngineEvent =
  | TradeEvent
  | OrderUpdateEvent
  | BookUpdateEvent
  | PriceUpdateEvent
  | FairValueEvent
  | MarginCallEvent
  | LoanEvent
  | CarryChargeEvent
  | OtcSettledEvent
  | OptionEvent
  | GrantAwardedEvent
  | WealthTaxEvent
  | AlertEvent;

export type EngineEventType = EngineEvent["type"];
