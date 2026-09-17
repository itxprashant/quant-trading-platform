import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { grantMissions, voteBallots, voteProposals } from "@qtp/db";
import { zCastVoteInput } from "@qtp/shared";
import { validate } from "../util.js";
import { rateLimit } from "../ratelimit.js";
import { awardGrantMission, closeVote } from "../eden-ops.js";

/**
 * Policy votes (Solidarity Tax) and government grant missions (comp_desc). The
 * active proposal and open grant for a challenge are surfaced together so the
 * terminal can show the vote panel and grant banner.
 */
export async function voteRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/:challengeId",
    { preHandler: [app.authenticate] },
    async (req) => {
      const { challengeId } = req.params as { challengeId: string };

      const proposal = await app.db.query.voteProposals.findFirst({
        where: eq(voteProposals.challengeId, challengeId),
        orderBy: desc(voteProposals.createdAt),
      });
      if (
        proposal &&
        proposal.status === "open" &&
        proposal.expiresAt.getTime() <= Date.now()
      ) {
        await closeVote(app, challengeId, proposal.id);
      }

      const grant = await app.db.query.grantMissions.findFirst({
        where: eq(grantMissions.challengeId, challengeId),
        orderBy: desc(grantMissions.createdAt),
      });
      if (
        grant &&
        grant.status === "open" &&
        grant.expiresAt.getTime() <= Date.now()
      ) {
        await awardGrantMission(app, challengeId, grant.id);
      }

      const fresh = await app.db.query.voteProposals.findFirst({
        where: eq(voteProposals.challengeId, challengeId),
        orderBy: desc(voteProposals.createdAt),
      });
      const freshGrant = await app.db.query.grantMissions.findFirst({
        where: eq(grantMissions.challengeId, challengeId),
        orderBy: desc(grantMissions.createdAt),
      });

      let myVote: "yes" | "no" | null = null;
      let tally = { yes: 0, no: 0 };
      if (fresh) {
        const ballots = await app.db
          .select()
          .from(voteBallots)
          .where(eq(voteBallots.proposalId, fresh.id));
        tally = {
          yes: ballots.filter((b) => b.choice === "yes").length,
          no: ballots.filter((b) => b.choice === "no").length,
        };
        const mine = ballots.find((b) => b.userId === req.user.sub);
        myVote = mine ? (mine.choice as "yes" | "no") : null;
      }

      return {
        proposal: fresh
          ? {
              id: fresh.id,
              challengeId,
              title: fresh.title,
              description: fresh.description,
              kind: fresh.kind,
              status: fresh.status,
              expiresAt: fresh.expiresAt.toISOString(),
              yes: tally.yes,
              no: tally.no,
              createdAt: fresh.createdAt.toISOString(),
            }
          : null,
        myVote,
        grant: freshGrant
          ? {
              id: freshGrant.id,
              challengeId,
              symbol: freshGrant.symbol,
              description: freshGrant.description,
              prize: freshGrant.prize,
              status: freshGrant.status,
              expiresAt: freshGrant.expiresAt.toISOString(),
              winnerId: freshGrant.winnerId,
              createdAt: freshGrant.createdAt.toISOString(),
            }
          : null,
      };
    },
  );

  app.post(
    "/:proposalId/vote",
    {
      preHandler: [
        app.authenticate,
        rateLimit({ bucket: "vote", limit: 10, windowMs: 10_000, by: "user" }),
      ],
    },
    async (req, reply) => {
      const { proposalId } = req.params as { proposalId: string };
      const input = validate(zCastVoteInput.omit({ proposalId: true }), req.body, reply);
      if (!input) return;

      const proposal = await app.db.query.voteProposals.findFirst({
        where: eq(voteProposals.id, proposalId),
      });
      if (!proposal) return reply.code(404).send({ error: "not_found" });
      if (proposal.status !== "open" || proposal.expiresAt.getTime() <= Date.now()) {
        return reply.code(409).send({ error: "vote_closed" });
      }

      await app.db
        .insert(voteBallots)
        .values({ proposalId, userId: req.user.sub, choice: input.choice })
        .onConflictDoUpdate({
          target: [voteBallots.proposalId, voteBallots.userId],
          set: { choice: input.choice },
        });
      return reply.code(202).send({ status: "accepted" });
    },
  );
}
