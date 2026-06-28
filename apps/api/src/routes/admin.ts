import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  challengeNews,
  challenges,
  orders,
  otcOffers,
  participants,
  positions,
  trades,
  users,
} from "@qtp/db";
import {
  zCreateOtcInput,
  zPostNewsInput,
  type EngineCommand,
} from "@qtp/shared";
import { redisKeys } from "@qtp/shared";
import {
  clearNewsFeed,
  clearTraderMetrics,
  getFairValues,
  publishBroadcast,
  publishCommand,
  pushNews,
  setPrice,
  setSymbolTradeable,
} from "@qtp/bus";
import { z } from "zod";
import { rateLimit } from "../ratelimit.js";
import { serializeNewsItem } from "../serialize.js";
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
        email: users.email,
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

  // Post live news announcement for a challenge.
  app.post(
    "/:challengeId/news",
    {
      preHandler: [
        rateLimit({ bucket: "admin_news", limit: 10, windowMs: 60_000 }),
      ],
    },
    async (req, reply) => {
      const { challengeId } = req.params as { challengeId: string };
      const body = validate(zPostNewsInput, req.body, reply);
      if (!body) return;

      const challenge = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, challengeId),
      });
      if (!challenge) return reply.code(404).send({ error: "not_found" });

      const author = await app.db.query.users.findFirst({
        where: eq(users.id, req.user.sub),
        columns: { displayName: true },
      });

      const embargoUntil =
        body.embargoSec && body.embargoSec > 0
          ? new Date(Date.now() + body.embargoSec * 1000)
          : null;

      const [row] = await app.db
        .insert(challengeNews)
        .values({
          challengeId,
          message: body.message,
          level: body.level,
          kind: body.kind,
          fvEffects: body.fvEffects ?? null,
          embargoUntil,
          createdBy: req.user.sub,
        })
        .returning();

      const item = serializeNewsItem({
        ...row!,
        authorDisplayName: author?.displayName ?? null,
      });

      await pushNews(app.redis, challengeId, item);
      await publishBroadcast(app.redis, challengeId, [
        { target: "all", msg: { type: "news", challengeId, data: item } },
      ]);

      // Signal news moves fair value via the engine command stream.
      if (
        body.kind === "signal" &&
        body.fvEffects &&
        body.fvEffects.length > 0
      ) {
        const cmd: EngineCommand = {
          type: "apply_fv_delta",
          challengeId,
          effects: body.fvEffects,
          ts: Date.now(),
        };
        await publishCommand(app.redis, challengeId, cmd);
      }

      // Broadcast a momentum pulse so the bot ecosystem reacts. Explicit
      // momentum wins; otherwise derive direction from the signal's FV deltas
      // (NOISE headlines carry no fvEffects, so the host supplies momentum to
      // make the retail bots overreact while fair value stays put).
      const momentum =
        body.momentum && body.momentum.length > 0
          ? body.momentum
          : (body.fvEffects ?? [])
              .filter((e) => e.delta !== 0)
              .map((e) => ({
                symbol: e.symbol,
                sentiment: Math.sign(e.delta),
              }));
      if (momentum.length > 0 || body.volEvent) {
        const pulse: EngineCommand = {
          type: "news_pulse",
          challengeId,
          effects: momentum,
          volEvent: !!body.volEvent,
          ts: Date.now(),
        };
        await publishCommand(app.redis, challengeId, pulse);
      }

      return { item };
    },
  );

  // Set a symbol's fair value directly (host control).
  app.post("/:challengeId/fair-value", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      z.object({ symbol: z.string(), fairValue: z.number().positive() }),
      req.body,
      reply,
    );
    if (!body) return;
    const cmd: EngineCommand = {
      type: "set_fair_value",
      challengeId,
      symbol: body.symbol,
      fairValue: body.fairValue,
      ts: Date.now(),
    };
    await publishCommand(app.redis, challengeId, cmd);
    return { ok: true };
  });

  // Read current fair values for the host console.
  app.get("/:challengeId/fair-value", async (req) => {
    const { challengeId } = req.params as { challengeId: string };
    return getFairValues(app.redis, challengeId);
  });

  // Lock / unlock a symbol for trading (dynamic asset introduction).
  app.post("/:challengeId/tradeable", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      z.object({ symbol: z.string(), tradeable: z.boolean() }),
      req.body,
      reply,
    );
    if (!body) return;
    await setSymbolTradeable(app.redis, challengeId, body.symbol, body.tradeable);
    await publishBroadcast(app.redis, challengeId, [
      {
        target: "all",
        msg: {
          type: "alert",
          challengeId,
          data: {
            level: "info",
            message: `${body.symbol} is now ${body.tradeable ? "tradeable" : "locked"}.`,
            ts: Date.now(),
          },
        },
      },
    ]);
    return { ok: true };
  });

  // Open a fresh options cycle on all configured underlyings.
  app.post("/:challengeId/options/open", async (req) => {
    const { challengeId } = req.params as { challengeId: string };
    const cmd: EngineCommand = {
      type: "open_option_cycle",
      challengeId,
      cycleId: "",
      underlying: "",
      strikes: [],
      expiresAt: 0,
      ts: Date.now(),
    };
    await publishCommand(app.redis, challengeId, cmd);
    return { ok: true };
  });

  // Close an options cycle, opening its 15-second exercise window.
  app.post("/:challengeId/options/close", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(z.object({ cycleId: z.string() }), req.body, reply);
    if (!body) return;
    const cmd: EngineCommand = {
      type: "close_option_cycle",
      challengeId,
      cycleId: body.cycleId,
      ts: Date.now(),
    };
    await publishCommand(app.redis, challengeId, cmd);
    return { ok: true };
  });

  // Create a Deal Desk OTC offer for a specific trader.
  app.post("/:challengeId/otc", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      zCreateOtcInput.omit({ challengeId: true }),
      req.body,
      reply,
    );
    if (!body) return;
    const expiresAt = new Date(Date.now() + body.expiresSec * 1000);
    const [row] = await app.db
      .insert(otcOffers)
      .values({
        challengeId,
        userId: body.userId,
        description: body.description,
        legs: body.legs,
        cashToTrader: body.cashToTrader,
        status: "pending",
        expiresAt,
        createdBy: req.user.sub,
      })
      .returning();
    const offer = {
      id: row!.id,
      challengeId,
      userId: row!.userId,
      description: row!.description,
      legs: row!.legs,
      cashToTrader: row!.cashToTrader,
      status: row!.status,
      expiresAt: row!.expiresAt.toISOString(),
      createdAt: row!.createdAt.toISOString(),
    };
    await publishBroadcast(app.redis, challengeId, [
      { target: body.userId, msg: { type: "otc_offer", challengeId, data: offer } },
    ]);
    return { offer };
  });

  // Open / close an ETF create-redeem window.
  app.post("/:challengeId/etf-window", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      z.object({ etfSymbol: z.string(), open: z.boolean() }),
      req.body,
      reply,
    );
    if (!body) return;
    const cmd: EngineCommand = {
      type: "etf_window",
      challengeId,
      etfSymbol: body.etfSymbol,
      open: body.open,
      ts: Date.now(),
    };
    await publishCommand(app.redis, challengeId, cmd);
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
    await app.db
      .delete(challengeNews)
      .where(eq(challengeNews.challengeId, challengeId));

    // Reset Redis prices/book to initial config.
    for (const s of challenge.config.symbols) {
      await setPrice(app.redis, challengeId, s.symbol, s.initialPrice, Date.now());
      await app.redis.del(redisKeys.bookSnapshot(challengeId, s.symbol));
      await app.redis.del(redisKeys.priceHistory(challengeId, s.symbol));
      await app.redis.del(redisKeys.priceHistoryMid(challengeId, s.symbol));
      await app.redis.del(redisKeys.fairValue(challengeId, s.symbol));
    }
    await app.redis.del(redisKeys.leaderboard(challengeId));
    await app.redis.del(redisKeys.fairValueSet(challengeId));
    await app.redis.del(redisKeys.lockedSymbols(challengeId));
    await clearNewsFeed(app.redis, challengeId);
    await clearTraderMetrics(app.redis, challengeId);
    // New Eden: clear outstanding loan debt on the participant ledger.
    await app.db
      .update(participants)
      .set({ loanDebt: 0 })
      .where(eq(participants.challengeId, challengeId));
    // Signal engines to reload this challenge from scratch.
    await app.redis.publish(`qtp:control:${challengeId}`, "reset");

    return { ok: true };
  });
}
