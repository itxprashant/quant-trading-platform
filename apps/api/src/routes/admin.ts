import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  auctions,
  bondHoldings,
  challengeNews,
  challenges,
  engineCheckpoints,
  eventActions,
  fairValues,
  grantMissions,
  loans,
  optionContracts,
  optionCycles,
  orders,
  otcOffers,
  participants,
  positions,
  scoreSnapshots,
  trades,
  users,
  voteProposals,
  type Challenge,
} from "@qtp/db";
import {
  EDEN_EVENT_AERIUM,
  EDEN_EVENT_DURATION_MINUTES,
  EDEN_EVENT_OPTIONS,
  edenEventStateAt,
  zCreateOtcInput,
  zEdenConfig,
  zEdenOptionsConfig,
  zEtfConfig,
  zPostNewsInput,
  zSymbolConfig,
  type ChallengeConfig,
  type EngineCommand,
} from "@qtp/shared";
import { redisKeys } from "@qtp/shared";
import {
  getFairValues,
  publishBroadcast,
  publishCommand,
  pushNews,
  setMarketFrozen,
  setPrice,
  setSymbolTradeable,
} from "@qtp/bus";
import { z } from "zod";
import { rateLimit } from "../ratelimit.js";
import { serializeNewsItem } from "../serialize.js";
import { validate } from "../util.js";
import {
  awardGrantMission,
  closeVote,
  resolveAuctionRound,
  scheduleEdenResolver,
} from "../eden-ops.js";

