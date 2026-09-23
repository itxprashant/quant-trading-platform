import type { FastifyInstance } from "fastify";
import { getLeaderboard } from "@qtp/bus";
import { and, desc, eq } from "drizzle-orm";
import { challenges, scoreSnapshots, users } from "@qtp/db";

export async function leaderboardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/:challengeId",
    { preHandler: [app.optionalAuth] },
    async (req, reply) => {
      const { challengeId } = req.params as { challengeId: string };
      const challenge = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, challengeId),
      });
      if (!challenge) return reply.code(404).send({ error: "not_found" });
      if (challenge.leaderboardHidden && req.user?.role !== "admin") {
        return reply.code(403).send({ error: "leaderboard_hidden" });
      }
      if (challenge.finalResults != null) return challenge.finalResults;
      if (challenge.finalizedAt || challenge.status === "ended") {
        // Legacy events have no finalResults. Preserve their cache, or recover the last batch.
        const cached = await getLeaderboard(app.redis, challengeId).catch(
          () => [],
        );
        if (cached.length) return cached;
        // Keep the timestamp comparison in Postgres; JS Dates truncate legacy microseconds.
        const latest = app.db
          .select({ capturedAt: scoreSnapshots.capturedAt })
          .from(scoreSnapshots)
          .where(eq(scoreSnapshots.challengeId, challengeId))
          .orderBy(desc(scoreSnapshots.capturedAt), desc(scoreSnapshots.id))
          .limit(1);
        const entries = await app.db
          .select({
            userId: scoreSnapshots.userId,
            username: users.username,
            displayName: users.displayName,
            pnl: scoreSnapshots.pnl,
            score: scoreSnapshots.score,
          })
          .from(scoreSnapshots)
          .innerJoin(users, eq(users.id, scoreSnapshots.userId))
          .where(
            and(
              eq(scoreSnapshots.challengeId, challengeId),
              eq(scoreSnapshots.capturedAt, latest),
              eq(users.role, "trader"),
            ),
          );
        entries.sort(
          (a, b) => b.score - a.score || a.userId.localeCompare(b.userId),
        );
        return entries.map((entry, index) => ({ ...entry, rank: index + 1 }));
      }
      return getLeaderboard(app.redis, challengeId);
    },
  );
}
