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

/* ------------------------------------------------------------------ *
 * New Eden Exchange — extended tournament configuration
 *
 * Everything in comp_desc.txt is a host-operated capability. The `eden`
 * block on a challenge's config opts a challenge into the extended economy
 * (margin/loans, cost of carry, fair value, options/bonds/ETF, OTC,
 * auctions, votes, grants). `directional` / `market_making` challenges
 * ignore it entirely.
 * ------------------------------------------------------------------ */

/** Economic rules of the New Eden bank. */
export const zEdenRules = z.object({
  /** Master switch — when false the challenge behaves like directional. */
  enabled: z.boolean().default(true),
  /** Holding fee charged per |unit| of inventory per game-minute. */
  costOfCarryPerUnitPerMinute: z.number().min(0).default(1),
  /** Predatory loan repayment multiplier (comp_desc: borrow X, repay 2X). */
  loanRepayMultiplier: z.number().min(1).default(2),
  /** Free cash at or below this triggers a margin call. */
  marginCallThreshold: z.number().default(0),
  /** When true, a margin call force-liquidates the trader at market (IOC). */
  forcedLiquidation: z.boolean().default(true),
  /** Inventory hard cap (absolute) used for breach detection. */
  positionCap: z.number().int().positive().default(100),
});
export type EdenRules = z.infer<typeof zEdenRules>;

/** Four New Eden bot archetypes (Section 4 of comp_desc). */
export const zEdenBotConfig = z.object({
  /** HFT market makers quoting two-sided around fair value with skew. */
  hftMarketMakers: z.number().int().min(0).max(10).default(2),
  /** Momentum retail bots that chase news headlines. */
  momentumTraders: z.number().int().min(0).max(30).default(4),
  /** Vega snipers that buy volatility ahead of high-impact events. */
  vegaSnipers: z.number().int().min(0).max(10).default(0),
  /** Parity arbitrageurs enforcing put-call parity on options. */
  parityArbers: z.number().int().min(0).max(10).default(0),
  /** Base half-spread the HFT MMs quote around fair value. */
  spread: z.number().min(0).default(1),
  /** Resting size per MM quote. */
  quoteSize: z.number().int().positive().default(10),
  /** Activity level 0..1; scales action frequency for all archetypes. */
  intensity: z.number().min(0).max(1).default(0.5),
});
export type EdenBotConfig = z.infer<typeof zEdenBotConfig>;

/** A bond template the host can issue to traders. */
export const zBondTemplate = z.object({
  /** Stable identifier, e.g. "standard" or "aerium_pegged". */
  id: z.string().min(1).max(32),
  name: z.string().min(1).max(64),
  /** Purchase price per bond. */
  price: z.number().positive(),
  /** Redemption / face value paid at maturity. */
  faceValue: z.number().positive(),
  /** Fixed coupon paid every 5 game-minutes (mutually exclusive w/ peg). */
  couponPer5Min: z.number().min(0).optional(),
  /**
   * Pegged coupon: `(base - price(symbol)) / divisor` every 5 game-minutes.
   * Models comp_desc's Aerium-pegged yield bond.
   */
  peggedYield: z
    .object({
      symbol: z.string(),
      base: z.number(),
      divisor: z.number().positive(),
    })
    .optional(),
  /** Max bonds of this type a single trader may hold. */
  maxPerUser: z.number().int().positive().default(1),
});
export type BondTemplate = z.infer<typeof zBondTemplate>;

/** A single component of an ETF basket. */
export const zEtfComponent = z.object({
  symbol: z.string(),
  weight: z.number().int().positive(),
});

/** An ETF whose NAV tracks a weighted spot basket (Orbital ETF). */
export const zEtfConfig = z.object({
  symbol: z
    .string()
    .min(1)
    .max(12)
    .regex(/^[A-Z0-9]+$/, "uppercase letters and digits only"),
  name: z.string().max(64).optional(),
  basket: z.array(zEtfComponent).min(1).max(10),
});
export type EtfConfig = z.infer<typeof zEtfConfig>;

