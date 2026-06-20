import { randomUUID } from "node:crypto";

export const env = {
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  databaseUrl:
    process.env.DATABASE_URL ?? "postgresql://qtp:qtp@localhost:5432/qtp",
  /** Autonomous price tick interval (ms). */
  tickMs: Number(process.env.ENGINE_TICK_MS ?? 1000),
  /** Unique identity for leader election. */
  instanceId: process.env.HOSTNAME ?? `engine-${randomUUID().slice(0, 8)}`,
  /** Persistence flush interval (ms). */
  flushMs: Number(process.env.ENGINE_FLUSH_MS ?? 250),
  /** Bot action interval (ms). */
  botMs: Number(process.env.ENGINE_BOT_MS ?? 1200),
  /** Trader-metrics publish interval (ms). */
  metricsMs: Number(process.env.ENGINE_METRICS_MS ?? 1000),
};
