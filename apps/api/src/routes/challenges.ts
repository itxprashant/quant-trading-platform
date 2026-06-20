import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { challengeNews, challenges, participants, users } from "@qtp/db";
import {
  defaultScoringFor,
  zChallengeStatus,
  zCreateChallengeInput,
  zUpdateChallengeInput,
} from "@qtp/shared";
import {
  getNewsFeed,
  listActiveChallenges,
  markChallengeActive,
  markChallengeInactive,
  setNewsFeed,
  setPrice,
} from "@qtp/bus";
import { z } from "zod";
import { serializeChallenge, serializeNewsItem } from "../serialize.js";
import { slugify, validate } from "../util.js";

export async function challengeRoutes(app: FastifyInstance): Promise<void> {
  // List challenges. Traders never see drafts.
  app.get(
    "/",
    { preHandler: [app.optionalAuth] },
    async (req) => {
      const isAdmin = req.user?.role === "admin";
      const rows = await app.db
        .select({
          challenge: challenges,
          count: sql<number>`count(${participants.id})::int`,
        })
        .from(challenges)
        .leftJoin(participants, eq(participants.challengeId, challenges.id))
        .where(isAdmin ? undefined : ne(challenges.status, "draft"))
        .groupBy(challenges.id)
        .orderBy(desc(challenges.createdAt));
      return rows.map((r) => serializeChallenge(r.challenge, r.count));
    },
  );

  // Fetch by id or slug.
  app.get("/:idOrSlug", async (req, reply) => {
    const { idOrSlug } = req.params as { idOrSlug: string };
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        idOrSlug,
      );
    const row = await app.db.query.challenges.findFirst({
      where: isUuid
        ? eq(challenges.id, idOrSlug)
        : eq(challenges.slug, idOrSlug),
    });
    if (!row) return reply.code(404).send({ error: "not_found" });
    const countRows = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(participants)
      .where(eq(participants.challengeId, row.id));
    return serializeChallenge(row, countRows[0]?.count ?? 0);
  });

  // Recent news feed for a challenge (REST bootstrap before WS connects).
  app.get(
    "/:id/news",
    { preHandler: [app.optionalAuth] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const query = validate(
        z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
        req.query,
        reply,
      );
      if (!query) return;

      const challenge = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, id),
      });
      if (!challenge) return reply.code(404).send({ error: "not_found" });
      if (
        challenge.status === "draft" &&
        req.user?.role !== "admin"
      ) {
        return reply.code(404).send({ error: "not_found" });
      }

      let items = await getNewsFeed(app.redis, id, query.limit);
      if (items.length === 0) {
        const rows = await app.db
          .select({
            id: challengeNews.id,
            challengeId: challengeNews.challengeId,
            message: challengeNews.message,
            level: challengeNews.level,
            createdAt: challengeNews.createdAt,
            authorDisplayName: users.displayName,
          })
          .from(challengeNews)
          .leftJoin(users, eq(challengeNews.createdBy, users.id))
          .where(eq(challengeNews.challengeId, id))
          .orderBy(desc(challengeNews.createdAt))
          .limit(query.limit);
        items = rows.map((r) => serializeNewsItem(r));
        if (items.length > 0) {
          await setNewsFeed(app.redis, id, items);
        }
      }

      return { items };
    },
  );

  // Create (admin).
  app.post(
    "/",
    { preHandler: [app.requireAdmin] },
    async (req, reply) => {
      const input = validate(zCreateChallengeInput, req.body, reply);
      if (!input) return;
      const scoring = input.scoring ?? defaultScoringFor(input.type);
      let slug = slugify(input.name);
      const dupe = await app.db.query.challenges.findFirst({
        where: eq(challenges.slug, slug),
      });
      if (dupe) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;

      const [created] = await app.db
        .insert(challenges)
        .values({
          slug,
          name: input.name,
          description: input.description ?? null,
          type: input.type,
          status: "draft",
          config: input.config,
          scoring,
          startsAt: input.startsAt ? new Date(input.startsAt) : null,
          endsAt: input.endsAt ? new Date(input.endsAt) : null,
          createdBy: req.user.sub,
        })
        .returning();
      return reply.code(201).send(serializeChallenge(created!, 0));
    },
  );

  // Update config / metadata (admin).
  app.patch(
    "/:id",
    { preHandler: [app.requireAdmin] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const input = validate(zUpdateChallengeInput, req.body, reply);
      if (!input) return;
      const [updated] = await app.db
        .update(challenges)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.config !== undefined ? { config: input.config } : {}),
          ...(input.scoring !== undefined ? { scoring: input.scoring } : {}),
          ...(input.startsAt !== undefined
            ? { startsAt: input.startsAt ? new Date(input.startsAt) : null }
            : {}),
          ...(input.endsAt !== undefined
            ? { endsAt: input.endsAt ? new Date(input.endsAt) : null }
            : {}),
        })
        .where(eq(challenges.id, id))
        .returning();
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return serializeChallenge(updated);
    },
  );

  // Lifecycle transition (admin).
  app.post(
    "/:id/status",
    { preHandler: [app.requireAdmin] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = validate(
        z.object({ status: zChallengeStatus }),
        req.body,
        reply,
      );
      if (!body) return;
      const [updated] = await app.db
        .update(challenges)
        .set({ status: body.status })
        .where(eq(challenges.id, id))
        .returning();
      if (!updated) return reply.code(404).send({ error: "not_found" });

      if (body.status === "live") {
        // Seed prices and register the challenge so an engine claims it.
        for (const s of updated.config.symbols) {
          const existing = await app.redis.get(
            `qtp:price:${updated.id}:${s.symbol}`,
          );
          if (existing == null) {
            await setPrice(app.redis, updated.id, s.symbol, s.initialPrice, Date.now());
          }
        }
        await markChallengeActive(app.redis, updated.id);
      } else if (body.status === "ended" || body.status === "paused") {
        await markChallengeInactive(app.redis, updated.id);
      }
      return serializeChallenge(updated);
    },
  );

  // Join (trader).
  app.post(
    "/:id/join",
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const challenge = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, id),
      });
      if (!challenge) return reply.code(404).send({ error: "not_found" });
      if (challenge.status === "draft" || challenge.status === "ended") {
        return reply.code(409).send({ error: "challenge_not_joinable" });
      }
      await app.db
        .insert(participants)
        .values({
          challengeId: id,
          userId: req.user.sub,
          startingCash: challenge.config.startingCash,
          cash: challenge.config.startingCash,
        })
        .onConflictDoNothing();
      return { joined: true };
    },
  );

  // Internal: which challenges are active right now.
  app.get(
    "/_active/list",
    { preHandler: [app.requireAdmin] },
    async () => {
      return listActiveChallenges(app.redis);
    },
  );

  // Avoid unused import warnings for composed helpers.
  void and;
  void or;
}
