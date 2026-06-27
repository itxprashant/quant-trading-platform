import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  ChallengeConfig,
  FvEffect,
  OtcLeg,
  ScoringConfig,
} from "@qtp/shared";

export const roleEnum = pgEnum("role", ["trader", "admin"]);
export const challengeTypeEnum = pgEnum("challenge_type", [
  "directional",
  "market_making",
  "new_eden",
]);
export const challengeStatusEnum = pgEnum("challenge_status", [
  "draft",
  "scheduled",
  "live",
  "paused",
  "ended",
]);
export const orderSideEnum = pgEnum("order_side", ["buy", "sell"]);
export const orderTypeEnum = pgEnum("order_type", ["limit", "market"]);
export const orderStatusEnum = pgEnum("order_status", [
  "open",
  "partially_filled",
  "filled",
  "cancelled",
  "rejected",
]);
export const newsLevelEnum = pgEnum("news_level", ["info", "warning", "urgent"]);
export const newsKindEnum = pgEnum("news_kind", ["signal", "noise", "neutral"]);
export const loanStatusEnum = pgEnum("loan_status", ["active", "repaid"]);
export const optionStatusEnum = pgEnum("option_status", [
  "open",
  "exercise_window",
  "expired",
]);
export const otcStatusEnum = pgEnum("otc_status", [
  "pending",
  "accepted",
  "rejected",
  "expired",
  "settled",
]);
export const auctionStatusEnum = pgEnum("auction_status", ["open", "resolved"]);
export const voteStatusEnum = pgEnum("vote_status", [
  "open",
  "passed",
  "failed",
]);
export const grantStatusEnum = pgEnum("grant_status", ["open", "awarded"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email").notNull().default(""),
    passwordHash: text("password_hash").notNull(),
    role: roleEnum("role").notNull().default("trader"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_username_uq").on(t.username)],
);

export const challenges = pgTable(
  "challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    type: challengeTypeEnum("type").notNull(),
    status: challengeStatusEnum("status").notNull().default("draft"),
    config: jsonb("config").$type<ChallengeConfig>().notNull(),
    scoring: jsonb("scoring").$type<ScoringConfig>().notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("challenges_slug_uq").on(t.slug),
    index("challenges_status_idx").on(t.status),
  ],
);

export const participants = pgTable(
  "challenge_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startingCash: doublePrecision("starting_cash").notNull().default(0),
    cash: doublePrecision("cash").notNull().default(0),
    /** New Eden: aggregate outstanding loan debt owed to the bank. */
    loanDebt: doublePrecision("loan_debt").notNull().default(0),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("participant_uq").on(t.challengeId, t.userId),
    index("participant_challenge_idx").on(t.challengeId),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    side: orderSideEnum("side").notNull(),
    type: orderTypeEnum("type").notNull().default("limit"),
    quantity: integer("quantity").notNull(),
    remainingQuantity: integer("remaining_quantity").notNull(),
    price: doublePrecision("price"),
    status: orderStatusEnum("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("orders_challenge_user_idx").on(t.challengeId, t.userId),
    index("orders_challenge_symbol_idx").on(t.challengeId, t.symbol),
    index("orders_status_idx").on(t.status),
  ],
);

export const trades = pgTable(
  "trades",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    price: doublePrecision("price").notNull(),
    quantity: integer("quantity").notNull(),
    takerSide: orderSideEnum("taker_side").notNull(),
    buyOrderId: uuid("buy_order_id"),
    sellOrderId: uuid("sell_order_id"),
    buyerId: uuid("buyer_id"),
    sellerId: uuid("seller_id"),
    executedAt: timestamp("executed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("trades_challenge_symbol_idx").on(t.challengeId, t.symbol),
    index("trades_executed_idx").on(t.executedAt),
  ],
);

export const positions = pgTable(
  "positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    quantity: integer("quantity").notNull().default(0),
    avgPrice: doublePrecision("avg_price").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("position_uq").on(t.challengeId, t.userId, t.symbol)],
);

export const scoreSnapshots = pgTable(
  "score_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    pnl: doublePrecision("pnl").notNull(),
    score: doublePrecision("score").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("score_challenge_idx").on(t.challengeId, t.capturedAt),
  ],
);

export const challengeNews = pgTable(
  "challenge_news",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    message: text("message").notNull(),
    level: newsLevelEnum("level").notNull().default("info"),
    /** signal / noise / neutral (host-only classification). */
    kind: newsKindEnum("kind").notNull().default("neutral"),
    /** Fair-value adjustments applied by a signal headline. */
    fvEffects: jsonb("fv_effects").$type<FvEffect[]>(),
    /** Non-premium traders see this item only after this time. */
    embargoUntil: timestamp("embargo_until", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("challenge_news_challenge_created_idx").on(
      t.challengeId,
      t.createdAt,
    ),
  ],
);

