import { redisKeys, type OptionContract } from "@qtp/shared";
import type { Redis } from "ioredis";
import { getEtfWindowClock, getOptionContracts } from "./state.js";

/** Hot keys a runner reads back on start instead of rebuilding them. */
export interface CheckpointRedisState {
  listedSymbols: string[];
  lockedSymbols: string[];
  etfWindows: string[];
  etfWindowClock: {
    open: boolean;
    closesAt: string | null;
    nextOpensAt: string | null;
  } | null;
  optionContracts: OptionContract[];
  drift: Array<{ symbol: string; target: string; speed: string | null }>;
}

export interface CheckpointRedisRestore {
  /** Wall ms the resume moves the event forward by. */
  shiftMs: number;
  /** Epoch ms the checkpoint was taken; later price history is discarded. */
  takenAt: number;
  /** Command stream id the next runner resumes after. */
  cursor: string;
  /** Every symbol with a book in the restored engine state. */
  symbols: readonly string[];
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

export async function readCheckpointRedis(
  redis: Redis,
  challengeId: string,
): Promise<CheckpointRedisState> {
  const [listedSymbols, lockedSymbols, etfWindows, etfWindowClock, optionContracts] =
    await Promise.all([
      redis.smembers(redisKeys.listedSymbols(challengeId)),
      redis.smembers(redisKeys.lockedSymbols(challengeId)),
      redis.smembers(redisKeys.etfWindows(challengeId)),
      getEtfWindowClock(redis, challengeId),
      getOptionContracts(redis, challengeId),
    ]);
  const prefix = `qtp:drift_target:${challengeId}:`;
  const drift: CheckpointRedisState["drift"] = [];
  for (const key of await scanKeys(redis, `${prefix}*`)) {
    const symbol = key.slice(prefix.length);
    const [target, speed] = await redis.mget(
      key,
      `qtp:drift_speed:${challengeId}:${symbol}`,
    );
    if (target != null) drift.push({ symbol, target, speed: speed ?? null });
  }
  return {
    listedSymbols,
    lockedSymbols,
    etfWindows,
    etfWindowClock,
    optionContracts,
    drift,
  };
}

/**
 * Put a challenge's hot Redis state back to a checkpoint. Prices, books, fair
 * values and the frozen flag are rewritten by the engine on start; only keys
 * for instruments listed after the checkpoint are dropped here.
 */
export async function restoreCheckpointRedis(
  redis: Redis,
  challengeId: string,
  state: CheckpointRedisState,
  opts: CheckpointRedisRestore,
): Promise<void> {
  const shift = (iso: string | null) =>
    iso == null ? null : new Date(Date.parse(iso) + opts.shiftMs).toISOString();
  const known = new Set(opts.symbols);
  const stale = [
    redisKeys.listedSymbols(challengeId),
    redisKeys.lockedSymbols(challengeId),
    redisKeys.etfWindows(challengeId),
    redisKeys.etfWindowClock(challengeId),
    redisKeys.optionContracts(challengeId),
    redisKeys.metrics(challengeId),
    redisKeys.newsFeed(challengeId),
    redisKeys.leaderboard(challengeId),
    `qtp:assignment-breaches:${challengeId}`,
  ];
  for (const prefix of ["premium", "drift_target", "drift_speed"])
    stale.push(...(await scanKeys(redis, `qtp:${prefix}:${challengeId}:*`)));
  const unlisted = new Set<string>();
  for (const prefix of ["price", "book", "fv", "phist", "phist-mid", "phist-mid-5m"]) {
    const head = `qtp:${prefix}:${challengeId}:`;
    for (const key of await scanKeys(redis, `${head}*`)) {
      const symbol = key.slice(head.length);
      if (!known.has(symbol)) {
        stale.push(key);
        unlisted.add(symbol);
      } else if (
        prefix === "phist" ||
        prefix === "phist-mid" ||
        prefix === "phist-mid-5m"
      ) {
        await redis.zremrangebyscore(key, `(${opts.takenAt}`, "+inf");
      }
    }
  }
  await redis.del(...stale);
  if (unlisted.size > 0)
    await redis.srem(redisKeys.fairValueSet(challengeId), ...unlisted);

  const tx = redis.multi();
  if (state.listedSymbols.length > 0)
    tx.sadd(redisKeys.listedSymbols(challengeId), ...state.listedSymbols);
  if (state.lockedSymbols.length > 0)
    tx.sadd(redisKeys.lockedSymbols(challengeId), ...state.lockedSymbols);
  if (state.etfWindows.length > 0)
    tx.sadd(redisKeys.etfWindows(challengeId), ...state.etfWindows);
  if (state.etfWindowClock) {
    const clock = state.etfWindowClock;
    tx.set(
      redisKeys.etfWindowClock(challengeId),
      JSON.stringify({
        open: clock.open,
        closesAt: shift(clock.closesAt),
        nextOpensAt: shift(clock.nextOpensAt),
      }),
    );
  }
  if (state.optionContracts.length > 0)
    tx.set(
      redisKeys.optionContracts(challengeId),
      JSON.stringify(
        state.optionContracts.map((c) => ({
          ...c,
          expiresAt: shift(c.expiresAt) ?? c.expiresAt,
        })),
      ),
    );
  for (const d of state.drift) {
    tx.set(`qtp:drift_target:${challengeId}:${d.symbol}`, d.target);
    if (d.speed != null)
      tx.set(`qtp:drift_speed:${challengeId}:${d.symbol}`, d.speed);
  }
  tx.set(redisKeys.commandCursor(challengeId), opts.cursor);
  await tx.exec();
}