/** Whether a scripted event is in its pre-open or halftime halt. */
function scriptedHaltAt(challenge: Challenge, now: number): boolean {
  const eden = challenge.config.eden;
  if (
    challenge.type !== "new_eden" ||
    !eden?.eventScript ||
    !eden.rules.enabled ||
    !challenge.startsAt
  )
    return false;
  const start = challenge.startsAt.getTime();
  if (now < start) return true;
  if (!challenge.endsAt) return false;
  // The engine pins endsAt to startsAt + the scripted duration.
  const minuteMs =
    (challenge.endsAt.getTime() - start) / EDEN_EVENT_DURATION_MINUTES;
  return (
    minuteMs > 0 &&
    edenEventStateAt(((now - start) / minuteMs) * 60).phase === "halftime"
  );
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", app.requireAdmin);

  // List users.
  app.get("/users", async () => {
    const rows = await app.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        role: users.role,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));
    return rows.map((u) => ({
      ...u,
      createdAt: u.createdAt.toISOString(),
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    }));
  });

  // Set a drift target for a symbol; the engine biases the random walk toward it.
  app.post("/:challengeId/drift", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      z.object({
        symbol: z.string(),
        target: z.number().positive(),
        speed: z.number().min(1).max(10).default(5),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    await app.redis
      .pipeline()
      .set(
        `qtp:drift_target:${challengeId}:${body.symbol}`,
        String(body.target),
      )
      .set(`qtp:drift_speed:${challengeId}:${body.symbol}`, String(body.speed))
      .exec();
    return { ok: true };
  });

  // Hard-set a price (admin manipulation), reflected to clients next tick.
  app.post("/:challengeId/price", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      z.object({ symbol: z.string(), price: z.number().positive() }),
      req.body,
      reply,
    );
    if (!body) return;
    await setPrice(app.redis, challengeId, body.symbol, body.price, Date.now());
    return { ok: true };
  });

  // Post live news announcement for a challenge.
  app.post(
    "/:challengeId/news",
    {
      preHandler: [
        rateLimit({ bucket: "admin_news", limit: 10, windowMs: 60_000 }),
      ],
    },
    async (req, reply) => {
      const { challengeId } = req.params as { challengeId: string };
      const body = validate(zPostNewsInput, req.body, reply);
      if (!body) return;

      const challenge = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, challengeId),
      });
      if (!challenge) return reply.code(404).send({ error: "not_found" });

      const author = await app.db.query.users.findFirst({
        where: eq(users.id, req.user.sub),
        columns: { displayName: true },
      });

      // Future publish time keeps the item dormant until the engine publishes
      // it (see ChallengeRunner news scheduler). Past/now publishes immediately.
      const now = Date.now();
      const publishAt = body.publishAt ? new Date(body.publishAt) : null;
      const scheduled = publishAt != null && publishAt.getTime() > now;
      const embargoSec =
        body.embargoSec ??
        (challenge.type === "new_eden" && body.feed === "news" ? 10 : 0);
      const embargoUntil =
        embargoSec > 0
          ? new Date(
              (scheduled ? publishAt.getTime() : now) + embargoSec * 1000,
            )
          : null;
      const momentum = body.momentum?.length
        ? body.momentum
        : (body.fvEffects ?? [])
            .filter((e) => e.delta !== 0)
            .map((e) => ({
              symbol: e.symbol,
              sentiment: Math.sign(e.delta),
            }));

      const [row] = await app.db
        .insert(challengeNews)
        .values({
          challengeId,
          message: body.message,
          level: body.level,
          feed: body.feed,
          kind: body.kind,
          fvEffects: body.fvEffects ?? null,
          momentum,
          volEvent: !!body.volEvent,
          effectsAppliedAt: null,
          embargoUntil,
          publishAt,
          publishedAt: scheduled ? null : new Date(now),
          createdBy: req.user.sub,
        })
        .returning();

      const item = serializeNewsItem({
        ...row!,
        authorDisplayName: author?.displayName ?? null,
      });

      // Dormant scheduled items are neither cached nor broadcast, and their
      // signal/momentum effects fire only when the engine publishes them.
      if (scheduled) {
        return { item, scheduled: true };
      }

      await pushNews(app.redis, challengeId, item);
      await publishBroadcast(app.redis, challengeId, [
        { target: "all", msg: { type: "news", challengeId, data: item } },
      ]);

      // The runner polls published, unapplied rows and applies FV/momentum only
      // after embargoUntil, recording effectsAppliedAt for restart recovery.

      return { item };
    },
  );

  // Set a symbol's fair value directly (host control).
  app.post("/:challengeId/fair-value", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      z.object({ symbol: z.string(), fairValue: z.number().positive() }),
      req.body,
      reply,
    );
    if (!body) return;
    const cmd: EngineCommand = {
      type: "set_fair_value",
      challengeId,
      symbol: body.symbol,
      fairValue: body.fairValue,
      ts: Date.now(),
    };
    await publishCommand(app.redis, challengeId, cmd);
    return { ok: true };
  });

  // Read current fair values for the host console.
  app.get("/:challengeId/fair-value", async (req) => {
    const { challengeId } = req.params as { challengeId: string };
    return getFairValues(app.redis, challengeId);
  });

  // Halt matching on a live challenge without stopping the engine.
  app.post("/:challengeId/freeze", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(z.object({ frozen: z.boolean() }), req.body, reply);
    if (!body) return;
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, challengeId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });
    if (challenge.status !== "live") {
      return reply.code(409).send({ error: "challenge_not_live" });
    }
    // The script does not re-freeze, so an unfreeze here would end its halt early.
    if (!body.frozen && scriptedHaltAt(challenge, Date.now())) {
      return reply.code(409).send({ error: "scripted_halt" });
    }

    await app.db
      .update(challenges)
      .set({ frozen: body.frozen })
      .where(eq(challenges.id, challengeId));
    await setMarketFrozen(app.redis, challengeId, body.frozen);

    const cmd: EngineCommand = {
      type: "set_frozen",
      challengeId,
      frozen: body.frozen,
      ts: Date.now(),
    };
    await publishCommand(app.redis, challengeId, cmd);
    await publishBroadcast(app.redis, challengeId, [
      {
        target: "all",
        msg: {
          type: "market_status",
          challengeId,
          data: { frozen: body.frozen },
        },
      },
      {
        target: "all",
        msg: {
          type: "alert",
          challengeId,
          data: {
            level: body.frozen ? "warning" : "info",
            message: body.frozen
              ? "Market frozen — cancellations only."
              : "Market unfrozen.",
            ts: Date.now(),
          },
        },
      },
    ]);
    return { ok: true, frozen: body.frozen };
  });

  // Lock / unlock a symbol for trading (dynamic asset introduction).
  app.post("/:challengeId/tradeable", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      z.object({ symbol: z.string(), tradeable: z.boolean() }),
      req.body,
      reply,
    );
    if (!body) return;
    await setSymbolTradeable(
      app.redis,
      challengeId,
      body.symbol,
      body.tradeable,
    );
    await publishBroadcast(app.redis, challengeId, [
      {
        target: "all",
        msg: {
          type: "alert",
          challengeId,
          data: {
            level: "info",
            message: `${body.symbol} is now ${body.tradeable ? "tradeable" : "locked"}.`,
            ts: Date.now(),
          },
        },
      },
    ]);
    return { ok: true };
  });

  // Introduce a new spot asset into a live challenge (no pause). Persists to
  // the challenge config (so it survives a runner restart) and tells the engine
  // to list it immediately.
  app.post("/:challengeId/symbols", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      zSymbolConfig.extend({ locked: z.boolean().optional() }),
      req.body,
      reply,
    );
    if (!body) return;
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, challengeId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });

    const { locked, ...symbolCfg } = body;
    const exists =
      challenge.config.symbols.some((s) => s.symbol === symbolCfg.symbol) ||
      (await app.redis.sismember(
        redisKeys.listedSymbols(challengeId),
        symbolCfg.symbol,
      )) === 1;
    if (exists) return reply.code(409).send({ error: "symbol_exists" });

    const config: ChallengeConfig = {
      ...challenge.config,
      symbols: [...challenge.config.symbols, symbolCfg],
    };
    await app.db
      .update(challenges)
      .set({ config })
      .where(eq(challenges.id, challengeId));

    // Seed a starting price so late joiners / restarts have state.
    await setPrice(
      app.redis,
      challengeId,
      symbolCfg.symbol,
      symbolCfg.initialPrice,
      Date.now(),
    );
    const cmd: EngineCommand = {
      type: "add_symbol",
      challengeId,
      config: symbolCfg,
      locked: !!locked,
      ts: Date.now(),
    };
    await publishCommand(app.redis, challengeId, cmd);
    return { ok: true, symbol: symbolCfg.symbol };
  });

  // Introduce a new ETF into a live challenge (no pause). Persists to the eden
  // config bucket (created on demand for non-Eden challenges) and lists it.
  app.post("/:challengeId/etfs", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(zEtfConfig, req.body, reply);
    if (!body) return;
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, challengeId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });

    const eden = challenge.config.eden ?? zEdenConfig.parse({});
    if (eden.etfs?.some((e) => e.symbol === body.symbol)) {
      return reply.code(409).send({ error: "symbol_exists" });
    }
    const config: ChallengeConfig = {
      ...challenge.config,
      eden: { ...eden, etfs: [...(eden.etfs ?? []), body] },
    };
    await app.db
      .update(challenges)
      .set({ config })
      .where(eq(challenges.id, challengeId));

    const cmd: EngineCommand = {
      type: "add_etf",
      challengeId,
      config: body,
      ts: Date.now(),
    };
    await publishCommand(app.redis, challengeId, cmd);
    return { ok: true, symbol: body.symbol };
  });

  // Always persist enabled options; an omitted underlying uses the configured list.
  app.post("/:challengeId/options/open", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      z.object({ underlying: z.string().trim().min(1).optional() }),
      req.body ?? {},
      reply,
    );
    if (!body) return;

    const result = await app.db.transaction(async (tx) => {
      const [challenge] = await tx
        .select()
        .from(challenges)
        .where(eq(challenges.id, challengeId))
        .for("update");
      if (!challenge) return { error: "not_found" } as const;
      const eden = challenge.config.eden ?? zEdenConfig.parse({});
      const opts =
        eden.options ??
        zEdenOptionsConfig.parse({ enabled: true, autoCycle: false });
      const underlyings = Array.from(
        new Set([
          ...(opts.underlyings ?? []),
          ...(body.underlying ? [body.underlying] : []),
        ]),
      );
      if (
        underlyings.length === 0 ||
        underlyings.some((symbol) => !symbol.trim())
      ) {
        return { error: "invalid_underlyings" } as const;
      }
      const config: ChallengeConfig = {
        ...challenge.config,
        eden: {
          ...eden,
          options: {
            ...opts,
            enabled: true,
            underlyings,
            ...(body.underlying ? { autoCycle: false } : {}),
          },
        },
      };
      await tx
        .update(challenges)
        .set({ config })
        .where(eq(challenges.id, challengeId));
      return { challengeId: challenge.id };
    });
    if ("error" in result)
      return reply
        .code(result.error === "not_found" ? 404 : 400)
        .send({ error: result.error });

    const cmd: EngineCommand = {
      type: "open_option_cycle",
      challengeId: result.challengeId,
      cycleId: "",
      underlying: body.underlying ?? "",
      strikes: [],
      expiresAt: 0,
      ts: Date.now(),
    };
    await publishCommand(app.redis, result.challengeId, cmd);
    return { ok: true };
  });

  // Close an options cycle, opening its 15-second exercise window.
  app.post("/:challengeId/options/close", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(z.object({ cycleId: z.string() }), req.body, reply);
    if (!body) return;
    const cmd: EngineCommand = {
      type: "close_option_cycle",
      challengeId,
      cycleId: body.cycleId,
      ts: Date.now(),
    };
    await publishCommand(app.redis, challengeId, cmd);
    return { ok: true };
  });

  // Create a Deal Desk OTC offer for a specific trader.
  app.post("/:challengeId/otc", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      zCreateOtcInput.omit({ challengeId: true }),
      req.body,
      reply,
    );
    if (!body) return;
    const expiresAt = new Date(Date.now() + body.expiresSec * 1000);
    const [row] = await app.db
      .insert(otcOffers)
      .values({
        challengeId,
        userId: body.userId,
        description: body.description,
        legs: body.legs,
        cashToTrader: body.cashToTrader,
        status: "pending",
        expiresAt,
        createdBy: req.user.sub,
      })
      .returning();
    const offer = {
      id: row!.id,
      challengeId,
      userId: row!.userId,
      description: row!.description,
      legs: row!.legs,
      cashToTrader: row!.cashToTrader,
      status: row!.status,
      expiresAt: row!.expiresAt.toISOString(),
      createdAt: row!.createdAt.toISOString(),
    };
    await publishBroadcast(app.redis, challengeId, [
      {
        target: body.userId,
        msg: { type: "otc_offer", challengeId, data: offer },
      },
    ]);
    return { offer };
  });

  // Open / close an ETF create-redeem window.
  app.post("/:challengeId/etf-window", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      z.object({ etfSymbol: z.string(), open: z.boolean() }),
      req.body,
      reply,
    );
    if (!body) return;
    const cmd: EngineCommand = {
      type: "etf_window",
      challengeId,
      etfSymbol: body.etfSymbol,
      open: body.open,
      ts: Date.now(),
    };
    await publishCommand(app.redis, challengeId, cmd);
    return { ok: true };
  });

  /* ---- Phase 7: premium-feed blind auctions ---- */

  // Open a blind auction round for premium news access.
  app.post("/:challengeId/auction", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, challengeId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });
    const body = validate(
      z.object({ durationSec: z.number().int().min(5).max(600).optional() }),
      req.body ?? {},
      reply,
    );
    if (!body) return;
    if (
      challenge.status !== "live" ||
      (challenge.endsAt && challenge.endsAt.getTime() <= Date.now())
    ) {
      return reply.code(409).send({ error: "challenge_not_live" });
    }
    const durationSec =
      body.durationSec ?? challenge.config.eden?.auctionDurationSec ?? 30;
    const expiresAt = new Date(Date.now() + durationSec * 1000);
    const [row] = await app.db
      .insert(auctions)
      .values({ challengeId, status: "open", expiresAt })
      .returning();
    await publishBroadcast(app.redis, challengeId, [
      {
        target: "all",
        msg: {
          type: "auction",
          challengeId,
          data: {
            id: row!.id,
            challengeId,
            status: "open",
            expiresAt: row!.expiresAt.toISOString(),
            cutoff: null,
            createdAt: row!.createdAt.toISOString(),
          },
        },
      },
    ]);
    scheduleEdenResolver(durationSec * 1000, () =>
      resolveAuctionRound(app, challengeId, row!.id),
    );
    return { auctionId: row!.id };
  });

  // Manually resolve an auction round (timer backstop).
  app.post("/:challengeId/auction/:auctionId/resolve", async (req) => {
    const { challengeId, auctionId } = req.params as {
      challengeId: string;
      auctionId: string;
    };
    await resolveAuctionRound(app, challengeId, auctionId, { closeNow: true });
    return { ok: true };
  });

  /* ---- Phase 8: policy votes + government grants ---- */

  // Open a policy vote (solidarity wealth tax).
  app.post("/:challengeId/vote", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      z.object({
        title: z.string().min(1).max(120),
        description: z.string().min(1).max(500),
        durationSec: z.number().int().min(5).max(600).default(60),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    const expiresAt = new Date(Date.now() + body.durationSec * 1000);
    const [row] = await app.db
      .insert(voteProposals)
      .values({
        challengeId,
        title: body.title,
        description: body.description,
        kind: "wealth_tax",
        status: "open",
        expiresAt,
      })
      .returning();
    await publishBroadcast(app.redis, challengeId, [
      {
        target: "all",
        msg: {
          type: "vote",
          challengeId,
          data: {
            id: row!.id,
            challengeId,
            title: row!.title,
            description: row!.description,
            kind: "wealth_tax",
            status: "open",
            expiresAt: row!.expiresAt.toISOString(),
            yes: 0,
            no: 0,
            createdAt: row!.createdAt.toISOString(),
          },
        },
      },
    ]);
    scheduleEdenResolver(body.durationSec * 1000, () =>
      closeVote(app, challengeId, row!.id),
    );
    return { proposalId: row!.id };
  });

  // Manually close a vote (timer backstop).
  app.post("/:challengeId/vote/:proposalId/close", async (req) => {
    const { challengeId, proposalId } = req.params as {
      challengeId: string;
      proposalId: string;
    };
    await closeVote(app, challengeId, proposalId);
    return { ok: true };
  });

  // Open a government grant mission (largest holder at deadline wins the prize).
  app.post("/:challengeId/grant", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      z.object({
        symbol: z.string().min(1),
        description: z.string().min(1).max(500),
        prize: z.number().positive(),
        durationSec: z.number().int().min(5).max(3600).default(120),
      }),
      req.body,
      reply,
    );
    if (!body) return;
    const expiresAt = new Date(Date.now() + body.durationSec * 1000);
    const [row] = await app.db
      .insert(grantMissions)
      .values({
        challengeId,
        symbol: body.symbol,
        description: body.description,
        prize: body.prize,
        status: "open",
        expiresAt,
      })
      .returning();
    await publishBroadcast(app.redis, challengeId, [
      {
        target: "all",
        msg: {
          type: "grant",
          challengeId,
          data: {
            id: row!.id,
            challengeId,
            symbol: row!.symbol,
            description: row!.description,
            prize: row!.prize,
            status: "open",
            expiresAt: row!.expiresAt.toISOString(),
            winnerId: null,
            createdAt: row!.createdAt.toISOString(),
          },
        },
      },
    ]);
    scheduleEdenResolver(body.durationSec * 1000, () =>
      awardGrantMission(app, challengeId, row!.id),
    );
    return { grantId: row!.id };
  });

  // Manually award a grant (timer backstop).
  app.post("/:challengeId/grant/:grantId/award", async (req) => {
    const { challengeId, grantId } = req.params as {
      challengeId: string;
      grantId: string;
    };
    await awardGrantMission(app, challengeId, grantId, { closeNow: true });
    return { ok: true };
  });

  // Reset trading state for a single challenge (orders, trades, positions, prices).
  app.post("/:challengeId/reset", async (req, reply) => {
    const { challengeId: requestedId } = req.params as { challengeId: string };
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, requestedId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });
    const challengeId = challenge.id;

    if (challenge.status === "live") {
      return reply.code(409).send({ error: "pause_before_reset" });
    }
    const lockKey = redisKeys.engineLock(challengeId);
    const owner = `reset:${randomUUID()}`;
    if ((await app.redis.set(lockKey, owner, "EX", 120, "NX")) !== "OK") {
      return reply.code(409).send({
        error: "engine_still_running",
        message: "Pause the challenge and retry after its engine has stopped.",
      });
    }
    let lockLost = false;
    let renewal: Promise<void> | undefined;
    const renew = async () => {
      const held = await app.redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], 120) end return 0",
        1,
        lockKey,
        owner,
      );
      if (held !== 1) lockLost = true;
      if (lockLost) throw new Error("reset_lock_lost");
    };
    const heartbeat = setInterval(() => {
      if (!renewal)
        renewal = renew()
          .catch((error) => {
            lockLost = true;
            app.log.error(error, "Reset lease renewal failed");
          })
          .finally(() => {
            renewal = undefined;
          });
    }, 10_000);
    heartbeat.unref();
    try {
      const error = await app.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(challenges)
          .where(eq(challenges.id, challengeId))
          .for("update");
        if (!current) return "not_found";
        // An admin start that won the row lock before us must prevent reset.
        if (current.status === "live") return "pause_before_reset";
        await renew();
        const config: ChallengeConfig = current.config.eden?.eventScript
          ? {
              ...current.config,
              symbols: [{ ...EDEN_EVENT_AERIUM }],
              eden: {
                ...current.config.eden,
                bonds: [],
                etfs: [],
                options: { ...EDEN_EVENT_OPTIONS, enabled: false },
              },
            }
          : current.config;
        // Hold this row lock until cache cleanup completes, so lifecycle writers
        // cannot start a new run halfway through the reset.
        await tx
          .update(challenges)
          .set({
            config,
            status: "draft",
            frozen: false,
          finalizedAt: null,
          finalResults: null,
            startsAt: null,
            endsAt: null,
          })
          .where(eq(challenges.id, challengeId));
        await tx.delete(trades).where(eq(trades.challengeId, challengeId));
        await tx.delete(orders).where(eq(orders.challengeId, challengeId));
        await tx
          .delete(positions)
          .where(eq(positions.challengeId, challengeId));
        await tx
          .delete(challengeNews)
          .where(eq(challengeNews.challengeId, challengeId));
        await tx.delete(loans).where(eq(loans.challengeId, challengeId));
        await tx
          .delete(bondHoldings)
          .where(eq(bondHoldings.challengeId, challengeId));
        await tx
          .delete(otcOffers)
          .where(eq(otcOffers.challengeId, challengeId));
        await tx
          .delete(optionContracts)
          .where(eq(optionContracts.challengeId, challengeId));
        await tx
          .delete(optionCycles)
          .where(eq(optionCycles.challengeId, challengeId));
        // Auction bids and vote ballots cascade with their parent rows.
        await tx.delete(auctions).where(eq(auctions.challengeId, challengeId));
        await tx
          .delete(voteProposals)
          .where(eq(voteProposals.challengeId, challengeId));
        await tx
          .delete(grantMissions)
          .where(eq(grantMissions.challengeId, challengeId));
        await tx
          .delete(engineCheckpoints)
          .where(eq(engineCheckpoints.challengeId, challengeId));
        await tx
          .delete(eventActions)
          .where(eq(eventActions.challengeId, challengeId));
        await tx
          .delete(fairValues)
          .where(eq(fairValues.challengeId, challengeId));
        await tx
          .delete(scoreSnapshots)
          .where(eq(scoreSnapshots.challengeId, challengeId));
        await tx
          .update(participants)
          .set({
            cash: config.startingCash,
            startingCash: config.startingCash,
            loanDebt: 0,
          })
          .where(eq(participants.challengeId, challengeId));

        // Scan includes expired/dynamically removed instruments and premium flags,
        // not just the surviving challenge config. Never delete the held lease.
        for (const prefix of [
          "price",
          "phist",
          "phist-mid",
          "book",
          "fv",
          "premium",
          "drift_target",
          "drift_speed",
        ]) {
          let cursor = "0";
          do {
            await renew();
            const [next, keys] = await app.redis.scan(
              cursor,
              "MATCH",
              `qtp:${prefix}:${challengeId}:*`,
              "COUNT",
              500,
            );
            cursor = next;
            if (keys.length > 0) await app.redis.del(...keys);
          } while (cursor !== "0");
        }
        await app.redis.del(
          redisKeys.leaderboard(challengeId),
          redisKeys.newsFeed(challengeId),
          redisKeys.metrics(challengeId),
          redisKeys.fairValueSet(challengeId),
          redisKeys.fairValueSnapshot(challengeId),
          redisKeys.lockedSymbols(challengeId),
          redisKeys.marketFrozen(challengeId),
          redisKeys.listedSymbols(challengeId),
          redisKeys.etfWindows(challengeId),
          redisKeys.optionContracts(challengeId),
          redisKeys.commandStream(challengeId),
          redisKeys.commandCursor(challengeId),
          redisKeys.eventStream(challengeId),
          `qtp:final:${challengeId}`,
          `qtp:assignment-breaches:${challengeId}`,
        );
        await app.redis.srem(redisKeys.activeChallenges, challengeId);
        // Leave prices empty; the next explicit start seeds the fresh config.
        await renew();
        return null;
      });
      if (error)
        return reply.code(error === "not_found" ? 404 : 409).send({ error });
      return { ok: true };
    } finally {
      clearInterval(heartbeat);
      await renewal;
      await app.redis
        .eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
          1,
          lockKey,
          owner,
        )
        .catch((error) => app.log.error(error, "Reset lease release failed"));
    }
  });
}