/* ------------------------------------------------------------------ *
 * New Eden tournament tables
 * ------------------------------------------------------------------ */

export const fairValues = pgTable(
  "fair_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    fairValue: doublePrecision("fair_value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("fair_value_uq").on(t.challengeId, t.symbol)],
);

export const loans = pgTable(
  "loans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    principal: doublePrecision("principal").notNull(),
    totalRepay: doublePrecision("total_repay").notNull(),
    remaining: doublePrecision("remaining").notNull(),
    status: loanStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("loans_challenge_user_idx").on(t.challengeId, t.userId)],
);

export const bondHoldings = pgTable(
  "bond_holdings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bondId: text("bond_id").notNull(),
    name: text("name").notNull(),
    quantity: integer("quantity").notNull().default(0),
    price: doublePrecision("price").notNull(),
    faceValue: doublePrecision("face_value").notNull(),
    couponsPaid: doublePrecision("coupons_paid").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("bond_holding_uq").on(t.challengeId, t.userId, t.bondId),
  ],
);

export const optionCycles = pgTable(
  "option_cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    underlying: text("underlying").notNull(),
    status: optionStatusEnum("status").notNull().default("open"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("option_cycle_challenge_idx").on(t.challengeId)],
);

export const optionContracts = pgTable(
  "option_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    cycleId: uuid("cycle_id")
      .notNull()
      .references(() => optionCycles.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    underlying: text("underlying").notNull(),
    optionType: text("option_type").notNull(),
    strike: doublePrecision("strike").notNull(),
    status: optionStatusEnum("status").notNull().default("open"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("option_contract_uq").on(t.challengeId, t.symbol)],
);

export const otcOffers = pgTable(
  "otc_offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    legs: jsonb("legs").$type<OtcLeg[]>().notNull(),
    cashToTrader: doublePrecision("cash_to_trader").notNull(),
    status: otcStatusEnum("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("otc_challenge_user_idx").on(t.challengeId, t.userId)],
);

export const auctions = pgTable(
  "auctions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    status: auctionStatusEnum("status").notNull().default("open"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    cutoff: doublePrecision("cutoff"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("auction_challenge_idx").on(t.challengeId)],
);

export const auctionBids = pgTable(
  "auction_bids",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    auctionId: uuid("auction_id")
      .notNull()
      .references(() => auctions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    amount: doublePrecision("amount").notNull(),
    won: boolean("won").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("auction_bid_uq").on(t.auctionId, t.userId)],
);

export const voteProposals = pgTable(
  "vote_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    kind: text("kind").notNull().default("wealth_tax"),
    status: voteStatusEnum("status").notNull().default("open"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("vote_proposal_challenge_idx").on(t.challengeId)],
);

export const voteBallots = pgTable(
  "vote_ballots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => voteProposals.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    choice: text("choice").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("vote_ballot_uq").on(t.proposalId, t.userId)],
);

export const grantMissions = pgTable(
  "grant_missions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    description: text("description").notNull(),
    prize: doublePrecision("prize").notNull(),
    status: grantStatusEnum("status").notNull().default("open"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    winnerId: uuid("winner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("grant_challenge_idx").on(t.challengeId)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Challenge = typeof challenges.$inferSelect;
export type NewChallenge = typeof challenges.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type Trade = typeof trades.$inferSelect;
export type Position = typeof positions.$inferSelect;
export type ChallengeNews = typeof challengeNews.$inferSelect;
export type NewChallengeNews = typeof challengeNews.$inferInsert;
export type Loan = typeof loans.$inferSelect;
export type NewLoan = typeof loans.$inferInsert;
export type BondHolding = typeof bondHoldings.$inferSelect;
export type FairValueRow = typeof fairValues.$inferSelect;
export type OptionCycle = typeof optionCycles.$inferSelect;
export type OptionContract = typeof optionContracts.$inferSelect;
export type OtcOffer = typeof otcOffers.$inferSelect;
export type Auction = typeof auctions.$inferSelect;
export type AuctionBid = typeof auctionBids.$inferSelect;
export type VoteProposal = typeof voteProposals.$inferSelect;
export type VoteBallot = typeof voteBallots.$inferSelect;
export type GrantMission = typeof grantMissions.$inferSelect;

// silence unused import in some build modes
export type _ConfigTypes = {
  config: ChallengeConfig;
  scoring: ScoringConfig;
  fvEffects: FvEffect[];
  otcLegs: OtcLeg[];
};
