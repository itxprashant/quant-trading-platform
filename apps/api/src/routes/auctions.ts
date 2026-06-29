import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { auctionBids, auctions } from "@qtp/db";
import { hasPremiumAccess } from "@qtp/bus";
import { zAuctionBidInput } from "@qtp/shared";
import { validate } from "../util.js";
import { rateLimit } from "../ratelimit.js";
import { resolveAuctionRound } from "../eden-ops.js";

/**
 * Premium-feed blind auctions (comp_desc Section 3.3). Traders submit a single
 * sealed bid; the top fraction win early news access for a window. Bids are
 * never revealed — only the public cutoff after resolution.
 */
export async function auctionRoutes(app: FastifyInstance): Promise<void> {
  // Current auction for a challenge plus the caller's own bid + premium status.
  app.get(
    "/:challengeId",
    { preHandler: [app.authenticate] },
    async (req) => {
      const { challengeId } = req.params as { challengeId: string };
      const auction = await app.db.query.auctions.findFirst({
        where: eq(auctions.challengeId, challengeId),
        orderBy: desc(auctions.createdAt),
      });
      // Lazily resolve an expired-but-open auction (timer backstop).
      if (
        auction &&
        auction.status === "open" &&
        auction.expiresAt.getTime() <= Date.now()
      ) {
        await resolveAuctionRound(app, challengeId, auction.id);
        return currentAuction(app, challengeId, req.user.sub);
      }
      return currentAuction(app, challengeId, req.user.sub);
    },
  );

  // Place / update a sealed bid while the auction is open.
  app.post(
    "/:auctionId/bid",
    {
      preHandler: [
        app.authenticate,
        rateLimit({ bucket: "auction_bid", limit: 10, windowMs: 10_000, by: "user" }),
      ],
    },
    async (req, reply) => {
      const { auctionId } = req.params as { auctionId: string };
      const input = validate(zAuctionBidInput.omit({ auctionId: true }), req.body, reply);
      if (!input) return;

      const auction = await app.db.query.auctions.findFirst({
        where: eq(auctions.id, auctionId),
      });
      if (!auction) return reply.code(404).send({ error: "not_found" });
      if (auction.status !== "open" || auction.expiresAt.getTime() <= Date.now()) {
        return reply.code(409).send({ error: "auction_closed" });
      }

      await app.db
        .insert(auctionBids)
        .values({ auctionId, userId: req.user.sub, amount: input.amount })
        .onConflictDoUpdate({
          target: [auctionBids.auctionId, auctionBids.userId],
          set: { amount: input.amount },
        });
      return reply.code(202).send({ status: "accepted" });
    },
  );
}

async function currentAuction(
  app: FastifyInstance,
  challengeId: string,
  userId: string,
) {
  const auction = await app.db.query.auctions.findFirst({
    where: eq(auctions.challengeId, challengeId),
    orderBy: desc(auctions.createdAt),
  });
  const premium = await hasPremiumAccess(app.redis, challengeId, userId);
  if (!auction) return { auction: null, myBid: null, premium };
  const bid = await app.db.query.auctionBids.findFirst({
    where: and(
      eq(auctionBids.auctionId, auction.id),
      eq(auctionBids.userId, userId),
    ),
  });
  return {
    auction: {
      id: auction.id,
      challengeId: auction.challengeId,
      status: auction.status,
      expiresAt: auction.expiresAt.toISOString(),
      cutoff: auction.cutoff,
      createdAt: auction.createdAt.toISOString(),
    },
    myBid: bid ? { amount: bid.amount, won: bid.won } : null,
    premium,
  };
}
