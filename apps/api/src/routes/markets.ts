import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { bondHoldings, challenges, participants } from "@qtp/db";
import {
  getEtfWindows,
  getPrice,
  isEtfWindowOpen,
  publishCommand,
} from "@qtp/bus";
import { etfNav } from "@qtp/core";
import {
  zEtfTradeInput,
  zPurchaseBondInput,
  type EngineCommand,
} from "@qtp/shared";
import { validate } from "../util.js";
import { rateLimit } from "../ratelimit.js";

/**
 * Bonds + ETFs (New Eden Session 1). Bond templates and ETF baskets live on the
 * challenge config; holdings and NAVs are resolved live.
 */
export async function bondEtfRoutes(app: FastifyInstance): Promise<void> {
  // Bond templates for a challenge plus the caller's holdings.
  app.get(
    "/:challengeId/bonds",
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const { challengeId } = req.params as { challengeId: string };
      const challenge = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, challengeId),
      });
      if (!challenge) return reply.code(404).send({ error: "not_found" });
      const templates = challenge.config.eden?.bonds ?? [];
      const holdings = await app.db
        .select()
        .from(bondHoldings)
        .where(
          and(
            eq(bondHoldings.challengeId, challengeId),
            eq(bondHoldings.userId, req.user.sub),
          ),
        );
      return {
        templates,
        holdings: holdings
          .filter((h) => h.quantity > 0)
          .map((h) => ({
            bondId: h.bondId,
            name: h.name,
            quantity: h.quantity,
            price: h.price,
            faceValue: h.faceValue,
            couponsPaid: h.couponsPaid,
          })),
      };
    },
  );

  app.post(
    "/bonds/purchase",
    {
      preHandler: [
        app.authenticate,
        rateLimit({ bucket: "bond", limit: 10, windowMs: 10_000, by: "user" }),
      ],
    },
    async (req, reply) => {
      const input = validate(zPurchaseBondInput, req.body, reply);
      if (!input) return;
      const challenge = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, input.challengeId),
      });
      if (!challenge) return reply.code(404).send({ error: "challenge_not_found" });
      if (challenge.status !== "live") {
        return reply.code(409).send({ error: "challenge_not_live" });
      }
      if (challenge.frozen) {
        return reply.code(409).send({ error: "market_frozen" });
      }
      const tpl = (challenge.config.eden?.bonds ?? []).find(
        (b) => b.id === input.bondId,
      );
      if (!tpl) return reply.code(400).send({ error: "unknown_bond" });
      const participant = await app.db.query.participants.findFirst({
        where: and(
          eq(participants.challengeId, input.challengeId),
          eq(participants.userId, req.user.sub),
        ),
      });
      if (!participant) return reply.code(403).send({ error: "not_enrolled" });
      if (!challenge.endsAt || challenge.endsAt.getTime() <= Date.now()) {
        return reply.code(409).send({ error: "invalid_bond_deadline" });
      }
      const existing = await app.db
        .select()
        .from(bondHoldings)
        .where(
          and(
            eq(bondHoldings.challengeId, input.challengeId),
            eq(bondHoldings.userId, req.user.sub),
            eq(bondHoldings.bondId, input.bondId),
          ),
        );
      if ((existing[0]?.quantity ?? 0) > 0) {
        return reply.code(409).send({ error: "bond_limit" });
      }
      const cmd: EngineCommand = {
        type: "purchase_bond",
        challengeId: input.challengeId,
        userId: req.user.sub,
        bondId: input.bondId,
        price: input.price,
        ts: Date.now(),
      };
      await publishCommand(app.redis, input.challengeId, cmd);
      return reply.code(202).send({ status: "accepted" });
    },
  );

  // ETF catalog with live NAVs and whether a create/redeem window is open.
  app.get("/:challengeId/etfs", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, challengeId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });
    const etfs = challenge.config.eden?.etfs ?? [];
    const openWindows = new Set(await getEtfWindows(app.redis, challengeId));
    const out = [];
    for (const etf of etfs) {
      const prices: Record<string, number> = {};
      for (const c of etf.basket) {
        prices[c.symbol] = (await getPrice(app.redis, challengeId, c.symbol)) ?? 0;
      }
      const marketPrice = await getPrice(app.redis, challengeId, etf.symbol);
      out.push({
        symbol: etf.symbol,
        name: etf.name ?? null,
        basket: etf.basket,
        nav: etfNav(etf.basket, prices),
        marketPrice: marketPrice ?? null,
        windowOpen: openWindows.has(etf.symbol),
      });
    }
    return { etfs: out };
  });

  app.post(
    "/etfs/trade",
    {
      preHandler: [
        app.authenticate,
        rateLimit({ bucket: "etf", limit: 10, windowMs: 10_000, by: "user" }),
      ],
    },
    async (req, reply) => {
      const input = validate(zEtfTradeInput, req.body, reply);
      if (!input) return;
      const challenge = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, input.challengeId),
      });
      if (!challenge) return reply.code(404).send({ error: "challenge_not_found" });
      if (challenge.status !== "live") {
        return reply.code(409).send({ error: "challenge_not_live" });
      }
      if (challenge.frozen) {
        return reply.code(409).send({ error: "market_frozen" });
      }
      const listed = (challenge.config.eden?.etfs ?? []).some(
        (e) => e.symbol === input.etfSymbol,
      );
      if (!listed) return reply.code(400).send({ error: "unknown_etf" });
      const participant = await app.db.query.participants.findFirst({
        where: and(
          eq(participants.challengeId, input.challengeId),
          eq(participants.userId, req.user.sub),
        ),
      });
      if (!participant) return reply.code(403).send({ error: "not_enrolled" });
      if (
        !(await isEtfWindowOpen(app.redis, input.challengeId, input.etfSymbol))
      ) {
        return reply.code(409).send({ error: "window_closed" });
      }
      const cmd: EngineCommand = {
        type: "etf_trade",
        challengeId: input.challengeId,
        userId: req.user.sub,
        etfSymbol: input.etfSymbol,
        action: input.action,
        quantity: input.quantity,
        ts: Date.now(),
      };
      await publishCommand(app.redis, input.challengeId, cmd);
      return reply.code(202).send({ status: "accepted" });
    },
  );
}
