import { z } from "zod";
import {
  zChallengeStatus,
  zChallengeType,
  zOrderSide,
  zOrderStatus,
  zOrderType,
  zRole,
} from "./domain.js";
import { zScoringConfig } from "./scoring.js";

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */
export const zRegisterInput = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_.-]+$/, "alphanumeric, dot, dash, underscore only"),
  displayName: z.string().min(1).max(64).optional(),
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
});
export type RegisterInput = z.infer<typeof zRegisterInput>;

export const zLoginInput = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof zLoginInput>;

export const zUserPublic = z.object({
  id: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  email: z.string(),
  role: zRole,
  createdAt: z.string(),
});
export type UserPublic = z.infer<typeof zUserPublic>;

export const zAuthResponse = z.object({
  token: z.string(),
  user: zUserPublic,
});
export type AuthResponse = z.infer<typeof zAuthResponse>;

/* ------------------------------------------------------------------ *
 * Challenge configuration
 * ------------------------------------------------------------------ */
export const zSymbolConfig = z.object({
  symbol: z
    .string()
    .min(1)
    .max(12)
    .regex(/^[A-Z0-9]+$/, "uppercase letters and digits only"),
  name: z.string().max(64).optional(),
  initialPrice: z.number().positive(),
  /** Random-walk volatility per autonomous tick, in price units. */
  volatility: z.number().min(0).default(0.5),
  /** Tick size for price increments. */
  tickSize: z.number().positive().default(0.01),
});
export type SymbolConfig = z.infer<typeof zSymbolConfig>;

/** Autonomous agents that trade alongside humans to keep markets alive. */
export const zBotConfig = z.object({
  /** Number of two-sided liquidity-providing market-maker bots. */
  marketMakers: z.number().int().min(0).max(10).default(0),
  /** Number of random taker-flow ("noise") bots. */
  noiseTraders: z.number().int().min(0).max(30).default(0),
  /** Target half-spread the MM bots quote around mid, in price units. */
  spread: z.number().min(0).default(0.5),
  /** Resting size per MM bot quote. */
  quoteSize: z.number().int().positive().default(5),
  /** Activity level 0..1; scales bot action frequency. */
  intensity: z.number().min(0).max(1).default(0.5),
});
export type BotConfig = z.infer<typeof zBotConfig>;

export const zChallengeConfig = z.object({
  symbols: z.array(zSymbolConfig).min(1).max(20),
  startingCash: z.number().default(0),
  minPosition: z.number().int().default(-50),
  maxPosition: z.number().int().default(50),
  maxOrderQuantity: z.number().int().positive().default(50),
  /** Max order requests per user per second (per challenge). */
  maxOrdersPerSecond: z.number().int().positive().default(5),
  /** Max sum of order quantities per user per minute (per challenge). */
  maxVolumePerMinute: z.number().int().positive().default(500),
  /** Allow cash balance to go negative (enables shorting/leverage). */
  allowMargin: z.boolean().default(true),
  /** Autonomous price engine enabled. */
  autonomousPrice: z.boolean().default(true),
  /** Optional autonomous trading agents. */
  bots: zBotConfig.optional(),
});
export type ChallengeConfig = z.infer<typeof zChallengeConfig>;

export const zCreateChallengeInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  type: zChallengeType,
  config: zChallengeConfig,
  scoring: zScoringConfig.optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
});
export type CreateChallengeInput = z.infer<typeof zCreateChallengeInput>;

export const zUpdateChallengeInput = zCreateChallengeInput.partial();
export type UpdateChallengeInput = z.infer<typeof zUpdateChallengeInput>;

export const zChallenge = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  type: zChallengeType,
  status: zChallengeStatus,
  config: zChallengeConfig,
  scoring: zScoringConfig,
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  createdAt: z.string(),
  participantCount: z.number().int().optional(),
});
export type Challenge = z.infer<typeof zChallenge>;

/* ------------------------------------------------------------------ *
 * Orders
 * ------------------------------------------------------------------ */
