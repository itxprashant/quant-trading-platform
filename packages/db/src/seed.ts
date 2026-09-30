import bcrypt from "bcryptjs";
import { inArray } from "drizzle-orm";
import {
  defaultScoringFor,
  newEdenDemoChallengeConfig,
  newEdenExchangeChallengeConfig,
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

  const edenConfig = newEdenExchangeChallengeConfig("cues");

  const inserted = await db
    .insert(challenges)
    .values([
      {
        slug: slugify("New Eden Exchange"),
        name: "New Eden Exchange",
        description:
          "The New Eden Exchange: a scripted 210-minute tournament (two 90-minute halves and a 30-minute break) with timed asset introductions, news, options, bonds, ETFs, OTC deals, auctions, a policy vote, and a government grant.",
        type: "new_eden",
        status: "scheduled",
        config: edenConfig,
        scoring: defaultScoringFor("new_eden"),
        createdBy: admin?.id ?? null,
      },
      {
        slug: slugify("QuantStorm Practice"),
        name: "QuantStorm Practice",
        description:
          "Practice cue sheet for testers. The admin fires each beat: headlines, bonds, Neuro, the Orbital ETF and its windows, options, one premium auction, and a Deal Desk offer. Hidden from traders until an admin turns visibility on.",
        type: "new_eden",
        status: "scheduled",
        hiddenFromTraders: true,
        config: newEdenDemoChallengeConfig(),
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
