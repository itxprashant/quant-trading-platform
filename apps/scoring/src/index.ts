import { createRedis, listActiveChallenges } from "@qtp/bus";
import { getDb } from "@qtp/db";
import { env } from "./env.js";
import { scoreChallenge } from "./scoring.js";

const redis = createRedis(env.redisUrl);
const db = getDb();
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const active = await listActiveChallenges(redis);
    await Promise.all(
      active.map((id) =>
        scoreChallenge(db, redis, id, { snapshotMs: env.snapshotMs }).catch(
          (e) => console.error(e),
        ),
      ),
    );
  } catch (err) {
    console.error("[scoring] tick error", err);
  } finally {
    ticking = false;
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
