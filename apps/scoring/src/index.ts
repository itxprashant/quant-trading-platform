import { eq } from "drizzle-orm";
import {
  createRedis,
  getPrice,
  getTraderMetricsMap,
  listActiveChallenges,
  publishBroadcast,
  setLeaderboard,
} from "@qtp/bus";
import { computeScore } from "@qtp/core";
import {
  challenges,
  getDb,
  participants,
  positions,
  scoreSnapshots,
  users,
} from "@qtp/db";
import type { LeaderboardEntry } from "@qtp/shared";
import { env } from "./env.js";

const redis = createRedis(env.redisUrl);
const db = getDb();
const lastSnapshot = new Map<string, number>();

async function scoreChallenge(challengeId: string): Promise<void> {
  const challenge = await db.query.challenges.findFirst({
    where: eq(challenges.id, challengeId),
  });
  if (!challenge) return;

  // Cache current prices once per pass.
  const priceMap = new Map<string, number>();
  for (const s of challenge.config.symbols) {
    const p = await getPrice(redis, challengeId, s.symbol);
    priceMap.set(s.symbol, p ?? s.initialPrice);
  }

  const isEden = challenge.type === "new_eden";
  const parts = await db
    .select({
      userId: participants.userId,
      cash: participants.cash,
      loanDebt: participants.loanDebt,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
    })
    .from(participants)
    .innerJoin(users, eq(users.id, participants.userId))
    .where(eq(participants.challengeId, challengeId));

  const posRows = await db
    .select()
    .from(positions)
    .where(eq(positions.challengeId, challengeId));

  const posByUser = new Map<string, typeof posRows>();
  for (const p of posRows) {
    const arr = posByUser.get(p.userId) ?? [];
    arr.push(p);
    posByUser.set(p.userId, arr);
  }

  // Engine-maintained metrics (spread capture, quote uptime, volume, ...).
  const metricsMap = await getTraderMetricsMap(redis, challengeId);

  const entries: LeaderboardEntry[] = [];
  for (const part of parts) {
    if (part.role === "admin") continue; // admins excluded from rankings
    let marketValue = 0;
    let absInventory = 0;
    for (const p of posByUser.get(part.userId) ?? []) {
      if (p.quantity === 0) continue;
      marketValue += p.quantity * (priceMap.get(p.symbol) ?? 0);
      absInventory += Math.abs(p.quantity);
    }
    // New Eden nets borrowed money out of wealth (comp_desc Section 1).
    const pnl = part.cash + marketValue - (isEden ? part.loanDebt : 0);
    const metrics = metricsMap.get(part.userId);
    const score = computeScore(
      {
        userId: part.userId,
        pnl,
        absInventory: metrics?.inventory ?? absInventory,
        spreadCapture: metrics?.spreadCapture,
        quoteUptime: metrics?.quoteUptime,
      },
      challenge.scoring,
    );
    entries.push({
      rank: 0,
      userId: part.userId,
      username: part.username,
      displayName: part.displayName,
      pnl,
      score,
      ...(metrics ? { metrics } : {}),
    });
  }

  entries.sort((a, b) => b.score - a.score);
  entries.forEach((e, i) => (e.rank = i + 1));

  await setLeaderboard(redis, challengeId, entries);
  await publishBroadcast(redis, challengeId, [
    { target: "all", msg: { type: "leaderboard", challengeId, data: entries } },
  ]);

  const now = Date.now();
  if (now - (lastSnapshot.get(challengeId) ?? 0) >= env.snapshotMs && entries.length) {
    lastSnapshot.set(challengeId, now);
    await db.insert(scoreSnapshots).values(
      entries.map((e) => ({
        challengeId,
        userId: e.userId,
        pnl: e.pnl,
        score: e.score,
      })),
    );
  }
}

async function tick(): Promise<void> {
  try {
    const active = await listActiveChallenges(redis);
    await Promise.all(active.map((id) => scoreChallenge(id).catch((e) => console.error(e))));
  } catch (err) {
    console.error("[scoring] tick error", err);
  }
}

async function main(): Promise<void> {
  console.log("[scoring] worker started");
  await tick();
  const timer = setInterval(() => void tick(), env.intervalMs);
  const shutdown = async () => {
    clearInterval(timer);
    await redis.quit().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
