import { z } from "zod";

/** User roles. Admins manage challenges; traders compete. */
export const Role = {
  Trader: "trader",
  Admin: "admin",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const OrderSide = {
  Buy: "buy",
  Sell: "sell",
} as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

export const OrderType = {
  Limit: "limit",
  Market: "market",
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export const OrderStatus = {
  Open: "open",
  PartiallyFilled: "partially_filled",
  Filled: "filled",
  Cancelled: "cancelled",
  Rejected: "rejected",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const ChallengeType = {
  /** Score = realized + unrealized PnL. Classic competition. */
  Directional: "directional",
  /** Score rewards spread capture, quote uptime, penalizes inventory. */
  MarketMaking: "market_making",
} as const;
export type ChallengeType = (typeof ChallengeType)[keyof typeof ChallengeType];

export const ChallengeStatus = {
  Draft: "draft",
  Scheduled: "scheduled",
  Live: "live",
  Paused: "paused",
  Ended: "ended",
} as const;
export type ChallengeStatus =
  (typeof ChallengeStatus)[keyof typeof ChallengeStatus];

export const zRole = z.enum([Role.Trader, Role.Admin]);
export const zOrderSide = z.enum([OrderSide.Buy, OrderSide.Sell]);
export const zOrderType = z.enum([OrderType.Limit, OrderType.Market]);
export const zOrderStatus = z.enum([
  OrderStatus.Open,
  OrderStatus.PartiallyFilled,
  OrderStatus.Filled,
  OrderStatus.Cancelled,
  OrderStatus.Rejected,
]);
export const zChallengeType = z.enum([
  ChallengeType.Directional,
  ChallengeType.MarketMaking,
]);
export const zChallengeStatus = z.enum([
  ChallengeStatus.Draft,
  ChallengeStatus.Scheduled,
  ChallengeStatus.Live,
  ChallengeStatus.Paused,
  ChallengeStatus.Ended,
]);
