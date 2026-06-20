import cors from "@fastify/cors";
import { createDb, type Database } from "@qtp/db";
import { createRedis, type Redis } from "@qtp/bus";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "./auth.js";
import { registerMetrics } from "./metrics.js";
import { env } from "./env.js";
import { authRoutes } from "./routes/auth.js";
import { challengeRoutes } from "./routes/challenges.js";
import { orderRoutes } from "./routes/orders.js";
import { marketRoutes } from "./routes/market.js";
import { portfolioRoutes } from "./routes/portfolio.js";
import { leaderboardRoutes } from "./routes/leaderboard.js";
import { adminRoutes } from "./routes/admin.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    redis: Redis;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.nodeEnv === "production" ? "info" : "debug",
      transport:
        env.nodeEnv === "production"
          ? undefined
          : { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } },
    },
  });

  app.decorate("db", createDb(env.databaseUrl));
  app.decorate("redis", createRedis(env.redisUrl));

  await app.register(cors, {
    origin: env.corsOrigins.length === 1 && env.corsOrigins[0] === "*"
      ? true
      : env.corsOrigins,
    credentials: true,
  });

  await registerAuth(app);
  registerMetrics(app);

  app.get("/api/health", async () => ({ status: "ok", ts: Date.now() }));

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(challengeRoutes, { prefix: "/api/challenges" });
  await app.register(orderRoutes, { prefix: "/api/orders" });
  await app.register(marketRoutes, { prefix: "/api/market" });
  await app.register(portfolioRoutes, { prefix: "/api/portfolio" });
  await app.register(leaderboardRoutes, { prefix: "/api/leaderboard" });
  await app.register(adminRoutes, { prefix: "/api/admin" });

  return app;
}
