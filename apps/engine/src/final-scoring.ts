import { eq } from "drizzle-orm";
import { type Redis } from "@qtp/bus";
import {
  computeScore,
  endingSettlement,
  profitPnl,
  type EngineState,
} from "@qtp/core";
import {
  challenges,
  engineCheckpoints,
  getChallengeValuation,
  scoreSnapshots,
  type Database,
} from "@qtp/db";
import {
  bondMarkValue,
  redisKeys,
  type LeaderboardEntry,
  type SettlementAsset,
  type TraderMetrics,
} from "@qtp/shared";

/** Caller must halt matching/economic mutations and flush persistence before invoking this. */
export async function finalizeScores(
  db: Database,
  redis: Redis,
  challengeId: string,
): Promise<void> {
  // Keep this barrier even on failure: only an explicit reset may resume live scoring.
  await redis.set(`qtp:final:${challengeId}`, "1");
  const entries = await db.transaction(async (tx) => {
    const [challenge] = await tx
      .select()
      .from(challenges)
      .where(eq(challenges.id, challengeId))
      .for("update");
    if (!challenge)
      throw new Error(`Cannot finalize missing challenge ${challengeId}`);
    // A Redis retry must never recalculate or duplicate already committed final scores.
    if (challenge.finalResults != null) return challenge.finalResults;
    if (challenge.status !== "ended" && !challenge.frozen) {
      throw new Error(`Cannot finalize running challenge ${challengeId}`);
    }
    const checkpoint = await tx.query.engineCheckpoints.findFirst({
      where: eq(engineCheckpoints.challengeId, challengeId),
    });
    const state = checkpoint?.state as EngineState | undefined;
    if (
      !state ||
      state.version !== 1 ||
      state.config?.challengeId !== challengeId ||
      !Array.isArray(state.accounts) ||
      !state.prices ||
      typeof state.prices !== "object" ||
      Array.isArray(state.prices)
    ) {
      throw new Error(
        `Missing or invalid final engine checkpoint for ${challengeId}`,
      );
    }
    const valuation = await getChallengeValuation(
      tx,
      challengeId,
      async () => undefined,
      {
        now: checkpoint!.updatedAt.getTime(),
        marks: state.prices,
      },
    );
    if (!valuation)
      throw new Error(`Cannot finalize missing challenge ${challengeId}`);
    const savedAccounts = new Map(
      state.accounts.map((account) => [account.userId, account]),
    );
    const entries: LeaderboardEntry[] = valuation.accounts
      .filter((account) => account.role !== "admin")
      .map((account) => {
        const settlement = endingSettlement(
          account.cash,
          account.marketValue,
        );
        const pnl =
          valuation.challenge.type === "new_eden"
            ? settlement
            : profitPnl(
                account.cash,
                account.marketValue,
                account.startingCash,
                account.loanDebt,
              );
        const assets: SettlementAsset[] = [
          ...account.positions
            .filter((position) => position.quantity !== 0)
            .map((position) => {
              const mid = valuation.prices.get(position.symbol) ?? 0;
              return {
                symbol: position.symbol,
                quantity: position.quantity,
                mid,
                value: position.quantity * mid,
              };
            }),
          ...account.bonds
            .map((bond) => {
              const value = bondMarkValue(bond);
              return {
                symbol: bond.name,
                quantity: bond.quantity,
                mid: bond.quantity !== 0 ? value / bond.quantity : 0,
                value,
              };
            })
            .filter((asset) => asset.quantity !== 0 || asset.value !== 0),
        ];
        const saved = savedAccounts.get(account.userId);
        const metrics: TraderMetrics | undefined = saved
          ? {
              realizedPnl: saved.metrics.realizedPnl,
              volume: saved.metrics.volume,
              trades: saved.metrics.trades,
              spreadCapture: saved.metrics.spreadCapture,
              quoteUptime: saved.metrics.quoteUptimeMs / 1000,
              inventory: account.absInventory,
            }
          : undefined;
        if (
          metrics &&
          Object.values(metrics).some((value) => !Number.isFinite(value))
        ) {
          throw new Error(
            `Invalid final metrics for ${challengeId}:${account.userId}`,
          );
        }
        const score = computeScore(
          {
            userId: account.userId,
            pnl,
            absInventory: account.absInventory,
            spreadCapture: metrics?.spreadCapture,
            quoteUptime: metrics?.quoteUptime,
          },
          valuation.challenge.scoring,
        );
        return {
          rank: 0,
          userId: account.userId,
          username: account.username,
          displayName: account.displayName,
          pnl,
          score,
          ...(metrics ? { metrics } : {}),
          settlement,
          cash: account.cash,
          assets,
        };
      });
    entries.sort(
      (a, b) => b.score - a.score || a.userId.localeCompare(b.userId),
    );
    entries.forEach((entry, index) => {
      entry.rank = index + 1;
    });

    const capturedAt = new Date();
    if (entries.length) {
      await tx.insert(scoreSnapshots).values(
        entries.map((entry) => ({
          challengeId,
          userId: entry.userId,
          pnl: entry.pnl,
          score: entry.score,
          capturedAt,
        })),
      );
    }
    await tx
      .update(challenges)
      .set({ finalResults: entries })
      .where(eq(challenges.id, challengeId));
    return entries;
  });
  // Publish only after durable snapshots commit, including an empty final leaderboard.
  await redis.eval(
    `
    redis.call('SET', KEYS[1], ARGV[1])
    redis.call('PUBLISH', KEYS[2], ARGV[2])
    return 1
  `,
    2,
    redisKeys.leaderboard(challengeId),
    redisKeys.broadcastChannel(challengeId),
    JSON.stringify(entries),
    JSON.stringify([
      {
        target: "all",
        msg: { type: "leaderboard", challengeId, data: entries },
      },
    ]),
  );
}
