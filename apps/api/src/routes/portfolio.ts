import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  bondHoldings,
  challenges,
  engineCheckpoints,
  loans,
  optionContracts,
  participants,
  positions,
  scoreSnapshots,
} from "@qtp/db";
import { getPrice, getTraderMetrics } from "@qtp/bus";
import {
  computeScore,
  profitPnl,
  theoreticalOption,
  type EngineState,
  type ScorablePortfolio,
} from "@qtp/core";
import {
  redisKeys,
  type BondHolding,
  type Loan,
  type Portfolio,
  type TraderMetrics,
} from "@qtp/shared";

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
      if (!participant) {
        reply.code(404).send({ error: "not_enrolled" });
        return;
      }

      const isFinal =
        challenge.status === "ended" ||
        challenge.finalizedAt != null ||
        challenge.finalResults != null;
      const finalEntry = challenge.finalResults?.find(
        (entry) => entry.userId === req.user.sub,
      );
      const checkpoint = isFinal
        ? await app.db.query.engineCheckpoints.findFirst({
            where: eq(engineCheckpoints.challengeId, challengeId),
          })
        : undefined;
      const finalState = checkpoint?.state as EngineState | undefined;
      const finalScore =
        finalEntry ??
        (isFinal && !finalState && challenge.finalResults == null
          ? await app.db.query.scoreSnapshots.findFirst({
              where: and(
                eq(scoreSnapshots.challengeId, challengeId),
                eq(scoreSnapshots.userId, req.user.sub),
              ),
              orderBy: [
                desc(scoreSnapshots.capturedAt),
                desc(scoreSnapshots.id),
              ],
            })
          : undefined);
      if (
        finalState &&
        (finalState.version !== 1 ||
          finalState.config?.challengeId !== challengeId ||
          !Array.isArray(finalState.accounts) ||
          !finalState.prices ||
          typeof finalState.prices !== "object" ||
          Array.isArray(finalState.prices))
      ) {
        reply.code(503).send({ error: "final_valuation_unavailable" });
        return;
      }
      if (
        isFinal &&
        !finalState &&
        (challenge.finalResults != null || !finalScore)
      ) {
        reply.code(503).send({ error: "final_valuation_unavailable" });
        return;
      }
      const finalAccount = finalState?.accounts.find(
        (account) => account.userId === req.user.sub,
      );
      const cash = finalAccount?.cash ?? participant.cash;
      const isEden = challenge.type === "new_eden";
      const bondRows = isEden
        ? await app.db
            .select()
            .from(bondHoldings)
            .where(
              and(
                eq(bondHoldings.challengeId, challengeId),
                eq(bondHoldings.userId, req.user.sub),
              ),
            )
        : [];
      const contracts = isFinal
        ? []
        : await app.db
            .select()
            .from(optionContracts)
            .where(eq(optionContracts.challengeId, challengeId));
      let marketValue = 0;
      let absInventory = 0;
      const positionsOut: Portfolio["positions"] = [];
      for (const p of finalAccount?.positions ?? rows) {
        if (p.quantity === 0) continue;
        if (isFinal) {
          if (finalState) {
            const price = Object.hasOwn(finalState.prices, p.symbol)
              ? finalState.prices[p.symbol]
              : undefined;
            if (price === undefined || !Number.isFinite(price) || price < 0) {
              reply.code(503).send({ error: "final_valuation_unavailable" });
              return;
            }
            marketValue += p.quantity * price;
          }
          absInventory += Math.abs(p.quantity);
          positionsOut.push({
            symbol: p.symbol,
            quantity: p.quantity,
            avgPrice: p.avgPrice,
          });
          continue;
        }
        const option = contracts.find((c) => c.symbol === p.symbol);
        let price = await getPrice(app.redis, challengeId, p.symbol);
        if (option?.status === "expired") {
          price = 0;
        } else if (
          option &&
          (price == null || option.status === "exercise_window")
        ) {
          const underlying = challenge.config.symbols.find(
            (s) => s.symbol === option.underlying,
          );
          const spot =
            (await getPrice(app.redis, challengeId, option.underlying)) ??
            underlying?.initialPrice ??
            0;
          const fraction =
            option.status === "exercise_window"
              ? 0
              : Math.min(
                  1,
                  Math.max(
                    0,
                    (option.expiresAt.getTime() - Date.now()) /
                      Math.max(
                        1,
                        option.expiresAt.getTime() - option.createdAt.getTime(),
                      ),
                  ),
                );
          price = theoreticalOption(
            option.optionType === "put" ? "put" : "call",
            spot,
            option.strike,
            underlying?.volatility ?? 0,
            fraction,
          );
        }
        if (price == null) {
          const etf = challenge.config.eden?.etfs?.find(
            (e) => e.symbol === p.symbol,
          );
          if (etf) {
            price = 0;
            for (const leg of etf.basket) {
              price +=
                leg.weight *
                ((await getPrice(app.redis, challengeId, leg.symbol)) ??
                  challenge.config.symbols.find((s) => s.symbol === leg.symbol)
                    ?.initialPrice ??
                  0);
            }
          }
        }
        price ??=
          challenge.config.symbols.find((s) => s.symbol === p.symbol)
            ?.initialPrice ?? 0;
        marketValue += p.quantity * price;
        absInventory += Math.abs(p.quantity);
        positionsOut.push({
          symbol: p.symbol,
          quantity: p.quantity,
          avgPrice: p.avgPrice,
        });
      }

      const metrics: TraderMetrics | undefined = isFinal
        ? (finalEntry?.metrics ??
          (finalAccount
            ? {
                realizedPnl: finalAccount.metrics.realizedPnl,
                volume: finalAccount.metrics.volume,
                trades: finalAccount.metrics.trades,
                spreadCapture: finalAccount.metrics.spreadCapture,
                quoteUptime: finalAccount.metrics.quoteUptimeMs / 1000,
                inventory: absInventory,
              }
            : undefined))
        : ((await getTraderMetrics(app.redis, challengeId, req.user.sub)) ??
          undefined);

      marketValue += bondRows.reduce(
        (sum, b) => sum + Math.max(0, b.quantity) * b.faceValue,
        0,
      );
      const loanDebt = isEden
        ? (finalAccount?.loanDebt ?? participant.loanDebt)
        : 0;
      // Legacy snapshots retain total value even when no historical per-symbol marks exist.
      if (isFinal && !finalState && finalScore) {
        marketValue =
          finalScore.pnl + participant.startingCash + loanDebt - cash;
      }
      const pnl =
        finalScore?.pnl ??
        profitPnl(cash, marketValue, participant.startingCash, loanDebt);
      const score =
        finalScore?.score ??
        computeScore(
          {
            userId: req.user.sub,
            pnl,
            absInventory: isFinal
              ? absInventory
              : (metrics?.inventory ?? absInventory),
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
          and(
            eq(loans.challengeId, challengeId),
            eq(loans.userId, req.user.sub),
          ),
        )
        .orderBy(desc(loans.createdAt))
        .limit(50);

      const loansOut: Loan[] = loanRows.map((l) => {
        return {
          id: l.id,
          challengeId: l.challengeId,
          userId: l.userId,
          principal: l.principal,
          totalRepay: l.totalRepay,
          remaining: l.remaining,
          status: l.status,
          installment: l.installment,
          nextPaymentAt: l.nextPaymentAt?.toISOString() ?? null,
          fundedAt: l.fundedAt?.toISOString() ?? null,
          createdAt: l.createdAt.toISOString(),
        };
      });

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
        !isFinal &&
        (await app.redis.get(
          redisKeys.premiumAccess(challengeId, req.user.sub),
        )) != null;

      return {
        ...base,
        loanDebt,
        freeCash: cash,
        loans: loansOut,
        bonds: bondsOut,
        premium,
      };
    },
  );
}