/** Options market configuration (Session 2 of comp_desc). */
export const zEdenOptionsConfig = z.object({
  enabled: z.boolean().default(false),
  /** Underlying spot symbols on which option cycles can be opened. */
  underlyings: z.array(z.string()).default([]),
  /** Default cycle length in game-minutes. */
  cycleMinutes: z.number().int().positive().default(5),
  /** Exercise window (seconds) after a cycle closes. */
  exerciseWindowSec: z.number().int().positive().default(15),
});
export type EdenOptionsConfig = z.infer<typeof zEdenOptionsConfig>;

export const zEdenConfig = z.object({
  rules: zEdenRules.default({}),
  bots: zEdenBotConfig.optional(),
  options: zEdenOptionsConfig.optional(),
  /** Bond templates the host can issue. */
  bonds: z.array(zBondTemplate).max(8).optional(),
  /** ETFs available for create/redeem. */
  etfs: z.array(zEtfConfig).max(8).optional(),
  /** Auction round duration (seconds) for the premium feed. */
  auctionDurationSec: z.number().int().positive().default(30),
  /** Fraction (0..1) of bidders who win premium access. */
  auctionWinnerFraction: z.number().min(0).max(1).default(0.3),
  /** Premium feed early-access lead time (seconds). */
  premiumLeadSec: z.number().int().positive().default(10),
  /** Premium access duration (minutes) after winning an auction. */
  premiumAccessMinutes: z.number().int().positive().default(15),
});
export type EdenConfig = z.infer<typeof zEdenConfig>;

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
  /** New Eden extended economy (only consulted for `new_eden` challenges). */
  eden: zEdenConfig.optional(),
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

/** A predatory loan issued by the bank (referenced by Portfolio). */
export const zLoan = z.object({
  id: z.string().uuid(),
  challengeId: z.string().uuid(),
  userId: z.string().uuid(),
  principal: z.number(),
  /** Total amount owed (principal × multiplier). */
  totalRepay: z.number(),
  /** Amount still outstanding. */
  remaining: z.number(),
  status: z.enum(["active", "repaid"]),
  createdAt: z.string(),
});
export type Loan = z.infer<typeof zLoan>;

/** A bond a trader holds (referenced by Portfolio). */
export const zBondHolding = z.object({
  bondId: z.string(),
  name: z.string(),
  quantity: z.number().int(),
  price: z.number(),
  faceValue: z.number(),
  /** Total coupons received so far. */
  couponsPaid: z.number(),
});
export type BondHolding = z.infer<typeof zBondHolding>;

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
  /* ---- New Eden extensions (present only for new_eden challenges) ---- */
  /** Outstanding loan debt (sum of remaining across active loans). */
  loanDebt: z.number().optional(),
  /** freeCash = cash + marketValue − loanDebt. */
  freeCash: z.number().optional(),
  /** Active loans. */
  loans: z.array(zLoan).optional(),
  /** Bonds held off-book. */
  bonds: z.array(zBondHolding).optional(),
  /** Whether the trader currently holds premium news access. */
  premium: z.boolean().optional(),
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

/**
 * News classification (comp_desc Section 3.1). `signal` headlines move fair
 * value; `noise` headlines look identical but carry no real information.
 * Traders are not shown the kind — they must infer it.
 */
export const zNewsKind = z.enum(["signal", "noise", "neutral"]);
export type NewsKind = z.infer<typeof zNewsKind>;

/** Fair-value adjustment applied by a signal headline. */
export const zFvEffect = z.object({
  symbol: z.string(),
  /** Additive change to the symbol's fair value. */
  delta: z.number(),
});
export type FvEffect = z.infer<typeof zFvEffect>;

export const zNewsItem = z.object({
  id: z.string().uuid(),
  challengeId: z.string().uuid(),
  message: z.string().min(1).max(500),
  level: zNewsLevel,
  /** Host-only classification; never exposed to traders. */
  kind: zNewsKind.optional(),
  createdAt: z.string(),
  authorDisplayName: z.string().optional(),
  /** Hidden from non-premium traders until this ISO timestamp. */
  embargoUntil: z.string().nullable().optional(),
});
export type NewsItem = z.infer<typeof zNewsItem>;

export const zPostNewsInput = z.object({
  message: z.string().min(1).max(500),
  level: zNewsLevel.default("info"),
  kind: zNewsKind.default("neutral"),
  /** Signal headlines may shift fair value for one or more symbols. */
  fvEffects: z.array(zFvEffect).max(20).optional(),
  /** Seconds non-premium traders are delayed (premium feed lead time). */
  embargoSec: z.number().int().min(0).max(120).optional(),
});
export type PostNewsInput = z.infer<typeof zPostNewsInput>;

