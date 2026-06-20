import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { challenges, participants, positions } from "@qtp/db";
import { getPrice, getTraderMetrics } from "@qtp/bus";
import { computeScore, type ScorablePortfolio } from "@qtp/core";
import type { Portfolio } from "@qtp/shared";

export async function portfolioRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/:challengeId",
    { preHandler: [app.authenticate] },
    async (req, reply): Promise<Portfolio | undefined> => {
      const { challengeId } = req.params as { challengeId: string };
      const challenge = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, challengeId),
      });
      if (!challenge) {
        reply.code(404).send({ error: "not_found" });
        return;
      }

      const rows = await app.db
        .select()
        .from(positions)
        .where(
          and(
            eq(positions.challengeId, challengeId),
            eq(positions.userId, req.user.sub),
          ),
        );

      const participant = await app.db.query.participants.findFirst({
        where: and(
          eq(participants.challengeId, challengeId),
          eq(participants.userId, req.user.sub),
        ),
      });

      let cash = participant?.cash ?? challenge.config.startingCash;
      let marketValue = 0;
      let absInventory = 0;
      const positionsOut: Portfolio["positions"] = [];
      for (const p of rows) {
        if (p.quantity === 0) continue;
        const price =
          (await getPrice(app.redis, challengeId, p.symbol)) ??
          challenge.config.symbols.find((s) => s.symbol === p.symbol)
            ?.initialPrice ??
          0;
        marketValue += p.quantity * price;
        absInventory += Math.abs(p.quantity);
        positionsOut.push({
          symbol: p.symbol,
          quantity: p.quantity,
          avgPrice: p.avgPrice,
        });
      }

      const metrics =
        (await getTraderMetrics(app.redis, challengeId, req.user.sub)) ??
        undefined;

      const pnl = cash + marketValue;
      const score = computeScore(
        {
          userId: req.user.sub,
          pnl,
          absInventory: metrics?.inventory ?? absInventory,
          spreadCapture: metrics?.spreadCapture,
          quoteUptime: metrics?.quoteUptime,
        } as ScorablePortfolio,
        challenge.scoring,
      );

      return {
        challengeId,
        cash,
        positions: positionsOut,
        marketValue,
        pnl,
        score,
        ...(metrics ? { metrics } : {}),
      };
    },
  );
}
