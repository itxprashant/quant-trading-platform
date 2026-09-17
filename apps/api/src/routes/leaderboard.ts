import type { FastifyInstance } from "fastify";
import { getLeaderboard } from "@qtp/bus";

export async function leaderboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/:challengeId", async (req) => {
    const { challengeId } = req.params as { challengeId: string };
    return getLeaderboard(app.redis, challengeId);
  });
}
