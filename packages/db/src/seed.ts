import bcrypt from "bcryptjs";
import { inArray } from "drizzle-orm";
import {
  defaultScoringFor,
  EDEN_EVENT_AERIUM,
  EDEN_EVENT_BOTS,
  EDEN_EVENT_DEFAULTS,
  EDEN_EVENT_OPTIONS,
  type ChallengeConfig,
} from "@qtp/shared";
import { createDb } from "./client.js";
import { challenges, participants, users } from "./schema.js";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main() {
  const db = createDb();
  console.log("Seeding database...");

  const hash = (pw: string) => bcrypt.hashSync(pw, 10);

  const [admin] = await db
    .insert(users)
    .values({
      username: "admin",
      displayName: "Administrator",
      email: "admin@quanta.local",
      passwordHash: hash("admin1234"),
      role: "admin",
    })
    .onConflictDoNothing()
    .returning();

  const traderRows = Array.from({ length: 8 }, (_, i) => ({
    username: `trader${i + 1}`,
    displayName: `Trader ${i + 1}`,
    email: `trader${i + 1}@quanta.local`,
    passwordHash: hash("trader1234"),
    role: "trader" as const,
  }));
  await db.insert(users).values(traderRows).onConflictDoNothing();
  // Re-read by username so re-seeding a populated DB still resolves trader ids
  // (onConflictDoNothing().returning() yields nothing for rows that already exist).
  const traders = await db
    .select()
    .from(users)
    .where(
      inArray(
        users.username,
        traderRows.map((t) => t.username),
      ),
    );

  const directionalConfig: ChallengeConfig = {
    symbols: [
      { symbol: "X1", name: "Synthetic One", initialPrice: 100, volatility: 0.5, tickSize: 0.01 },
      { symbol: "X2", name: "Synthetic Two", initialPrice: 100, volatility: 0.7, tickSize: 0.01 },
      { symbol: "X3", name: "Synthetic Three", initialPrice: 100, volatility: 0.4, tickSize: 0.01 },
    ],
    startingCash: 0,
    minPosition: -50,
    maxPosition: 50,
    maxOrderQuantity: 50,
    maxOpenOrders: 25,
    maxOrdersPerSecond: 5,
    maxVolumePerMinute: 500,
    allowMargin: true,
    autonomousPrice: true,
  };

  const mmConfig: ChallengeConfig = {
    symbols: [
      { symbol: "MM1", name: "MarketMaker Alpha", initialPrice: 50, volatility: 0.3, tickSize: 0.01 },
      { symbol: "MM2", name: "MarketMaker Beta", initialPrice: 75, volatility: 0.5, tickSize: 0.01 },
    ],
    startingCash: 0,
    minPosition: -100,
    maxPosition: 100,
    maxOrderQuantity: 100,
    maxOpenOrders: 25,
    maxOrdersPerSecond: 5,
    maxVolumePerMinute: 500,
    allowMargin: true,
    autonomousPrice: true,
  };

  const edenConfig: ChallengeConfig & {
    eden: NonNullable<ChallengeConfig["eden"]> & { eventScript: boolean };
  } = {
    symbols: [EDEN_EVENT_AERIUM],
    startingCash: 10000,
    minPosition: -100,
    maxPosition: 100,
    maxOrderQuantity: 50,
    maxOpenOrders: 25,
    maxOrdersPerSecond: 8,
    maxVolumePerMinute: 1000,
    allowMargin: true,
    autonomousPrice: true,
    eden: {
      eventScript: true,
      rules: {
        enabled: true,
        costOfCarryPerUnitPerMinute: 1,
        loanRepayMultiplier: 2,
        marginCallThreshold: 0,
        forcedLiquidation: true,
        positionCap: 100,
      },
      bots: EDEN_EVENT_BOTS,
      options: EDEN_EVENT_OPTIONS,
      // The timeline introduces bonds at minutes 10 and 18.
      bonds: [],
      // The timeline lists the 2 AERIUM + 1 NEURO basket at minute 45.
      etfs: [],
      auctionDurationSec: EDEN_EVENT_DEFAULTS.auctionDurationSec,
      auctionWinnerFraction: EDEN_EVENT_DEFAULTS.auctionWinnerFraction,
      premiumLeadSec: EDEN_EVENT_DEFAULTS.premiumLeadSec,
      premiumAccessMinutes: EDEN_EVENT_DEFAULTS.premiumAccessMinutes,
    },
  };

  const inserted = await db
    .insert(challenges)
    .values([
      {
        slug: slugify("Tryst Directional Open"),
        name: "Tryst Directional Open",
        description: "Classic PnL race across three synthetic stocks.",
        type: "directional",
        status: "live",
        config: directionalConfig,
        scoring: defaultScoringFor("directional"),
        createdBy: admin?.id ?? null,
      },
      {
        slug: slugify("Liquidity Wars MM"),
        name: "Liquidity Wars MM",
        description: "Provide tight two-sided quotes. Scored on spread capture, uptime, and inventory control.",
        type: "market_making",
        status: "scheduled",
        config: mmConfig,
        scoring: defaultScoringFor("market_making"),
        createdBy: admin?.id ?? null,
      },
      {
        slug: slugify("New Eden Exchange"),
        name: "New Eden Exchange",
        description:
          "The New Eden Exchange: a scripted 130-minute tournament with a halftime break, timed asset introductions, news, options, bonds, ETFs, OTC deals, auctions, a policy vote, and a government grant.",
        type: "new_eden",
        status: "scheduled",
        config: edenConfig,
        scoring: defaultScoringFor("new_eden"),
        createdBy: admin?.id ?? null,
      },
    ])
    .onConflictDoNothing()
    .returning();

  const allChallenges = inserted.length
    ? inserted
    : await db.select().from(challenges);
  const liveChallenge =
    allChallenges.find((c) => c.status === "live") ?? allChallenges[0];
  if (liveChallenge && traders.length) {
    await db
      .insert(participants)
      .values(
        traders.map((t) => ({
          challengeId: liveChallenge.id,
          userId: t.id,
          startingCash: 0,
          cash: 0,
        })),
      )
      .onConflictDoNothing();
  }

  console.log(`Seeded ${traders.length} traders + admin and ${inserted.length} challenges.`);
  console.log("Login: admin / admin1234  |  trader1..8 / trader1234");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
