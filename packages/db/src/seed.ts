import bcrypt from "bcryptjs";
import { defaultScoringFor, type ChallengeConfig } from "@qtp/shared";
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
  const traders = await db
    .insert(users)
    .values(traderRows)
    .onConflictDoNothing()
    .returning();

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
    maxOrdersPerSecond: 5,
    maxVolumePerMinute: 500,
    allowMargin: true,
    autonomousPrice: true,
  };

  const edenConfig: ChallengeConfig = {
    symbols: [
      { symbol: "AERIUM", name: "Aerium Dynamics", initialPrice: 1000, volatility: 4, tickSize: 0.5 },
      { symbol: "HELION", name: "Helion Power", initialPrice: 250, volatility: 1.5, tickSize: 0.1 },
      { symbol: "VESTA", name: "Vesta Logistics", initialPrice: 80, volatility: 0.8, tickSize: 0.05 },
    ],
    startingCash: 10000,
    minPosition: -100,
    maxPosition: 100,
    maxOrderQuantity: 50,
    maxOrdersPerSecond: 8,
    maxVolumePerMinute: 1000,
    allowMargin: true,
    autonomousPrice: true,
    eden: {
      rules: {
        enabled: true,
        costOfCarryPerUnitPerMinute: 1,
        loanRepayMultiplier: 2,
        marginCallThreshold: 0,
        forcedLiquidation: true,
        positionCap: 100,
      },
      bots: {
        hftMarketMakers: 2,
        momentumTraders: 4,
        vegaSnipers: 0,
        parityArbers: 0,
        spread: 1,
        quoteSize: 10,
        intensity: 0.5,
      },
      options: { enabled: true, underlyings: ["AERIUM"], cycleMinutes: 5, exerciseWindowSec: 15 },
      bonds: [
        { id: "standard", name: "Treasury 5Y", price: 950, faceValue: 1000, couponPer5Min: 10, maxPerUser: 5 },
        {
          id: "aerium_pegged",
          name: "Aerium-Pegged Note",
          price: 1000,
          faceValue: 1000,
          peggedYield: { symbol: "AERIUM", base: 2000, divisor: 10 },
          maxPerUser: 3,
        },
      ],
      etfs: [
        {
          symbol: "ORBITAL",
          name: "Orbital Index ETF",
          basket: [
            { symbol: "AERIUM", weight: 1 },
            { symbol: "HELION", weight: 2 },
            { symbol: "VESTA", weight: 4 },
          ],
        },
      ],
      auctionDurationSec: 30,
      auctionWinnerFraction: 0.3,
      premiumLeadSec: 10,
      premiumAccessMinutes: 15,
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
          "Full-economy tournament: margin & predatory loans, cost of carry, fair value, signal/noise news, options, bonds, ETFs, OTC deals, blind auctions, votes, and grants — all driven live from the host console.",
        type: "new_eden",
        status: "scheduled",
        config: edenConfig,
        scoring: defaultScoringFor("new_eden"),
        createdBy: admin?.id ?? null,
      },
    ])
    .onConflictDoNothing()
    .returning();

  const liveChallenge = inserted.find((c) => c.status === "live") ?? inserted[0];
  if (liveChallenge) {
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
