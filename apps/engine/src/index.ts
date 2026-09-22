import { and, eq } from "drizzle-orm";
import {
  acquireEngineLock,
  createRedis,
  markChallengeActive,
  markChallengeInactive,
  refreshEngineLock,
} from "@qtp/bus";
import { challenges, getDb } from "@qtp/db";
import { redisKeys } from "@qtp/shared";
import { env } from "./env.js";
import { ChallengeRunner } from "./runner.js";

const redis = createRedis(env.redisUrl);
const db = getDb();
type OwnedRunner = {
  runner: ChallengeRunner;
  lost: boolean;
  retiring: boolean;
};
const runners = new Map<string, OwnedRunner>();
let shuttingDown = false;
let reconciliation: Promise<void> | undefined;
let refreshing: Promise<void> | undefined;

async function releaseLock(id: string): Promise<void> {
  await redis.eval(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then
       return redis.call('DEL', KEYS[1])
     end
     return 0`,
    1,
    redisKeys.engineLock(id),
    env.instanceId,
  );
}

async function stopRunner(
  id: string,
  owned: OwnedRunner,
  persist: boolean,
  inactive = false,
): Promise<void> {
  owned.retiring = true;
  await owned.runner.stop(persist && !owned.lost && owned.runner.healthy);
  if (inactive && !owned.lost) await markChallengeInactive(redis, id);
  // Keep the entry until draining and conditional release both succeed.
  await releaseLock(id);
  runners.delete(id);
}

/** Only this serialized loop starts, finalizes, or stops runners. */
function reconcile(): Promise<void> {
  if (reconciliation) return reconciliation;
  if (shuttingDown) return Promise.resolve();
  reconciliation = (async () => {
    for (const [id, owned] of runners) {
      if (owned.lost || owned.retiring || !owned.runner.healthy) {
        try {
          await stopRunner(id, owned, false);
        } catch (error) {
          console.error(`[engine] failed to drain challenge ${id}`, error);
        }
      }
    }

    const rows = await db.select().from(challenges);
    for (const snapshot of rows) {
      if (shuttingDown) break;
      let owned = runners.get(snapshot.id);
      if (owned?.lost || owned?.retiring) continue;
      const due =
        snapshot.status === "scheduled" &&
        snapshot.startsAt != null &&
        snapshot.startsAt.getTime() <= Date.now();
      const runnable =
        snapshot.finalizedAt == null &&
        (snapshot.status === "live" || snapshot.status === "ended" || due);
      const inactive =
        snapshot.status === "paused" ||
        (snapshot.status === "ended" && snapshot.finalizedAt != null);
      if (!owned && !runnable && !inactive) continue;

      let claimed = false;
      try {
        if (owned) {
          if (!(await refreshEngineLock(redis, snapshot.id, env.instanceId))) {
            owned.lost = true;
            await stopRunner(snapshot.id, owned, false);
            continue;
          }
        } else {
          claimed = await acquireEngineLock(redis, snapshot.id, env.instanceId);
          if (!claimed) continue;
        }

        // A different owner or an admin may have changed the row since the scan.
        let [row] = await db
          .select()
          .from(challenges)
          .where(eq(challenges.id, snapshot.id));
        if (!row) {
          if (owned) await stopRunner(snapshot.id, owned, true);
          continue;
        }
        if (
          row.status === "scheduled" &&
          row.startsAt &&
          row.startsAt.getTime() <= Date.now()
        ) {
          [row] = await db
            .update(challenges)
            .set({ status: "live" })
            .where(
              and(
                eq(challenges.id, row.id),
                eq(challenges.status, "scheduled"),
              ),
            )
            .returning();
          if (!row) continue;
          // Even an elapsed schedule must catch up through runner.start().
          console.log(`[engine] auto-started challenge ${row.id}`);
        }

        if (
          row.finalizedAt != null ||
          (row.status !== "live" && row.status !== "ended")
        ) {
          const inactive =
            row.status === "paused" ||
            (row.status === "ended" && row.finalizedAt != null);
          if (owned) {
            await stopRunner(row.id, owned, true, inactive);
          } else if (inactive) {
            await markChallengeInactive(redis, row.id);
          }
          continue;
        }

        if (!owned) {
          if (!(await refreshEngineLock(redis, row.id, env.instanceId)))
            continue;
          owned = {
            runner: new ChallengeRunner(redis, db, row),
            lost: false,
            retiring: false,
          };
          runners.set(row.id, owned);
          claimed = false;
          await owned.runner.start();
        }
        if (owned.lost || !owned.runner.healthy) {
          await stopRunner(row.id, owned, false);
          continue;
        }

        // start() can catch up and finalize; do not reactivate its final result.
        const [current] = await db
          .select()
          .from(challenges)
          .where(eq(challenges.id, row.id));
        if (!current) continue;
        if (
          current.status === "ended" ||
          (current.status === "live" &&
            current.endsAt != null &&
            current.endsAt.getTime() <= Date.now())
        ) {
          if (
            !(await refreshEngineLock(redis, row.id, env.instanceId)) ||
            owned.lost
          ) {
            owned.lost = true;
            await stopRunner(row.id, owned, false);
            continue;
          }
          if (current.finalizedAt == null) await owned.runner.finish();
          if (owned.lost) {
            await stopRunner(row.id, owned, false);
            continue;
          }
          // finish() persists the final result before active scoring is removed.
          await stopRunner(row.id, owned, true, true);
        } else if (
          current.status === "live" &&
          current.finalizedAt == null &&
          !owned.lost
        ) {
          await markChallengeActive(redis, row.id);
        }
      } catch (error) {
        console.error(
          `[engine] reconciliation failed for ${snapshot.id}`,
          error,
        );
        if (owned) {
          await stopRunner(snapshot.id, owned, false).catch((stopError) => {
            console.error(
              `[engine] failed to drain challenge ${snapshot.id}`,
              stopError,
            );
          });
        }
      } finally {
        if (claimed) {
          await releaseLock(snapshot.id);
        }
      }
    }
  })().finally(() => {
    reconciliation = undefined;
  });
  return reconciliation;
}

/** Renew during slow catch-up, but leave all runner lifecycle work serialized. */
function refreshLocks(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    for (const [id, owned] of runners) {
      if (owned.lost) continue;
      try {
        if (!(await refreshEngineLock(redis, id, env.instanceId))) {
          owned.lost = true;
          owned.runner.invalidateLease();
        }
      } catch (error) {
        // Ownership is uncertain: never request a final flush on this runner.
        owned.lost = true;
        owned.runner.invalidateLease();
        console.error(`[engine] lock refresh failed for ${id}`, error);
      }
    }
  })().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

async function main(): Promise<void> {
  console.log(`[engine] starting instance ${env.instanceId}`);
  // Start the heartbeat before initial catch-up, which may exceed the lock TTL.
  const refreshTimer = setInterval(() => {
    void refreshLocks()
      .then(async () => {
        if (![...runners.values()].some((owned) => owned.lost)) return;
        await reconciliation;
        await reconcile();
      })
      .catch((error) =>
        console.error("[engine] lock maintenance failed", error),
      );
  }, 4000);
  const reconcileTimer = setInterval(() => {
    void reconcile().catch((error) =>
      console.error("[engine] reconciliation failed", error),
    );
  }, 3000);

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reconcileTimer);
    console.log("[engine] shutting down");
    await reconciliation?.catch(() => {});
    for (const [id, owned] of runners) {
      const held = await refreshEngineLock(redis, id, env.instanceId).catch(
        () => false,
      );
      await stopRunner(id, owned, held);
    }
    clearInterval(refreshTimer);
    await refreshing;
    await redis.quit().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown().catch(console.error));
  process.on("SIGTERM", () => void shutdown().catch(console.error));
  await reconcile();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
