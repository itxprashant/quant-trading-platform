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
  ScoringConfig,
} from "@qtp/shared";

export const roleEnum = pgEnum("role", ["trader", "admin"]);
export const challengeTypeEnum = pgEnum("challenge_type", [
  "directional",
  "market_making",
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

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Challenge = typeof challenges.$inferSelect;
export type NewChallenge = typeof challenges.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type Trade = typeof trades.$inferSelect;
export type Position = typeof positions.$inferSelect;
export type ChallengeNews = typeof challengeNews.$inferSelect;
export type NewChallengeNews = typeof challengeNews.$inferInsert;

// silence unused import in some build modes
export type _ConfigTypes = { config: ChallengeConfig; scoring: ScoringConfig };