/* ------------------------------------------------------------------ *
 * New Eden — domain entities surfaced to clients
 * (zLoan / zBondHolding are declared earlier, near Portfolio.)
 * ------------------------------------------------------------------ */

export const zRequestLoanInput = z.object({
  challengeId: z.string().uuid(),
  principal: z.number().positive(),
});
export type RequestLoanInput = z.infer<typeof zRequestLoanInput>;

/** Fair value snapshot for a symbol. */
export const zFairValue = z.object({
  symbol: z.string(),
  fairValue: z.number(),
  ts: z.number(),
});
export type FairValue = z.infer<typeof zFairValue>;

/** Option contract series (a tradeable option book). */
export const zOptionContract = z.object({
  /** Synthetic tradeable symbol, e.g. "AERIUM-C-1050". */
  symbol: z.string(),
  underlying: z.string(),
  optionType: z.enum(["call", "put"]),
  strike: z.number(),
  cycleId: z.string(),
  /** ISO time the cycle closes and the exercise window opens. */
  expiresAt: z.string(),
  status: z.enum(["open", "exercise_window", "expired"]),
});
export type OptionContract = z.infer<typeof zOptionContract>;

export const zExerciseOptionInput = z.object({
  challengeId: z.string().uuid(),
  symbol: z.string(),
  quantity: z.number().int().positive(),
});
export type ExerciseOptionInput = z.infer<typeof zExerciseOptionInput>;

/* ---- Deal Desk (OTC) ---- */
export const zOtcLeg = z.object({
  symbol: z.string(),
  /** Signed: positive = trader receives units, negative = trader delivers. */
  quantity: z.number().int(),
  /** Price per unit applied to the cash leg. */
  price: z.number(),
});
export type OtcLeg = z.infer<typeof zOtcLeg>;

export const zOtcOffer = z.object({
  id: z.string().uuid(),
  challengeId: z.string().uuid(),
  userId: z.string().uuid(),
  description: z.string(),
  legs: z.array(zOtcLeg),
  /** Net cash to the trader (positive = trader is paid). */
  cashToTrader: z.number(),
  status: z.enum(["pending", "accepted", "rejected", "expired", "settled"]),
  /** ISO deadline for the trader to respond. */
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type OtcOffer = z.infer<typeof zOtcOffer>;

export const zOtcRespondInput = z.object({
  action: z.enum(["accept", "reject", "bargain"]),
  /** New cash-to-trader proposed when bargaining. */
  counterCash: z.number().optional(),
});
export type OtcRespondInput = z.infer<typeof zOtcRespondInput>;

/* ---- Blind auctions (premium feed) ---- */
export const zAuction = z.object({
  id: z.string().uuid(),
  challengeId: z.string().uuid(),
  status: z.enum(["open", "resolved"]),
  expiresAt: z.string(),
  /** Lowest winning bid, published after resolution. */
  cutoff: z.number().nullable(),
  createdAt: z.string(),
});
export type Auction = z.infer<typeof zAuction>;

export const zAuctionBidInput = z.object({
  auctionId: z.string().uuid(),
  amount: z.number().positive(),
});
export type AuctionBidInput = z.infer<typeof zAuctionBidInput>;

/* ---- Policy votes ---- */
export const zVoteProposal = z.object({
  id: z.string().uuid(),
  challengeId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  kind: z.enum(["wealth_tax"]),
  status: z.enum(["open", "passed", "failed"]),
  expiresAt: z.string(),
  yes: z.number().int(),
  no: z.number().int(),
  createdAt: z.string(),
});
export type VoteProposal = z.infer<typeof zVoteProposal>;

export const zCastVoteInput = z.object({
  proposalId: z.string().uuid(),
  choice: z.enum(["yes", "no"]),
});
export type CastVoteInput = z.infer<typeof zCastVoteInput>;

/* ---- Government grants ---- */
export const zGrantMission = z.object({
  id: z.string().uuid(),
  challengeId: z.string().uuid(),
  symbol: z.string(),
  description: z.string(),
  prize: z.number(),
  status: z.enum(["open", "awarded"]),
  expiresAt: z.string(),
  winnerId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type GrantMission = z.infer<typeof zGrantMission>;
