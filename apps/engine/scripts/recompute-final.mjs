import { createRedis } from "@qtp/bus";
import { challenges, createDb } from "@qtp/db";
import { eq } from "drizzle-orm";
import { finalizeScores } from "../src/final-scoring.ts";

const challengeId = process.argv[2];
if (!challengeId) {
  console.error("Usage: pnpm exec tsx scripts/recompute-final.mjs <challengeId>");
  process.exit(1);
}

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://qtp:qtp@localhost:5432/qtp";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const db = createDb(DATABASE_URL);
const redis = createRedis(REDIS_URL);
try {
  await db
    .update(challenges)
    .set({ finalResults: null })
    .where(eq(challenges.id, challengeId));
  await finalizeScores(db, redis, challengeId);
  console.log("ok", challengeId);
} finally {
  await redis.quit();
}
