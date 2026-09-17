import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { challenges, otcOffers } from "@qtp/db";
import { getFairValues, getPrice, publishBroadcast, publishCommand } from "@qtp/bus";
import { bargainRejectProbability } from "@qtp/core";
import {
  zOtcRespondInput,
  type EngineCommand,
  type OtcOffer,
} from "@qtp/shared";
import { validate } from "../util.js";

function serializeOffer(row: typeof otcOffers.$inferSelect): OtcOffer {
  return {
    id: row.id,
    challengeId: row.challengeId,
    userId: row.userId,
    description: row.description,
    legs: row.legs,
    cashToTrader: row.cashToTrader,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The Deal Desk (comp_desc OTC bargaining). Traders see their pending offers
 * and reply ACCEPT / REJECT / BARGAIN. Bargaining runs a fair-value distance
 * probability check: the further below fair value the counter sits, the more
 * likely the desk walks. Accepted deals are binding and settle atomically.
 */
export async function otcRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/:challengeId",
    { preHandler: [app.authenticate] },
    async (req) => {
      const { challengeId } = req.params as { challengeId: string };
      const rows = await app.db
        .select()
        .from(otcOffers)
        .where(
          and(
            eq(otcOffers.challengeId, challengeId),
            eq(otcOffers.userId, req.user.sub),
            eq(otcOffers.status, "pending"),
          ),
        )
        .orderBy(desc(otcOffers.createdAt))
        .limit(20);
      return rows
        .filter((r) => r.expiresAt.getTime() > Date.now())
        .map(serializeOffer);
    },
  );

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
          .where(eq(otcOffers.id, offerId));
        return reply.code(409).send({ error: "offer_expired" });
      }

      const challengeId = offer.challengeId;
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
        await app.db
          .update(otcOffers)
          .set({ status: "rejected" })
          .where(eq(otcOffers.id, offerId));
        await broadcastResult("rejected");
        return reply.send({ result: "rejected" });
      }

      let cashToTrader = offer.cashToTrader;

      if (input.action === "bargain") {
        const counter = input.counterCash ?? offer.cashToTrader;
        // Fair cash-to-trader makes the legs net-zero at fair value.
        const fvs = await getFairValues(app.redis, challengeId);
        let unitsValue = 0;
        let legCash = 0;
        for (const leg of offer.legs) {
          const fv =
            fvs[leg.symbol] ??
            (await getPrice(app.redis, challengeId, leg.symbol)) ??
            leg.price;
          unitsValue += leg.quantity * fv;
          legCash += leg.price * leg.quantity;
        }
        const fairCash = legCash - unitsValue;
        const surplus = counter - fairCash; // extra the trader is demanding
        const notional = Math.max(Math.abs(unitsValue), Math.abs(legCash), 1);
        const underpayPct = surplus > 0 ? surplus / notional : 0;
        const rejectProb = bargainRejectProbability(underpayPct);
        if (Math.random() < rejectProb) {
          await app.db
            .update(otcOffers)
            .set({ status: "rejected" })
            .where(eq(otcOffers.id, offerId));
          await broadcastResult("rejected");
          return reply.send({ result: "rejected", rejectProb });
        }
        cashToTrader = counter;
      }

      // Accept (or successful bargain): binding settlement.
      await app.db
        .update(otcOffers)
        .set({ status: "settled", cashToTrader })
        .where(eq(otcOffers.id, offerId));
      const cmd: EngineCommand = {
        type: "execute_otc",
        challengeId,
        offerId,
        userId: offer.userId,
        legs: offer.legs,
        cashToTrader,
        ts: Date.now(),
      };
      await publishCommand(app.redis, challengeId, cmd);
      await broadcastResult("settled");
      return reply.send({ result: "settled", cashToTrader });
    },
  );
}
