import { and, eq, gt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  auctions,
  grantMissions,
  participants,
  users,
  voteBallots,
  voteProposals,
} from "@qtp/db";
import { publishBroadcast, publishCommand } from "@qtp/bus";
import { tallyVote } from "@qtp/core";
import { EDEN_EVENT_DEFAULTS, type EngineCommand } from "@qtp/shared";

/** Default solidarity-tax brackets when a wealth-tax vote passes. */
export const WEALTH_TAX = {
  ratePct: EDEN_EVENT_DEFAULTS.taxRate,
  topPct: EDEN_EVENT_DEFAULTS.taxTopFraction,
  bottomPct: EDEN_EVENT_DEFAULTS.taxBottomFraction,
} as const;

/**
 * The engine owns ranking, atomic payment, entitlements, and result broadcasts.
 * Repeated requests are safe only when the engine deduplicates by auctionId.
 */
export async function resolveAuctionRound(
  app: FastifyInstance,
  challengeId: string,
  auctionId: string,
  { closeNow = false }: { closeNow?: boolean } = {},
): Promise<void> {
  const auction = await app.db.query.auctions.findFirst({
    where: and(
      eq(auctions.id, auctionId),
      eq(auctions.challengeId, challengeId),
    ),
  });
  if (!auction || auction.status !== "open") return;
  // The engine ignores rounds that have not expired; a host override closes
  // bidding first so it resolves now instead of silently waiting.
  if (closeNow)
    await app.db
      .update(auctions)
      .set({ expiresAt: new Date() })
      .where(
        and(
          eq(auctions.id, auctionId),
          eq(auctions.status, "open"),
          gt(auctions.expiresAt, new Date()),
        ),
      );

  await publishCommand(app.redis, challengeId, {
    type: "resolve_auction",
    challengeId,
    auctionId,
    ts: Date.now(),
  });
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
  const closed = await app.db.transaction(async (tx) => {
    const [proposal] = await tx
      .select()
      .from(voteProposals)
      .where(
        and(
          eq(voteProposals.id, proposalId),
          eq(voteProposals.challengeId, challengeId),
        ),
      )
      .for("update");
    if (!proposal || proposal.status !== "open") return null;
    const ballots = await tx
      .select({ choice: voteBallots.choice })
      .from(voteBallots)
      .innerJoin(
        participants,
        and(
          eq(participants.userId, voteBallots.userId),
          eq(participants.challengeId, challengeId),
        ),
      )
      .innerJoin(users, eq(users.id, voteBallots.userId))
      .where(
        and(eq(voteBallots.proposalId, proposalId), eq(users.role, "trader")),
      );
    const { passed } = tallyVote(
      ballots.map((b) => (b.choice === "yes" ? "yes" : "no")),
    );
    const [claimed] = await tx
      .update(voteProposals)
      .set({ status: passed ? "passed" : "failed" })
      .where(
        and(eq(voteProposals.id, proposalId), eq(voteProposals.status, "open")),
      )
      .returning();
    return claimed ? { proposal, ballots, passed } : null;
  });
  if (!closed) return;
  const { proposal, ballots, passed } = closed;

  // Persisted passed proposals also let the runner recover a failed enqueue.
  if (passed && proposal.kind === "wealth_tax") {
    await publishCommand(app.redis, challengeId, {
      type: "apply_wealth_tax",
      challengeId,
      proposalId,
      ...WEALTH_TAX,
      ts: Date.now(),
    });
  }

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
  { closeNow = false }: { closeNow?: boolean } = {},
): Promise<void> {
  const grant = await app.db.query.grantMissions.findFirst({
    where: and(
      eq(grantMissions.id, grantId),
      eq(grantMissions.challengeId, challengeId),
    ),
  });
  if (!grant || grant.status !== "open") return;
  // As with auctions, the engine only awards expired missions.
  if (closeNow) {
    const now = new Date();
    const [closed] = await app.db
      .update(grantMissions)
      .set({ expiresAt: now })
      .where(
        and(
          eq(grantMissions.id, grantId),
          eq(grantMissions.status, "open"),
          gt(grantMissions.expiresAt, now),
        ),
      )
      .returning({ expiresAt: grantMissions.expiresAt });
    if (closed) grant.expiresAt = closed.expiresAt;
  }

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
export function scheduleEdenResolver(
  ms: number,
  fn: () => Promise<void>,
): void {
  setTimeout(
    () => {
      fn().catch((err) => console.error("[eden] resolver error", err));
    },
    Math.max(0, ms),
  ).unref?.();
}