export const zPlaceOrderInput = z.object({
  challengeId: z.string().uuid(),
  symbol: z.string(),
  side: zOrderSide,
  type: zOrderType.default("limit"),
  quantity: z.number().int().positive(),
  /** Required for limit orders. */
  price: z.number().positive().optional(),
});
export type PlaceOrderInput = z.infer<typeof zPlaceOrderInput>;

export const zOrder = z.object({
  id: z.string().uuid(),
  challengeId: z.string().uuid(),
  userId: z.string().uuid(),
  symbol: z.string(),
  side: zOrderSide,
  type: zOrderType,
  quantity: z.number().int(),
  remainingQuantity: z.number().int(),
  price: z.number().nullable(),
  status: zOrderStatus,
  createdAt: z.string(),
});
export type Order = z.infer<typeof zOrder>;

/* ------------------------------------------------------------------ *
 * Market data
 * ------------------------------------------------------------------ */
export const zPriceLevel = z.object({
  price: z.number(),
  quantity: z.number().int(),
  orders: z.number().int(),
});
export type PriceLevel = z.infer<typeof zPriceLevel>;

export const zOrderBookSnapshot = z.object({
  symbol: z.string(),
  bids: z.array(zPriceLevel),
  asks: z.array(zPriceLevel),
  sequence: z.number().int(),
});
export type OrderBookSnapshot = z.infer<typeof zOrderBookSnapshot>;

export const zPricePoint = z.object({
  symbol: z.string(),
  price: z.number(),
  change: z.number(),
  timestamp: z.number(),
});
export type PricePoint = z.infer<typeof zPricePoint>;

/* ------------------------------------------------------------------ *
 * Portfolio & leaderboard
 * ------------------------------------------------------------------ */
export const zPosition = z.object({
  symbol: z.string(),
  quantity: z.number().int(),
  avgPrice: z.number(),
});
export type Position = z.infer<typeof zPosition>;

/** Per-trader performance metrics, surfaced in analytics and MM scoring. */
export const zTraderMetrics = z.object({
  /** Realized PnL from closed positions. */
  realizedPnl: z.number().default(0),
  /** Total filled quantity (abs), across maker + taker fills. */
  volume: z.number().default(0),
  /** Number of fills the trader participated in. */
  trades: z.number().int().default(0),
  /** Accumulated captured spread from passive (maker) fills. */
  spreadCapture: z.number().default(0),
  /** Seconds spent quoting valid two-sided markets. */
  quoteUptime: z.number().default(0),
  /** Sum of absolute inventory across symbols. */
  inventory: z.number().default(0),
});
export type TraderMetrics = z.infer<typeof zTraderMetrics>;

export const zPortfolio = z.object({
  challengeId: z.string().uuid(),
  cash: z.number(),
  positions: z.array(zPosition),
  marketValue: z.number(),
  pnl: z.number(),
  score: z.number(),
  metrics: zTraderMetrics.optional(),
});
export type Portfolio = z.infer<typeof zPortfolio>;

export const zLeaderboardEntry = z.object({
  rank: z.number().int(),
  userId: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  pnl: z.number(),
  score: z.number(),
  metrics: zTraderMetrics.optional(),
});
export type LeaderboardEntry = z.infer<typeof zLeaderboardEntry>;

/* ------------------------------------------------------------------ *
 * Live news (per-challenge admin announcements)
 * ------------------------------------------------------------------ */
export const zNewsLevel = z.enum(["info", "warning", "urgent"]);
export type NewsLevel = z.infer<typeof zNewsLevel>;

export const zNewsItem = z.object({
  id: z.string().uuid(),
  challengeId: z.string().uuid(),
  message: z.string().min(1).max(500),
  level: zNewsLevel,
  createdAt: z.string(),
  authorDisplayName: z.string().optional(),
});
export type NewsItem = z.infer<typeof zNewsItem>;

export const zPostNewsInput = z.object({
  message: z.string().min(1).max(500),
  level: zNewsLevel.default("info"),
});
export type PostNewsInput = z.infer<typeof zPostNewsInput>;
