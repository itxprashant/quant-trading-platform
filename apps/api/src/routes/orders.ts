import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { challenges, orders, participants } from "@qtp/db";
import { zPlaceOrderInput, type EngineCommand } from "@qtp/shared";
import { publishCommand } from "@qtp/bus";
import { validate } from "../util.js";
import { rateLimit } from "../ratelimit.js";

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  // Place an order: persist intent, forward to the engine.
  app.post(
    "/",
    {
      preHandler: [
        app.authenticate,
        rateLimit({ bucket: "orders", limit: 25, windowMs: 1000, by: "user" }),
      ],
    },
    async (req, reply) => {
      const input = validate(zPlaceOrderInput, req.body, reply);
      if (!input) return;

      const challenge = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, input.challengeId),
      });
      if (!challenge) return reply.code(404).send({ error: "challenge_not_found" });
      if (challenge.status !== "live") {
        return reply.code(409).send({ error: "challenge_not_live" });
      }
      if (!challenge.config.symbols.some((s) => s.symbol === input.symbol)) {
        return reply.code(400).send({ error: "unknown_symbol" });
      }
      if (input.type === "limit" && input.price == null) {
        return reply.code(400).send({ error: "limit_requires_price" });
      }
      if (input.quantity > challenge.config.maxOrderQuantity) {
        return reply.code(400).send({ error: "quantity_exceeds_limit" });
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
      await app.db.insert(orders).values({
        id: orderId,
        challengeId: input.challengeId,
        userId: req.user.sub,
        symbol: input.symbol,
        side: input.side,
        type: input.type,
        quantity: input.quantity,
        remainingQuantity: input.quantity,
        price: input.price ?? null,
        status: "open",
      });

      const cmd: EngineCommand = {
        type: "place_order",
        orderId,
        challengeId: input.challengeId,
        userId: req.user.sub,
        symbol: input.symbol,
        side: input.side,
        orderType: input.type,
        quantity: input.quantity,
        price: input.price ?? null,
        ts: Date.now(),
      };
      await publishCommand(app.redis, input.challengeId, cmd);

      return reply.code(202).send({ orderId, status: "accepted" });
    },
  );

  // List own orders for a challenge.
  app.get(
    "/",
    { preHandler: [app.authenticate] },
    async (req, reply) => {
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
