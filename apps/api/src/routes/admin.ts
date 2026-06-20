import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { challenges, orders, positions, trades, users } from "@qtp/db";
import { redisKeys } from "@qtp/shared";
import { clearTraderMetrics, setPrice } from "@qtp/bus";
import { z } from "zod";
import { validate } from "../util.js";

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", app.requireAdmin);

  // List users.
  app.get("/users", async () => {
    const rows = await app.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));
    return rows.map((u) => ({
      ...u,
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    }));
  });

  // Set a drift target for a symbol; the engine biases the random walk toward it.
  app.post("/:challengeId/drift", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      z.object({
        symbol: z.string(),
        target: z.number().positive(),
        speed: z.number().min(1).max(10).default(5),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    await app.redis
      .pipeline()
      .set(`qtp:drift_target:${challengeId}:${body.symbol}`, String(body.target))
      .set(`qtp:drift_speed:${challengeId}:${body.symbol}`, String(body.speed))
      .exec();
    return { ok: true };
  });

  // Hard-set a price (admin manipulation), reflected to clients next tick.
  app.post("/:challengeId/price", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      z.object({ symbol: z.string(), price: z.number().positive() }),
      req.body,
      reply,
    );
    if (!body) return;
    await setPrice(app.redis, challengeId, body.symbol, body.price, Date.now());
    return { ok: true };
  });

  // Reset trading state for a single challenge (orders, trades, positions, prices).
  app.post("/:challengeId/reset", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, challengeId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });

    await app.db.delete(trades).where(eq(trades.challengeId, challengeId));
    await app.db.delete(orders).where(eq(orders.challengeId, challengeId));
    await app.db.delete(positions).where(eq(positions.challengeId, challengeId));

    // Reset Redis prices/book to initial config.
    for (const s of challenge.config.symbols) {
      await setPrice(app.redis, challengeId, s.symbol, s.initialPrice, Date.now());
      await app.redis.del(redisKeys.bookSnapshot(challengeId, s.symbol));
      await app.redis.del(redisKeys.priceHistory(challengeId, s.symbol));
    }
    await app.redis.del(redisKeys.leaderboard(challengeId));
    await clearTraderMetrics(app.redis, challengeId);
    // Signal engines to reload this challenge from scratch.
    await app.redis.publish(`qtp:control:${challengeId}`, "reset");

    return { ok: true };
  });
}
