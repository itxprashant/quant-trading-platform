export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.API_PORT ?? 8000),
  jwtSecret:
    process.env.JWT_SECRET ??
    "dev-only-change-me-0000000000000000000000000000000000000000",
  jwtExpiresIn: Number(process.env.JWT_EXPIRES_IN ?? 86400),
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  databaseUrl:
    process.env.DATABASE_URL ?? "postgresql://qtp:qtp@localhost:5432/qtp",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
};
