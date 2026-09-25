import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  challenges,
  otcOffers,
  participants,
  positions,
} from "@qtp/db";
import {
  getFairValues,
  getPrice,
  publishBroadcast,
  publishCommand,
} from "@qtp/bus";
import { bargainAskPct, bargainRejectProbability } from "@qtp/core";
import {
  zOtcRespondInput,
  type EngineCommand,
  type OtcOffer,
} from "@qtp/shared";
import { validate } from "../util.js";
import { scheduleEdenResolver } from "../eden-ops.js";

function serializeOffer(row: typeof otcOffers.$inferSelect): OtcOffer {
  return {
    id: row.id,
    challengeId: row.challengeId,
    userId: row.userId,
    description: row.description,
    legs: row.legs,
    choices: row.choices ?? undefined,
    cashToTrader: row.cashToTrader,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    settleAt: row.settleAt?.toISOString() ?? null,
  };
}

/**
 * The Deal Desk (comp_desc OTC bargaining). Traders see their pending offers
 * and reply ACCEPT / REJECT / BARGAIN. Bargaining runs a fair-value distance
 * probability check: the further below fair value the counter sits, the more
 * likely the desk walks. Accepted deals are binding and settle atomically.
 */
export async function otcRoutes(app: FastifyInstance): Promise<void> {
  app.get("/:challengeId", { preHandler: [app.authenticate] }, async (req) => {
    const { challengeId } = req.params as { challengeId: string };
    const rows = await app.db
      .select()
      .from(otcOffers)
      .where(
        and(
          eq(otcOffers.challengeId, challengeId),
          eq(otcOffers.userId, req.user.sub),
          inArray(otcOffers.status, ["pending", "accepted"]),
        ),
      )
      .orderBy(desc(otcOffers.createdAt))
      .limit(20);
    return rows
      .filter(
        (r) => r.status === "accepted" || r.expiresAt.getTime() > Date.now(),
      )
      .map(serializeOffer);
  });

  app.post(
    "/:offerId/respond",
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const { offerId } = req.params as { offerId: string };
      const input = validate(zOtcRespondInput, req.body, reply);
      if (!input) return;

      const offer = await app.db.query.otcOffers.findFirst({
        where: eq(otcOffers.id, offerId),
      });
      if (!offer) return reply.code(404).send({ error: "not_found" });
      if (offer.userId !== req.user.sub) {
        return reply.code(403).send({ error: "forbidden" });
      }
      if (offer.status !== "pending") {
        return reply.code(409).send({ error: "offer_not_pending" });
      }
      if (offer.expiresAt.getTime() <= Date.now()) {
        await app.db
          .update(otcOffers)
          .set({ status: "expired" })
          .where(
            and(eq(otcOffers.id, offerId), eq(otcOffers.status, "pending")),
          );
        return reply.code(409).send({ error: "offer_expired" });
      }

      const challengeId = offer.challengeId;
      const challenge = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, challengeId),
      });
      if (
        !challenge ||
        challenge.status !== "live" ||
        (challenge.endsAt && challenge.endsAt.getTime() <= Date.now())
      ) {
        return reply.code(409).send({ error: "challenge_not_live" });
      }
      const participant = await app.db.query.participants.findFirst({
        where: and(
          eq(participants.challengeId, challengeId),
          eq(participants.userId, req.user.sub),
        ),
      });
      if (!participant) return reply.code(403).send({ error: "not_enrolled" });
      const pendingClaim = and(
        eq(otcOffers.id, offerId),
        eq(otcOffers.status, "pending"),
        gt(otcOffers.expiresAt, sql`clock_timestamp()`),
      );
      const broadcastResult = async (status: OtcOffer["status"]) => {
        await publishBroadcast(app.redis, challengeId, [
          {
            target: offer.userId,
            msg: {
              type: "otc_result",
              challengeId,
              data: { offerId, status, ts: Date.now() },
            },
          },
        ]);
      };

      if (input.action === "reject") {
        const [claimed] = await app.db
          .update(otcOffers)
          .set({ status: "rejected" })
          .where(pendingClaim)
          .returning();
        if (!claimed)
          return reply.code(409).send({ error: "offer_not_pending" });
        await broadcastResult("rejected");
        return reply.send({ result: "rejected" });
      }

      if (challenge.frozen) {
        return reply.code(409).send({ error: "market_frozen" });
      }

      let legs = offer.legs;
      if (offer.choices != null) {
        const choice = offer.choices.find(
          (leg) => leg.symbol === input.choiceSymbol,
        );
        const quantity = input.choiceQuantity;
        if (
          !choice ||
          quantity == null ||
          !Number.isInteger(quantity) ||
          quantity < 1 ||
          quantity > 50 ||
          choice.quantity >= 0 ||
          quantity > -choice.quantity
        ) {
          return reply.code(400).send({ error: "invalid_choice" });
        }
        // Offer-time prices and maximums are immutable; ignore client-supplied legs/prices.
        legs = [
          { symbol: choice.symbol, quantity: -quantity, price: choice.price },
        ];
      } else if (input.choiceSymbol != null || input.choiceQuantity != null) {
        return reply.code(400).send({ error: "choice_not_available" });
      }

      let cashToTrader = offer.cashToTrader;

      if (input.action === "bargain") {
        const counter = input.counterCash ?? offer.cashToTrader;
        if (!Number.isFinite(counter))
          return reply.code(400).send({ error: "invalid_counter" });
        // Buy underpay and sell overask share one FV-notional edge.
        const fvs = await getFairValues(app.redis, challengeId);
        const askLegs = [];
        for (const leg of legs) {
          const fairValue =
            fvs[leg.symbol] ??
            (await getPrice(app.redis, challengeId, leg.symbol)) ??
            leg.price;
          askLegs.push({
            quantity: leg.quantity,
            price: leg.price,
            fairValue,
          });
        }
        const rejectProb = bargainRejectProbability(
          bargainAskPct(askLegs, counter),
        );
        if (Math.random() < rejectProb) {
          const [claimed] = await app.db
            .update(otcOffers)
            .set({ status: "rejected" })
            .where(pendingClaim)
            .returning();
          if (!claimed)
            return reply.code(409).send({ error: "offer_not_pending" });
          await broadcastResult("rejected");
          return reply.send({ result: "rejected", rejectProb });
        }
        cashToTrader = counter;
      }

      // Preliminary cap check only; the engine rechecks after the bargaining delay.
      // Working orders are ignored because the engine's reservation cancels them.
      // Cash is deliberately not a guard: an accepted deal can trigger a margin call.
      if (challenge.type === "new_eden") {
        const changes = new Map<string, number>();
        for (const leg of legs)
          changes.set(
            leg.symbol,
            (changes.get(leg.symbol) ?? 0) + leg.quantity,
          );
        const cap = challenge.config.eden?.rules.positionCap ?? 100;
        for (const [symbol, delta] of changes) {
          if (delta === 0) continue;
          const [position] = await app.db
            .select()
            .from(positions)
            .where(
              and(
                eq(positions.challengeId, challengeId),
                eq(positions.userId, req.user.sub),
                eq(positions.symbol, symbol),
              ),
            );
          const projected = (position?.quantity ?? 0) + delta;
          if (
            (delta > 0 && projected > cap) ||
            (delta < 0 && projected < -cap)
          ) {
            return reply.code(409).send({ error: "position_cap_exceeded" });
          }
        }
      }

      // Acceptance is binding, but only the engine may mark the deal settled.
      const [claimed] = await app.db
        .update(otcOffers)
        .set({
          status: "accepted",
          legs,
          cashToTrader,
          settleAt:
            input.action === "bargain"
              ? sql`clock_timestamp() + interval '5 seconds'`
              : sql`clock_timestamp()`,
        })
        .where(
          and(
            pendingClaim,
            sql`exists (select 1 from ${challenges}
            where ${challenges.id} = ${challengeId}
              and ${challenges.status} = 'live'
              and ${challenges.frozen} = false
              and (${challenges.endsAt} is null or ${challenges.endsAt} > clock_timestamp()))`,
          ),
        )
        .returning();
      if (!claimed) return reply.code(409).send({ error: "offer_not_pending" });
      const settleAt = claimed.settleAt!;
      const cmd: EngineCommand = {
        type: "execute_otc",
        challengeId,
        offerId,
        userId: offer.userId,
        legs: claimed.legs,
        cashToTrader: claimed.cashToTrader,
        ts: Date.now(),
      };
      // The runner also polls accepted rows, recovering crashes or lost timers.
      // Notify acceptance before enqueueing; settlement notifications are engine-owned.
      if (settleAt.getTime() > Date.now()) {
        scheduleEdenResolver(settleAt.getTime() - Date.now(), async () => {
          await publishCommand(app.redis, challengeId, {
            ...cmd,
            ts: Date.now(),
          });
        });
      } else {
        await publishCommand(app.redis, challengeId, cmd);
      }
      return reply.send({
        result: "accepted",
        message: "Awaiting engine reservation; acceptance is provisional.",
        legs: claimed.legs,
        cashToTrader: claimed.cashToTrader,
        settleAt: settleAt.toISOString(),
      });
    },
  );
}
