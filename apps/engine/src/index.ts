import { and, eq, isNotNull, lte } from "drizzle-orm";
import {
  acquireEngineLock,
  createRedis,
  markChallengeActive,
  markChallengeInactive,
  refreshEngineLock,
  setPrice,
} from "@qtp/bus";
import { challenges, getDb } from "@qtp/db";
import { env } from "./env.js";
import { ChallengeRunner } from "./runner.js";

const redis = createRedis(env.redisUrl);
const db = getDb();
const runners = new Map<string, ChallengeRunner>();
let shuttingDown = false;

/**
 * Drive the scheduled lifecycle from the single engine authority:
 *  - scheduled + startsAt in the past  -> live (seed prices, mark active)
 *  - live + endsAt in the past         -> ended (mark inactive)
 * Idempotent: each transition flips the row exactly once.
 */
async function applyLifecycleTransitions(): Promise<void> {
  const now = new Date();

  const toStart = await db
    .select()
    .from(challenges)
    .where(
      and(
        eq(challenges.status, "scheduled"),
        isNotNull(challenges.startsAt),
        lte(challenges.startsAt, now),
      ),
    );
  for (const row of toStart) {
    await db
      .update(challenges)
      .set({ status: "live" })
      .where(eq(challenges.id, row.id));
    for (const s of row.config.symbols) {
      const existing = await redis.get(`qtp:price:${row.id}:${s.symbol}`);
      if (existing == null) {
        await setPrice(redis, row.id, s.symbol, s.initialPrice, now.getTime());
      }
    }
    await markChallengeActive(redis, row.id);
    console.log(`[engine] auto-started challenge ${row.id}`);
  }

  const toEnd = await db
    .select()
    .from(challenges)
    .where(
      and(
        eq(challenges.status, "live"),
        isNotNull(challenges.endsAt),
        lte(challenges.endsAt, now),
      ),
    );
  for (const row of toEnd) {
    await db
      .update(challenges)
      .set({ status: "ended" })
      .where(eq(challenges.id, row.id));
    await markChallengeInactive(redis, row.id);
    console.log(`[engine] auto-ended challenge ${row.id}`);
  }
}

/** Claim newly-live challenges and release ones that ended. */
async function reconcile(): Promise<void> {
  if (shuttingDown) return;
  await applyLifecycleTransitions();
  // Source of truth: challenges marked live in the database.
  const liveRows = await db
    .select()
    .from(challenges)
    .where(eq(challenges.status, "live"));
  const liveSet = new Set(liveRows.map((r) => r.id));

  for (const [id, runner] of runners) {
    if (!liveSet.has(id)) {
      runners.delete(id);
      await runner.stop();
      await markChallengeInactive(redis, id);
      await redis.del(`qtp:lock:engine:${id}`);
    }
  }

  for (const row of liveRows) {
    if (runners.has(row.id)) continue;
    const claimed = await acquireEngineLock(redis, row.id, env.instanceId);
    if (!claimed) continue;
    const runner = new ChallengeRunner(redis, db, row);
    runners.set(row.id, runner);
    await runner.start();
    await markChallengeActive(redis, row.id);
  }
}

/** Keep our locks fresh; drop runners whose lock we lost. */
async function refreshLocks(): Promise<void> {
  if (shuttingDown) return;
  for (const id of [...runners.keys()]) {
    const held = await refreshEngineLock(redis, id, env.instanceId);
    if (!held) {
      const runner = runners.get(id);
      runners.delete(id);
      await runner?.stop();
    }
  }
}

async function main(): Promise<void> {
  console.log(`[engine] starting instance ${env.instanceId}`);
  await reconcile();
  const reconcileTimer = setInterval(() => void reconcile(), 3000);
  const refreshTimer = setInterval(() => void refreshLocks(), 4000);

  const shutdown = async () => {
    shuttingDown = true;
    clearInterval(reconcileTimer);
    clearInterval(refreshTimer);
    console.log("[engine] shutting down");
    for (const [id, runner] of runners) {
      await runner.stop();
      await redis.del(`qtp:lock:engine:${id}`);
    }
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
