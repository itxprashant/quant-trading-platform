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
      passwordHash: hash("admin1234"),
      role: "admin",
    })
    .onConflictDoNothing()
    .returning();

  const traderRows = Array.from({ length: 8 }, (_, i) => ({
    username: `trader${i + 1}`,
    displayName: `Trader ${i + 1}`,
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
    allowMargin: true,
    autonomousPrice: true,
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
