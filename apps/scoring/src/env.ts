export const env = {
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  databaseUrl:
    process.env.DATABASE_URL ?? "postgresql://qtp:qtp@localhost:5432/qtp",
  /** Leaderboard recompute interval (ms). */
  intervalMs: Number(process.env.SCORING_INTERVAL_MS ?? 2000),
  /** How often to persist a score snapshot (ms). */
  snapshotMs: Number(process.env.SCORING_SNAPSHOT_MS ?? 30000),
};
