export const env = {
  port: Number(process.env.GATEWAY_PORT ?? 8080),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  databaseUrl:
    process.env.DATABASE_URL ?? "postgresql://qtp:qtp@localhost:5432/qtp",
  jwtSecret:
    process.env.JWT_SECRET ??
    "dev-only-change-me-0000000000000000000000000000000000000000",
  /** Drop a connection if its outbound buffer exceeds this many bytes. */
  maxBufferedBytes: Number(process.env.GATEWAY_MAX_BUFFER ?? 1_000_000),
  heartbeatMs: Number(process.env.GATEWAY_HEARTBEAT_MS ?? 30000),
};
