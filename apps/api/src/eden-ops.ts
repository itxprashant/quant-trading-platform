import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  auctionBids,
  auctions,
  challenges,
  grantMissions,
  voteBallots,
  voteProposals,
} from "@qtp/db";
import {
  grantPremiumAccess,
  publishBroadcast,
  publishCommand,
} from "@qtp/bus";
import { resolveAuction, tallyVote } from "@qtp/core";
import type { BroadcastEnvelope, EngineCommand } from "@qtp/shared";

/** Default solidarity-tax brackets when a wealth-tax vote passes. */
export const WEALTH_TAX = { ratePct: 0.1, topPct: 0.1, bottomPct: 0.2 } as const;

/**
 * Resolve a blind auction round: rank sealed bids, grant the winners premium
 * news access (TTL from challenge config), publish the public cutoff, and notify
 * each bidder of their result. Idempotent — a no-op once the auction is resolved.
 */
export async function resolveAuctionRound(
  app: FastifyInstance,
  challengeId: string,
  auctionId: string,
): Promise<void> {
  const auction = await app.db.query.auctions.findFirst({
    where: eq(auctions.id, auctionId),
  });
  if (!auction || auction.status !== "open") return;

  const challenge = await app.db.query.challenges.findFirst({
    where: eq(challenges.id, challengeId),
  });
  const eden = challenge?.config.eden;
  const winnerFraction = eden?.auctionWinnerFraction ?? 0.3;
  const accessMs = (eden?.premiumAccessMinutes ?? 15) * 60_000;

  const bids = await app.db
    .select()
    .from(auctionBids)
    .where(eq(auctionBids.auctionId, auctionId));

  const { winners, cutoff } = resolveAuction(
    bids.map((b) => ({ userId: b.userId, amount: b.amount })),
    winnerFraction,
  );
  const winnerSet = new Set(winners);

  await app.db
    .update(auctions)
    .set({ status: "resolved", cutoff })
    .where(eq(auctions.id, auctionId));

  for (const b of bids) {
    const won = winnerSet.has(b.userId);
    if (won) {
      await app.db
        .update(auctionBids)
        .set({ won: true })
        .where(eq(auctionBids.id, b.id));
      await grantPremiumAccess(app.redis, challengeId, b.userId, accessMs);
    }
  }

  // Public cutoff to everyone; per-bidder win/lose result targeted.
  const envelopes: BroadcastEnvelope[] = [
    {
      target: "all",
      msg: {
        type: "auction",
        challengeId,
        data: {
          id: auctionId,
          challengeId,
          status: "resolved",
          expiresAt: auction.expiresAt.toISOString(),
          cutoff,
          createdAt: auction.createdAt.toISOString(),
        },
      },
    },
  ];
  for (const b of bids) {
    envelopes.push({
      target: b.userId,
      msg: {
        type: "auction_result",
        challengeId,
        data: {
          auctionId,
          cutoff,
          won: winnerSet.has(b.userId),
          ts: Date.now(),
        },
      },
    });
  }
  await publishBroadcast(app.redis, challengeId, envelopes);
}

/**
 * Close a policy vote: tally ballots, set the outcome, and — if a wealth-tax
 * proposal passes — instruct the engine to redistribute cash. Idempotent.
 */
export async function closeVote(
  app: FastifyInstance,
  challengeId: string,
  proposalId: string,
): Promise<void> {
  const proposal = await app.db.query.voteProposals.findFirst({
    where: eq(voteProposals.id, proposalId),
  });
  if (!proposal || proposal.status !== "open") return;

  const ballots = await app.db
    .select()
    .from(voteBallots)
    .where(eq(voteBallots.proposalId, proposalId));
  const { passed } = tallyVote(
    ballots.map((b) => (b.choice === "yes" ? "yes" : "no")),
  );

  await app.db
    .update(voteProposals)
    .set({ status: passed ? "passed" : "failed" })
    .where(eq(voteProposals.id, proposalId));

  await publishBroadcast(app.redis, challengeId, [
    {
      target: "all",
      msg: {
        type: "vote",
        challengeId,
        data: {
          id: proposal.id,
          challengeId,
          title: proposal.title,
          description: proposal.description,
          kind: proposal.kind as "wealth_tax",
          status: passed ? "passed" : "failed",
          expiresAt: proposal.expiresAt.toISOString(),
          yes: ballots.filter((b) => b.choice === "yes").length,
          no: ballots.filter((b) => b.choice === "no").length,
          createdAt: proposal.createdAt.toISOString(),
        },
      },
    },
  ]);

  if (passed && proposal.kind === "wealth_tax") {
    const cmd: EngineCommand = {
      type: "apply_wealth_tax",
      challengeId,
      ratePct: WEALTH_TAX.ratePct,
      topPct: WEALTH_TAX.topPct,
      bottomPct: WEALTH_TAX.bottomPct,
      ts: Date.now(),
    };
    await publishCommand(app.redis, challengeId, cmd);
  }
}

/**
 * Award a grant mission: hand off to the engine, which owns live positions and
 * cash. The engine picks the largest holder, credits the prize, persists the
 * winner, and broadcasts the resolved grant. Idempotent.
 */
export async function awardGrantMission(
  app: FastifyInstance,
  challengeId: string,
  grantId: string,
): Promise<void> {
  const grant = await app.db.query.grantMissions.findFirst({
    where: and(
      eq(grantMissions.id, grantId),
      eq(grantMissions.challengeId, challengeId),
    ),
  });
  if (!grant || grant.status !== "open") return;

  const cmd: EngineCommand = {
    type: "award_grant",
    challengeId,
    grantId,
    symbol: grant.symbol,
    description: grant.description,
    prize: grant.prize,
    expiresAt: grant.expiresAt.toISOString(),
    createdAt: grant.createdAt.toISOString(),
    ts: Date.now(),
  };
  await publishCommand(app.redis, challengeId, cmd);
}

/**
 * Schedule a resolver to run after `ms`. Best-effort in-process timer (single
 * VM); resolvers are idempotent so a missed timer can be retried manually.
 */
export function scheduleEdenResolver(ms: number, fn: () => Promise<void>): void {
  setTimeout(() => {
    fn().catch((err) => console.error("[eden] resolver error", err));
  }, Math.max(0, ms)).unref?.();
}
