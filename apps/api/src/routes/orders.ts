import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { challenges, orders, participants, positions } from "@qtp/db";
import { clampOrderQuantity } from "@qtp/core";
import { zPlaceOrderInput, type EngineCommand } from "@qtp/shared";
import {
  checkRateLimit,
  checkVolumeLimit,
  isListedSymbol,
  isSymbolLocked,
  publishCommand,
} from "@qtp/bus";
import { z } from "zod";
import { validate } from "../util.js";
import { rateLimit } from "../ratelimit.js";

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  // Place an order: persist intent, forward to the engine.
  app.post("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const input = validate(zPlaceOrderInput, req.body, reply);
    if (!input) return;

    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, input.challengeId),
    });
    if (!challenge)
      return reply.code(404).send({ error: "challenge_not_found" });
    if (
      challenge.status !== "live" ||
      (challenge.endsAt && challenge.endsAt.getTime() <= Date.now())
    ) {
      return reply.code(409).send({ error: "challenge_not_live" });
    }
    if (challenge.frozen) {
      return reply.code(409).send({ error: "market_frozen" });
    }
    const knownSymbol =
      challenge.config.symbols.some((s) => s.symbol === input.symbol) ||
      (await isListedSymbol(app.redis, input.challengeId, input.symbol));
    if (!knownSymbol) {
      return reply.code(400).send({ error: "unknown_symbol" });
    }
    if (await isSymbolLocked(app.redis, input.challengeId, input.symbol)) {
      return reply.code(409).send({ error: "symbol_locked" });
    }
    if (input.type === "limit" && input.price == null) {
      return reply.code(400).send({ error: "limit_requires_price" });
    }
    const isAdmin = req.user.role === "admin";

    const maxOrdersPerSecond = challenge.config.maxOrdersPerSecond ?? 5;
    const orderRate = await checkRateLimit(
      app.redis,
      req.user.sub,
      `orders:${input.challengeId}`,
      maxOrdersPerSecond,
      1000,
    );
    reply.header("x-ratelimit-limit", String(maxOrdersPerSecond));
    reply.header("x-ratelimit-remaining", String(orderRate.remaining));
    if (!orderRate.allowed) {
      reply.header("retry-after", String(Math.ceil(orderRate.resetMs / 1000)));
      return reply.code(429).send({
        error: "rate_limited",
        retryAfterMs: orderRate.resetMs,
      });
    }

    // Auto-enroll the trader if they aren't a participant yet.
    await app.db
      .insert(participants)
      .values({
        challengeId: input.challengeId,
        userId: req.user.sub,
        startingCash: challenge.config.startingCash,
        cash: challenge.config.startingCash,
      })
      .onConflictDoNothing();

    const orderId = randomUUID();
    const maxOpenOrders = challenge.config.maxOpenOrders ?? 25;
    const maxVolumePerMinute = challenge.config.maxVolumePerMinute ?? 500;
    const result = await app.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${input.challengeId}), hashtext(${req.user.sub}))`,
      );
      const [open] = await tx
        .select({
          n: count(),
        })
        .from(orders)
        .where(
          and(
            eq(orders.challengeId, input.challengeId),
            eq(orders.userId, req.user.sub),
            inArray(orders.status, ["open", "partially_filled"]),
          ),
        );
      const openN = Number(open?.n ?? 0);
      if (openN >= maxOpenOrders) {
        return { error: "open_orders_exceeded" as const };
      }

      let acceptedQty = input.quantity;
      if (
        !isAdmin &&
        input.side === "buy" &&
        challenge.type === "new_eden"
      ) {
        const threshold =
          challenge.config.eden?.rules.marginCallThreshold ?? 0;
        const [part] = await tx
          .select({ cash: participants.cash })
          .from(participants)
          .where(
            and(
              eq(participants.challengeId, input.challengeId),
              eq(participants.userId, req.user.sub),
            ),
          );
        if ((part?.cash ?? 0) <= threshold) {
          return { error: "buys_blocked" as const };
        }
      }

      if (!isAdmin) {
        const [posRow] = await tx
          .select({ qty: positions.quantity })
          .from(positions)
          .where(
            and(
              eq(positions.challengeId, input.challengeId),
              eq(positions.userId, req.user.sub),
              eq(positions.symbol, input.symbol),
            ),
          );
        const working = await tx
          .select({
            side: orders.side,
            qty: sql<number>`coalesce(sum(${orders.remainingQuantity}), 0)`,
          })
          .from(orders)
          .where(
            and(
              eq(orders.challengeId, input.challengeId),
              eq(orders.userId, req.user.sub),
              eq(orders.symbol, input.symbol),
              inArray(orders.status, ["open", "partially_filled"]),
            ),
          )
          .groupBy(orders.side);
        let openBuyQty = 0;
        let openSellQty = 0;
        for (const row of working) {
          const qty = Number(row.qty ?? 0);
          if (row.side === "buy") openBuyQty = qty;
          else openSellQty = qty;
        }
        acceptedQty = clampOrderQuantity({
          side: input.side,
          requested: input.quantity,
          position: Number(posRow?.qty ?? 0),
          openBuyQty,
          openSellQty,
          maxOrderQuantity: challenge.config.maxOrderQuantity,
        });
        if (challenge.type === "new_eden") {
          const positionCap = challenge.config.eden?.rules.positionCap ?? 100;
          const position = Number(posRow?.qty ?? 0);
          const room =
            input.side === "buy"
              ? positionCap - position - openBuyQty
              : positionCap + position - openSellQty;
          // Order size and total signed exposure are independent Eden limits.
          acceptedQty = Math.max(
            0,
            Math.floor(
              Math.min(input.quantity, challenge.config.maxOrderQuantity, room),
            ),
          );
        }
        if (acceptedQty <= 0) {
          return { error: "no_capacity" as const };
        }
      }

      const volume = await checkVolumeLimit(
        app.redis,
        req.user.sub,
        input.challengeId,
        acceptedQty,
        maxVolumePerMinute,
        60_000,
      );
      if (!volume.allowed) {
        return {
          error: "volume_limited" as const,
          resetMs: volume.resetMs,
          remaining: volume.remaining,
        };
      }

      await tx.insert(orders).values({
        id: orderId,
        challengeId: input.challengeId,
        userId: req.user.sub,
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        quantity: acceptedQty,
        remainingQuantity: acceptedQty,
        price: input.price ?? null,
        status: "open",
      });
      return { acceptedQty, volumeRemaining: volume.remaining };
    });
    if ("error" in result) {
      if (result.error === "buys_blocked") {
        return reply.code(409).send({ error: "buys_blocked" });
      }
      if (result.error === "no_capacity") {
        return reply.code(409).send({ error: "no_capacity" });
      }
      if (result.error === "volume_limited") {
        reply.header("x-volume-limit", String(maxVolumePerMinute));
        reply.header("x-volume-remaining", String(result.remaining));
        reply.header("retry-after", String(Math.ceil(result.resetMs / 1000)));
        return reply.code(429).send({
          error: "volume_limited",
          retryAfterMs: result.resetMs,
        });
      }
      return reply.code(400).send({ error: result.error });
    }

    reply.header("x-volume-limit", String(maxVolumePerMinute));
    reply.header("x-volume-remaining", String(result.volumeRemaining));

    const cmd: EngineCommand = {
      type: "place_order",
      orderId,
      challengeId: input.challengeId,
      userId: req.user.sub,
      symbol: input.symbol,
      side: input.side,
      orderType: input.type,
      quantity: result.acceptedQty,
      price: input.price ?? null,
      ts: Date.now(),
      ...(isAdmin ? { admin: true } : {}),
      ...(input.timeInForce === "IOC" ? { timeInForce: "IOC" } : {}),
    };
    await publishCommand(app.redis, input.challengeId, cmd);

    return reply.code(202).send({
      orderId,
      status: "accepted",
      quantity: result.acceptedQty,
    });
  });

  // List own orders for a challenge.
  app.get("/", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { challengeId, open } = req.query as {
      challengeId?: string;
      open?: string;
    };
    if (!challengeId) {
      return reply.code(400).send({ error: "challengeId_required" });
    }
    const openOnly = open === "true";
    const rows = await app.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.challengeId, challengeId),
          eq(orders.userId, req.user.sub),
          openOnly
            ? inArray(orders.status, ["open", "partially_filled"])
            : undefined,
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(200);
    return rows.map((o) => ({
      id: o.id,
      challengeId: o.challengeId,
      userId: o.userId,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      quantity: o.quantity,
      remainingQuantity: o.remainingQuantity,
      price: o.price,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
    }));
  });

  // Cancel every working order owned by the caller on this challenge.
  app.post(
    "/cancel-all",
    {
      preHandler: [
        app.authenticate,
        rateLimit({
          bucket: "cancel-all",
          limit: 2,
          windowMs: 1000,
          by: "user",
        }),
      ],
    },
    async (req, reply) => {
      const body = validate(
        z.object({ challengeId: z.string().uuid() }),
        req.body,
        reply,
      );
      if (!body) return;

      const challenge = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, body.challengeId),
      });
      if (!challenge) return reply.code(404).send({ error: "not_found" });
      if (challenge.status === "draft" || challenge.status === "ended") {
        return reply.code(409).send({ error: "challenge_not_cancellable" });
      }

      const rows = await app.db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.challengeId, body.challengeId),
            eq(orders.userId, req.user.sub),
            inArray(orders.status, ["open", "partially_filled"]),
          ),
        );
      if (rows.length === 0) {
        return { cancelled: 0 };
      }

      await app.db
        .update(orders)
        .set({ status: "cancelled", remainingQuantity: 0 })
        .where(
          and(
            eq(orders.challengeId, body.challengeId),
            eq(orders.userId, req.user.sub),
            inArray(orders.status, ["open", "partially_filled"]),
          ),
        );

      for (const order of rows) {
        const cmd: EngineCommand = {
          type: "cancel_order",
          orderId: order.id,
          challengeId: order.challengeId,
          userId: req.user.sub,
          symbol: order.symbol,
          side: order.side,
          ts: Date.now(),
        };
        await publishCommand(app.redis, order.challengeId, cmd);
      }
      return { cancelled: rows.length };
    },
  );

  // Cancel an order.
  app.delete(
    "/:id",
    {
      preHandler: [
        app.authenticate,
        rateLimit({ bucket: "orders", limit: 25, windowMs: 1000, by: "user" }),
      ],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const order = await app.db.query.orders.findFirst({
        where: eq(orders.id, id),
      });
      if (!order) return reply.code(404).send({ error: "not_found" });
      if (order.userId !== req.user.sub) {
        return reply.code(403).send({ error: "forbidden" });
      }
      if (!["open", "partially_filled"].includes(order.status)) {
        return reply.code(409).send({ error: "order_not_cancellable" });
      }

      const challenge = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, order.challengeId),
      });
      if (!challenge) return reply.code(404).send({ error: "not_found" });
      if (challenge.status === "draft" || challenge.status === "ended") {
        return reply.code(409).send({ error: "challenge_not_cancellable" });
      }

      await app.db
        .update(orders)
        .set({ status: "cancelled", remainingQuantity: 0 })
        .where(eq(orders.id, id));

      const cmd: EngineCommand = {
        type: "cancel_order",
        orderId: id,
        challengeId: order.challengeId,
        userId: req.user.sub,
        symbol: order.symbol,
        side: order.side,
        ts: Date.now(),
      };
      await publishCommand(app.redis, order.challengeId, cmd);
      return reply.code(202).send({ status: "cancelled" });
    },
  );
}
