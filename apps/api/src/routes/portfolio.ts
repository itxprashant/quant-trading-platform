import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { bondHoldings, challenges, loans, participants, positions } from "@qtp/db";
import { getPrice, getTraderMetrics } from "@qtp/bus";
import { computeScore, type ScorablePortfolio } from "@qtp/core";
import { redisKeys, type BondHolding, type Loan, type Portfolio } from "@qtp/shared";

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

      const isEden = challenge.type === "new_eden";
      const loanDebt = isEden ? (participant?.loanDebt ?? 0) : 0;
      const pnl = cash + marketValue - loanDebt;
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

      const base: Portfolio = {
        challengeId,
        cash,
        positions: positionsOut,
        marketValue,
        pnl,
        score,
        ...(metrics ? { metrics } : {}),
      };

      if (!isEden) return base;

      // New Eden extensions: loans, bonds, premium access, free cash.
      const loanRows = await app.db
        .select()
        .from(loans)
        .where(
          and(eq(loans.challengeId, challengeId), eq(loans.userId, req.user.sub)),
        )
        .orderBy(desc(loans.createdAt))
        .limit(50);

      // Reconcile per-loan remaining against the aggregate debt (FIFO oldest-first).
      const active = loanRows
        .filter((l) => l.status === "active")
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      let budget = loanDebt;
      const remainingByLoan = new Map<string, number>();
      for (const l of active) {
        const r = Math.max(0, Math.min(l.totalRepay, budget));
        remainingByLoan.set(l.id, r);
        budget -= r;
      }
      const loansOut: Loan[] = loanRows.map((l) => {
        const remaining = remainingByLoan.get(l.id) ?? 0;
        return {
          id: l.id,
          challengeId: l.challengeId,
          userId: l.userId,
          principal: l.principal,
          totalRepay: l.totalRepay,
          remaining,
          status: remaining > 0 ? "active" : "repaid",
          createdAt: l.createdAt.toISOString(),
        };
      });

      const bondRows = await app.db
        .select()
        .from(bondHoldings)
        .where(
          and(
            eq(bondHoldings.challengeId, challengeId),
            eq(bondHoldings.userId, req.user.sub),
          ),
        );
      const bondsOut: BondHolding[] = bondRows
        .filter((b) => b.quantity > 0)
        .map((b) => ({
          bondId: b.bondId,
          name: b.name,
          quantity: b.quantity,
          price: b.price,
          faceValue: b.faceValue,
          couponsPaid: b.couponsPaid,
        }));

      const premium =
        (await app.redis.get(
          redisKeys.premiumAccess(challengeId, req.user.sub),
        )) != null;

      return {
        ...base,
        loanDebt,
        freeCash: cash + marketValue - loanDebt,
        loans: loansOut,
        bonds: bondsOut,
        premium,
      };
    },
  );
}
