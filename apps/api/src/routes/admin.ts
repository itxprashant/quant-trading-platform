import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ChallengeEngine, shiftEngineState, type EngineState } from "@qtp/core";
import {
  auctions,
  bondHoldings,
  challengeCheckpoints,
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
  restoreChallengeCheckpoint,
  resumedEndsAt,
  resumedStartsAt,
  saveChallengeCheckpoint,
  scoreSnapshots,
  trades,
  users,
  voteProposals,
  type Challenge,
  type CheckpointPayload,
} from "@qtp/db";
import {
  EDEN_DEMO_CUES,
  EDEN_EVENT_AERIUM,
  EDEN_EVENT_CUES,
  EDEN_EVENT_DURATION_MINUTES,
  EDEN_EVENT_OPTIONS,
  restoreNewEdenChallengeConfig,
  edenCueBlockers,
  edenCueReceiptId,
  edenCueStatus,
  edenCueVersion,
  edenEventCue,
  edenEventFlow,
  edenEventStateAt,
  bondMarkValue,
  formatBackupCsv,
  parseBackupCsv,
  zAdminAccountEditInput,
  zAdminBackupImportInput,
  zAdminBotsInput,
  zAdminCashAllInput,
  zAdminEnrollInput,
  zCreateOtcBody,
  zEdenConfig,
  zEdenOptionsConfig,
  zEtfConfig,
  zPostNewsInput,
  zSymbolConfig,
  zTraderPanel,
  traderVisibilityOf,
  type AdminAccountView,
  type AdminCheckpoint,
  type AdminCheckpointResume,
  type AdminStatistics,
  type AdminStatisticsColumn,
  type AdminCueSheet,
  type AdminCueView,
  type ChallengeConfig,
  type EdenEventAction,
  type EngineCommand,
} from "@qtp/shared";
import { redisKeys } from "@qtp/shared";
import {
  commandStreamTip,
  getFairValues,
  getListedSymbols,
  markChallengeActive,
  markChallengeInactive,
  publishBroadcast,
  publishCommand,
  pushNews,
  readCheckpointRedis,
  restoreCheckpointRedis,
  setMarketFrozen,
  setNewsFeed,
  setPrice,
  setSymbolTradeable,
  type CheckpointRedisState,
} from "@qtp/bus";
import { z } from "zod";
import { loadNewsFeed } from "../news-feed.js";
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

function cueStepLabel(action: EdenEventAction): string {
  switch (action.kind) {
    case "market_open":
      return "Open AERIUM and unfreeze";
    case "bond_available":
      return `List ${action.bond.name}`;
    case "list_underlying":
    case "list_etf":
      return `List ${action.config.symbol}`;
    case "freeze":
      return "Freeze trading, offer rescue loans";
    case "unfreeze":
      return "Resume trading";
    case "options_open":
      return "Start option cycles";
    case "news":
      return action.audience === "premium"
        ? "Headline to premium feed"
        : "Headline to everyone";
    case "auction_open":
      return "Bidding opens";
    case "auction_resolve":
      return "Auction resolves";
    case "otc_offer":
      return `Offer to every trader (${action.expiresAtSecond - action.atSecond} s to answer)`;
    case "etf_window":
      return action.open ? "ETF window opens" : "ETF window closes";
    case "vote_open":
      return "Vote opens";
    case "vote_resolve":
      return "Vote closes";
    case "grant_open":
      return "Grant mission opens";
    case "grant_award":
      return "Grant awarded";
    case "vega_prepare":
      return "Vega bots load options";
    case "vega_resolve":
      return "Vega bots dump";
    case "bot_volatility":
      return `Bot volatility ×${action.multiplier}`;
    case "end":
      return "Halt, final rankings";
  }
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", app.requireAdmin);

  // Malformed ids never match; querying them would make Postgres throw.
  const challengeExists = async (challengeId: string) =>
    z.string().uuid().safeParse(challengeId).success &&
    !!(await app.db.query.challenges.findFirst({
      where: eq(challenges.id, challengeId),
      columns: { id: true },
    }));

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

  // Hide or reveal rankings for non-admins. Scoring keeps running either way.
  app.post("/:challengeId/leaderboard-visibility", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(z.object({ hidden: z.boolean() }), req.body, reply);
    if (!body) return;
    if (!(await challengeExists(challengeId)))
      return reply.code(404).send({ error: "not_found" });

    await app.db
      .update(challenges)
      .set({ leaderboardHidden: body.hidden })
      .where(eq(challenges.id, challengeId));
    await publishBroadcast(app.redis, challengeId, [
      {
        target: "all",
        msg: {
          type: "leaderboard_visibility",
          challengeId,
          data: { hidden: body.hidden },
        },
      },
    ]);
    return { ok: true, hidden: body.hidden };
  });

  // Hide or reveal the whole event for non-admins. Admins keep full access.
  app.post("/:challengeId/event-visibility", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(z.object({ hidden: z.boolean() }), req.body, reply);
    if (!body) return;
    if (!(await challengeExists(challengeId)))
      return reply.code(404).send({ error: "not_found" });

    await app.db
      .update(challenges)
      .set({ hiddenFromTraders: body.hidden })
      .where(eq(challenges.id, challengeId));
    await publishBroadcast(app.redis, challengeId, [
      {
        target: "all",
        msg: {
          type: "event_visibility",
          challengeId,
          data: { hidden: body.hidden },
        },
      },
    ]);
    return { ok: true, hidden: body.hidden };
  });

  // Hide or reveal Eden panels for non-admins. Engine work continues either way.
  app.post("/:challengeId/trader-visibility", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      z.object({ panel: zTraderPanel, visible: z.boolean() }),
      req.body,
      reply,
    );
    if (!body) return;
    if (!z.string().uuid().safeParse(challengeId).success)
      return reply.code(404).send({ error: "not_found" });
    const row = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, challengeId),
      columns: { id: true, traderVisibility: true },
    });
    if (!row) return reply.code(404).send({ error: "not_found" });

    const visibility = {
      ...traderVisibilityOf(row.traderVisibility),
      [body.panel]: body.visible,
    };
    await app.db
      .update(challenges)
      .set({ traderVisibility: visibility })
      .where(eq(challenges.id, challengeId));
    await publishBroadcast(app.redis, challengeId, [
      {
        target: "all",
        msg: {
          type: "trader_visibility",
          challengeId,
          data: visibility,
        },
      },
    ]);
    return { ok: true, visibility };
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

  // Create a Deal Desk OTC offer for one trader or every enrolled trader.
  app.post("/:challengeId/otc", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      zCreateOtcBody,
      req.body,
      reply,
    );
    if (!body) return;
    if (!(await challengeExists(challengeId))) {
      return reply.code(404).send({ error: "not_found" });
    }
    const targets = body.sendToAll
      ? (
          await app.db
            .select({ userId: participants.userId })
            .from(participants)
            .where(eq(participants.challengeId, challengeId))
        ).map((r) => r.userId)
      : body.userId
        ? [body.userId]
        : [];
    if (targets.length === 0) {
      return reply.code(409).send({ error: "no_traders" });
    }
    const expiresAt = new Date(Date.now() + body.expiresSec * 1000);
    const rows = await app.db
      .insert(otcOffers)
      .values(
        targets.map((userId) => ({
          challengeId,
          userId,
          description: body.description,
          legs: body.legs,
          cashToTrader: body.cashToTrader,
          status: "pending" as const,
          expiresAt,
          createdBy: req.user.sub,
        })),
      )
      .returning();
    const offers = rows.map((row) => ({
      id: row.id,
      challengeId,
      userId: row.userId,
      description: row.description,
      legs: row.legs,
      cashToTrader: row.cashToTrader,
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    }));
    await publishBroadcast(
      app.redis,
      challengeId,
      offers.map((offer) => ({
        target: offer.userId,
        msg: { type: "otc_offer" as const, challengeId, data: offer },
      })),
    );
    return { offer: offers[0], offers, count: offers.length };
  });

  // Trader roster for the account editor: enrolled balances plus registered
  // traders who have not joined this challenge yet.
  app.get("/:challengeId/accounts", async (req, reply) => {
    const params = validate(
      z.object({ challengeId: z.string().uuid() }),
      req.params,
      reply,
    );
    if (!params) return;
    const [traders, rows, held] = await Promise.all([
      app.db
        .select({
          userId: users.id,
          username: users.username,
          displayName: users.displayName,
        })
        .from(users)
        .where(eq(users.role, "trader"))
        .orderBy(users.username),
      app.db
        .select({
          userId: participants.userId,
          username: users.username,
          displayName: users.displayName,
          cash: participants.cash,
          loanDebt: participants.loanDebt,
        })
        .from(participants)
        .innerJoin(users, eq(users.id, participants.userId))
        .where(eq(participants.challengeId, params.challengeId)),
      app.db
        .select({
          userId: positions.userId,
          symbol: positions.symbol,
          quantity: positions.quantity,
          avgPrice: positions.avgPrice,
        })
        .from(positions)
        .where(eq(positions.challengeId, params.challengeId)),
    ]);
    const enrolled = new Map(
      rows.map((row) => [
        row.userId,
        {
          ...row,
          enrolled: true,
          positions: held
            .filter((p) => p.userId === row.userId && p.quantity !== 0)
            .map(({ symbol, quantity, avgPrice }) => ({
              symbol,
              quantity,
              avgPrice,
            })),
        } satisfies AdminAccountView,
      ]),
    );
    const accounts: AdminAccountView[] = traders.map((trader) => {
      const row = enrolled.get(trader.userId);
      if (row) return row;
      return {
        userId: trader.userId,
        username: trader.username,
        displayName: trader.displayName,
        enrolled: false,
        cash: 0,
        loanDebt: 0,
        positions: [],
      };
    });
    const traderIds = new Set(traders.map((t) => t.userId));
    for (const row of enrolled.values()) {
      if (!traderIds.has(row.userId)) accounts.push(row);
    }
    accounts.sort((a, b) => a.username.localeCompare(b.username));
    return { accounts };
  });

  // Live cash, inventory, and bond balances for every enrolled trader.
  app.get("/:challengeId/statistics", async (req, reply) => {
    const params = validate(
      z.object({ challengeId: z.string().uuid() }),
      req.params,
      reply,
    );
    if (!params) return;
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, params.challengeId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });

    const [seated, held, bonds] = await Promise.all([
      app.db
        .select({
          userId: participants.userId,
          username: users.username,
          displayName: users.displayName,
          cash: participants.cash,
          startingCash: participants.startingCash,
          loanDebt: participants.loanDebt,
        })
        .from(participants)
        .innerJoin(users, eq(users.id, participants.userId))
        .where(eq(participants.challengeId, params.challengeId)),
      app.db
        .select({
          userId: positions.userId,
          symbol: positions.symbol,
          quantity: positions.quantity,
        })
        .from(positions)
        .where(eq(positions.challengeId, params.challengeId)),
      app.db
        .select({
          userId: bondHoldings.userId,
          bondId: bondHoldings.bondId,
          name: bondHoldings.name,
          quantity: bondHoldings.quantity,
          price: bondHoldings.price,
          faceValue: bondHoldings.faceValue,
          couponsPaid: bondHoldings.couponsPaid,
        })
        .from(bondHoldings)
        .where(eq(bondHoldings.challengeId, params.challengeId)),
    ]);

    const symbolOrder: string[] = [];
    const seenSymbols = new Set<string>();
    const addSymbol = (symbol: string) => {
      if (seenSymbols.has(symbol)) return;
      seenSymbols.add(symbol);
      symbolOrder.push(symbol);
    };
    for (const symbol of challenge.config.symbols) addSymbol(symbol.symbol);
    for (const etf of challenge.config.eden?.etfs ?? []) {
      addSymbol(etf.symbol);
      for (const leg of etf.basket) addSymbol(leg.symbol);
    }
    const extras = held
      .filter((row) => row.quantity !== 0)
      .map((row) => row.symbol)
      .sort();
    for (const symbol of extras) addSymbol(symbol);

    const quoted = new Map<string, number | null>();
    if (symbolOrder.length > 0) {
      const raw = await app.redis.mget(
        ...symbolOrder.map((symbol) =>
          redisKeys.price(params.challengeId, symbol),
        ),
      );
      symbolOrder.forEach((symbol, index) => {
        const value = raw[index];
        const price = value == null ? null : Number(value);
        quoted.set(
          symbol,
          price != null && Number.isFinite(price) ? price : null,
        );
      });
    }
    const markOf = (symbol: string, depth = 0): number => {
      const live = quoted.get(symbol);
      if (live != null) return live;
      const listed = challenge.config.symbols.find((s) => s.symbol === symbol);
      if (listed) return listed.initialPrice;
      const etf =
        depth < 2
          ? challenge.config.eden?.etfs?.find((row) => row.symbol === symbol)
          : undefined;
      if (etf) {
        return etf.basket.reduce(
          (sum, leg) => sum + leg.weight * markOf(leg.symbol, depth + 1),
          0,
        );
      }
      return 0;
    };

    const columns: AdminStatisticsColumn[] = [];
    const displaySymbols = new Set<string>();
    for (const symbol of challenge.config.symbols) {
      displaySymbols.add(symbol.symbol);
      columns.push({
        id: symbol.symbol,
        label: symbol.symbol,
        kind: "symbol",
        mark: markOf(symbol.symbol),
      });
    }
    for (const etf of challenge.config.eden?.etfs ?? []) {
      if (displaySymbols.has(etf.symbol)) continue;
      displaySymbols.add(etf.symbol);
      columns.push({
        id: etf.symbol,
        label: etf.symbol,
        kind: "symbol",
        mark: markOf(etf.symbol),
      });
    }
    for (const symbol of extras) {
      if (displaySymbols.has(symbol)) continue;
      displaySymbols.add(symbol);
      columns.push({
        id: symbol,
        label: symbol,
        kind: "symbol",
        mark: markOf(symbol),
      });
    }
    const bondColumns = new Map<string, string>();
    for (const bond of challenge.config.eden?.bonds ?? []) {
      bondColumns.set(bond.id, bond.name);
    }
    for (const holding of bonds) {
      if (holding.quantity > 0 && !bondColumns.has(holding.bondId)) {
        bondColumns.set(holding.bondId, holding.name);
      }
    }
    for (const [bondId, name] of bondColumns) {
      const sample = bonds.find((row) => row.bondId === bondId);
      const template = challenge.config.eden?.bonds?.find(
        (bond) => bond.id === bondId,
      );
      columns.push({
        id: `bond:${bondId}`,
        label: name,
        kind: "bond",
        mark: sample?.price ?? template?.price ?? 0,
      });
    }

    const inventory = new Map<string, Map<string, number>>();
    for (const row of held) {
      if (row.quantity === 0) continue;
      const book = inventory.get(row.userId) ?? new Map<string, number>();
      book.set(row.symbol, (book.get(row.symbol) ?? 0) + row.quantity);
      inventory.set(row.userId, book);
    }
    const bondBooks = new Map<
      string,
      Map<string, { quantity: number; value: number }>
    >();
    for (const holding of bonds) {
      if (holding.quantity <= 0) continue;
      const book =
        bondBooks.get(holding.userId) ??
        new Map<string, { quantity: number; value: number }>();
      const current = book.get(holding.bondId) ?? { quantity: 0, value: 0 };
      current.quantity += holding.quantity;
      current.value += bondMarkValue(holding);
      book.set(holding.bondId, current);
      bondBooks.set(holding.userId, book);
    }

    const rows: AdminStatistics["rows"] = seated
      .sort((a, b) => a.username.localeCompare(b.username))
      .map((trader) => {
        const holdings: Record<string, number> = {};
        let assets = 0;
        const book = inventory.get(trader.userId);
        if (book) {
          for (const [symbol, quantity] of book) {
            holdings[symbol] = quantity;
            assets += quantity * markOf(symbol);
          }
        }
        const bondBook = bondBooks.get(trader.userId);
        if (bondBook) {
          for (const [bondId, holding] of bondBook) {
            holdings[`bond:${bondId}`] = holding.quantity;
            assets += holding.value;
          }
        }
        const equity = trader.cash + assets - trader.loanDebt;
        return {
          userId: trader.userId,
          username: trader.username,
          displayName: trader.displayName,
          cash: trader.cash,
          loanDebt: trader.loanDebt,
          holdings,
          assets,
          equity,
          pnl: equity - trader.startingCash,
        };
      });

    const sheet: AdminStatistics = {
      asOf: new Date().toISOString(),
      columns,
      rows,
    };
    return sheet;
  });

  // Enroll registered traders in this challenge (starting cash, no join click).
  app.post("/:challengeId/enroll", async (req, reply) => {
    const params = validate(
      z.object({ challengeId: z.string().uuid() }),
      req.params,
      reply,
    );
    if (!params) return;
    const body = validate(zAdminEnrollInput, req.body, reply);
    if (!body) return;
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, params.challengeId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });
    if (
      challenge.status === "ended" ||
      (challenge.endsAt && challenge.endsAt.getTime() <= Date.now())
    ) {
      return reply.code(409).send({ error: "challenge_not_joinable" });
    }

    let ids = body.userIds ?? [];
    if (body.allTraders) {
      const traders = await app.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, "trader"));
      ids = traders.map((t) => t.id);
    } else {
      const found = await app.db
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, ids), eq(users.role, "trader")));
      ids = found.map((t) => t.id);
    }
    if (ids.length === 0) return { enrolled: 0, userIds: [] as string[] };

    const inserted = await app.db
      .insert(participants)
      .values(
        ids.map((userId) => ({
          challengeId: params.challengeId,
          userId,
          startingCash: challenge.config.startingCash,
          cash: challenge.config.startingCash,
        })),
      )
      .onConflictDoNothing()
      .returning({ userId: participants.userId });
    return {
      enrolled: inserted.length,
      userIds: inserted.map((row) => row.userId),
    };
  });

  // Set a trader's cash and/or inventory absolutely or by delta; the engine applies it.
  app.post("/:challengeId/accounts/:userId", async (req, reply) => {
    const params = validate(
      z.object({ challengeId: z.string().uuid(), userId: z.string().uuid() }),
      req.params,
      reply,
    );
    if (!params) return;
    const body = validate(zAdminAccountEditInput, req.body, reply);
    if (!body) return;
    const { challengeId, userId } = params;
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, challengeId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });
    // Only a running engine applies the command; queued edits would land later.
    if (challenge.status !== "live" || challenge.finalizedAt) {
      return reply.code(409).send({ error: "challenge_not_live" });
    }
    const participant = await app.db.query.participants.findFirst({
      where: and(
        eq(participants.challengeId, challengeId),
        eq(participants.userId, userId),
      ),
    });
    if (!participant) return reply.code(404).send({ error: "not_enrolled" });
    if (body.positions?.length) {
      const [listed, held] = await Promise.all([
        getListedSymbols(app.redis, challengeId),
        app.db
          .select({ symbol: positions.symbol })
          .from(positions)
          .where(
            and(
              eq(positions.challengeId, challengeId),
              eq(positions.userId, userId),
            ),
          ),
      ]);
      const known = new Set([
        ...challenge.config.symbols.map((s) => s.symbol),
        ...listed,
        ...held.map((p) => p.symbol),
      ]);
      const unknown = body.positions.find((p) => !known.has(p.symbol));
      if (unknown) {
        return reply
          .code(400)
          .send({ error: "unknown_symbol", symbol: unknown.symbol });
      }
    }
    const cmd: EngineCommand = {
      type: "admin_set_account",
      challengeId,
      userId,
      ...(body.cash !== undefined ? { cash: body.cash } : {}),
      ...(body.cashDelta !== undefined ? { cashDelta: body.cashDelta } : {}),
      ...(body.positions?.length ? { positions: body.positions } : {}),
      ts: Date.now(),
    };
    await publishCommand(app.redis, challengeId, cmd);
    req.log.info(
      {
        adminId: req.user.sub,
        challengeId,
        userId,
        cash: body.cash,
        cashDelta: body.cashDelta,
        positions: body.positions,
      },
      "admin account edit",
    );
    return reply.code(202).send({ ok: true });
  });

  // Set every enrolled trader's cash to the same absolute value.
  app.post("/:challengeId/accounts/cash-all", async (req, reply) => {
    const params = validate(
      z.object({ challengeId: z.string().uuid() }),
      req.params,
      reply,
    );
    if (!params) return;
    const body = validate(zAdminCashAllInput, req.body, reply);
    if (!body) return;
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, params.challengeId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });
    if (challenge.status !== "live" || challenge.finalizedAt) {
      return reply.code(409).send({ error: "challenge_not_live" });
    }
    const seated = await app.db
      .select({ userId: participants.userId })
      .from(participants)
      .where(eq(participants.challengeId, params.challengeId));
    if (seated.length === 0) {
      return reply.code(409).send({ error: "no_traders" });
    }
    const ts = Date.now();
    for (const row of seated) {
      const cmd: EngineCommand = {
        type: "admin_set_account",
        challengeId: params.challengeId,
        userId: row.userId,
        cash: body.cash,
        ts,
      };
      await publishCommand(app.redis, params.challengeId, cmd);
    }
    req.log.info(
      {
        adminId: req.user.sub,
        challengeId: params.challengeId,
        cash: body.cash,
        traders: seated.length,
      },
      "admin set cash for all",
    );
    return reply.code(202).send({ ok: true, count: seated.length });
  });

  // Snapshot every enrolled trader so the host can download and later restore.
  app.get("/:challengeId/backup.csv", async (req, reply) => {
    const params = validate(
      z.object({ challengeId: z.string().uuid() }),
      req.params,
      reply,
    );
    if (!params) return;
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, params.challengeId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });
    const [rows, held, bonds] = await Promise.all([
      app.db
        .select({
          userId: participants.userId,
          username: users.username,
          cash: participants.cash,
          loanDebt: participants.loanDebt,
        })
        .from(participants)
        .innerJoin(users, eq(users.id, participants.userId))
        .where(eq(participants.challengeId, params.challengeId)),
      app.db
        .select({
          userId: positions.userId,
          symbol: positions.symbol,
          quantity: positions.quantity,
          avgPrice: positions.avgPrice,
        })
        .from(positions)
        .where(eq(positions.challengeId, params.challengeId)),
      app.db
        .select()
        .from(bondHoldings)
        .where(eq(bondHoldings.challengeId, params.challengeId)),
    ]);
    const csv = formatBackupCsv({
      version: 1,
      challengeId: challenge.id,
      challengeSlug: challenge.slug,
      exportedAt: new Date().toISOString(),
      accounts: rows
        .sort((a, b) => a.username.localeCompare(b.username))
        .map((row) => ({
          username: row.username,
          userId: row.userId,
          cash: row.cash,
          loanDebt: row.loanDebt,
          positions: held
            .filter((p) => p.userId === row.userId && p.quantity !== 0)
            .map(({ symbol, quantity, avgPrice }) => ({
              symbol,
              quantity,
              avgPrice,
            })),
          bonds: bonds
            .filter((b) => b.userId === row.userId && b.quantity > 0)
            .map((b) => ({
              bondId: b.bondId,
              name: b.name,
              quantity: b.quantity,
              price: b.price,
              faceValue: b.faceValue,
              couponsPaid: b.couponsPaid,
            })),
        })),
    });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "");
    const slug = challenge.slug.replace(/[^a-zA-Z0-9._-]+/g, "-");
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="quantstorm-${slug}-backup-${stamp}.csv"`,
      )
      .send(csv);
  });

  // Restore the snapshot through the live engine (not a direct Postgres write).
  app.post(
    "/:challengeId/backup/import",
    { bodyLimit: 2_000_000 },
    async (req, reply) => {
      const params = validate(
        z.object({ challengeId: z.string().uuid() }),
        req.params,
        reply,
      );
      if (!params) return;
      const body = validate(zAdminBackupImportInput, req.body, reply);
      if (!body) return;
      const challenge = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, params.challengeId),
      });
      if (!challenge) return reply.code(404).send({ error: "not_found" });
      if (challenge.status !== "live" || challenge.finalizedAt) {
        return reply.code(409).send({ error: "challenge_not_live" });
      }
      let parsed;
      try {
        parsed = parseBackupCsv(body.csv);
      } catch {
        return reply.code(400).send({ error: "invalid_backup" });
      }
      if (parsed.challengeId && parsed.challengeId !== challenge.id) {
        return reply.code(409).send({ error: "wrong_challenge" });
      }
      if (
        !parsed.challengeId &&
        parsed.challengeSlug &&
        parsed.challengeSlug !== challenge.slug
      ) {
        return reply.code(409).send({ error: "wrong_challenge" });
      }
      if (parsed.accounts.length === 0) {
        return reply.code(400).send({ error: "empty_backup" });
      }
      const [roster, seated, listed, held] = await Promise.all([
        app.db
          .select({ userId: users.id, username: users.username })
          .from(users),
        app.db
          .select({ userId: participants.userId })
          .from(participants)
          .where(eq(participants.challengeId, params.challengeId)),
        getListedSymbols(app.redis, params.challengeId),
        app.db
          .select({ userId: positions.userId, symbol: positions.symbol })
          .from(positions)
          .where(eq(positions.challengeId, params.challengeId)),
      ]);
      const enrolled = new Set(seated.map((r) => r.userId));
      const byId = new Map(roster.map((u) => [u.userId, u]));
      const byName = new Map(
        roster.map((u) => [u.username.toLowerCase(), u]),
      );
      const known = new Set([
        ...challenge.config.symbols.map((s) => s.symbol),
        ...(challenge.config.eden?.etfs ?? []).map((e) => e.symbol),
        ...listed,
        ...held.map((p) => p.symbol),
      ]);
      const skipped: string[] = [];
      const accounts: Extract<
        EngineCommand,
        { type: "admin_restore_backup" }
      >["accounts"] = [];
      for (const row of parsed.accounts) {
        const match =
          (row.userId && byId.get(row.userId)) ||
          byName.get(row.username.toLowerCase());
        const label = row.username || row.userId || "unknown";
        if (!match) {
          skipped.push(label);
          continue;
        }
        if (!enrolled.has(match.userId)) {
          skipped.push(label);
          continue;
        }
        accounts.push({
          userId: match.userId,
          cash: row.cash,
          loanDebt: row.loanDebt,
          positions: row.positions.filter((p) => known.has(p.symbol)),
          bonds: row.bonds,
        });
      }
      if (accounts.length === 0) {
        return reply.code(400).send({ error: "no_matching_traders", skipped });
      }
      const cmd: EngineCommand = {
        type: "admin_restore_backup",
        challengeId: params.challengeId,
        accounts,
        ts: Date.now(),
      };
      await publishCommand(app.redis, params.challengeId, cmd);
      req.log.info(
        {
          adminId: req.user.sub,
          challengeId: params.challengeId,
          traders: accounts.length,
          skipped,
        },
        "admin backup import",
      );
      return reply.code(202).send({
        ok: true,
        count: accounts.length,
        skipped,
      });
    },
  );

  // Replace live bot counts without pausing the event.
  app.post("/:challengeId/bots", async (req, reply) => {
    const params = validate(
      z.object({ challengeId: z.string().uuid() }),
      req.params,
      reply,
    );
    if (!params) return;
    const body = validate(zAdminBotsInput, req.body, reply);
    if (!body) return;
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, params.challengeId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });
    if (challenge.status !== "live" || challenge.finalizedAt) {
      return reply.code(409).send({ error: "challenge_not_live" });
    }
    const cmd: EngineCommand = {
      type: "set_bots",
      challengeId: params.challengeId,
      ...(body.bots ? { bots: body.bots } : {}),
      ...(body.edenBots ? { edenBots: body.edenBots } : {}),
      ts: Date.now(),
    };
    await publishCommand(app.redis, params.challengeId, cmd);
    return reply.code(202).send({ ok: true });
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
    if (!(await challengeExists(challengeId))) {
      return reply.code(404).send({ error: "not_found" });
    }
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
    if (!(await challengeExists(challengeId))) {
      return reply.code(404).send({ error: "not_found" });
    }
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

  const cueReceipts = async (challengeId: string) =>
    app.db
      .select({
        actionId: eventActions.actionId,
        completedAt: eventActions.completedAt,
      })
      .from(eventActions)
      .where(eq(eventActions.challengeId, challengeId));

  // Playbook cue sheet. Admin-only because it carries the scripted headlines.
  app.get("/:challengeId/cues", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    if (!z.string().uuid().safeParse(challengeId).success)
      return reply.code(404).send({ error: "not_found" });
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, challengeId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });
    const rows = await cueReceipts(challenge.id);
    const receipts = new Set(rows.map((row) => row.actionId));
    const completedAt = new Map(
      rows.map((row) => [row.actionId, row.completedAt]),
    );
    const flow =
      challenge.type === "new_eden"
        ? edenEventFlow(challenge.config.eden)
        : "host";
    const catalog = flow === "demo" ? EDEN_DEMO_CUES : EDEN_EVENT_CUES;
    const cues: AdminCueView[] = catalog.map((cue) => {
      const anchor = cue.actions[0]!.atSecond;
      const headlines = new Map<string, AdminCueView["headlines"][number]>();
      for (const action of cue.actions)
        if (action.kind === "news")
          headlines.set(action.news.id, {
            minute: action.news.minute,
            classification: action.news.classification,
            text: action.news.headline,
          });
      return {
        id: cue.id,
        label: cue.label,
        minute: cue.minute,
        kind: cue.kind,
        status: edenCueStatus(cue, receipts, catalog),
        blockedBy: edenCueBlockers(cue, receipts, catalog),
        firedAt:
          completedAt
            .get(edenCueReceiptId(cue.id, edenCueVersion(cue)))
            ?.toISOString() ?? null,
        steps: cue.actions.map((action) => ({
          offsetSec: action.atSecond - anchor,
          label: cueStepLabel(action),
          done: receipts.has(action.id),
        })),
        headlines: [...headlines.values()],
      };
    });
    const sheet: AdminCueSheet = {
      flow,
      next:
        cues.find((c) => c.status === "ready" || c.status === "blocked")?.id ??
        null,
      cues,
    };
    return sheet;
  });

  // Fire one playbook cue; the engine runs its beats with their built-in timing.
  app.post("/:challengeId/cues/run", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const body = validate(
      z.object({ cueId: z.string().min(1).max(64) }),
      req.body,
      reply,
    );
    if (!body) return;
    if (!z.string().uuid().safeParse(challengeId).success)
      return reply.code(404).send({ error: "not_found" });
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, challengeId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });
    const flow = edenEventFlow(challenge.config.eden);
    if (challenge.type !== "new_eden" || (flow !== "cues" && flow !== "demo"))
      return reply.code(409).send({ error: "not_cue_mode" });
    if (challenge.status !== "live" || challenge.finalizedAt)
      return reply.code(409).send({ error: "challenge_not_live" });
    const catalog = flow === "demo" ? EDEN_DEMO_CUES : EDEN_EVENT_CUES;
    const cue = edenEventCue(body.cueId, catalog);
    if (!cue) return reply.code(404).send({ error: "unknown_cue" });
    const receipts = new Set(
      (await cueReceipts(challenge.id)).map((row) => row.actionId),
    );
    const status = edenCueStatus(cue, receipts, catalog);
    if (status === "running" || status === "done")
      return reply.code(409).send({ error: "cue_already_run" });
    if (status === "blocked")
      return reply.code(409).send({
        error: "cue_blocked",
        blockedBy: edenCueBlockers(cue, receipts, catalog),
      });
    // The engine drops OTC offers while frozen, so the cue would do nothing.
    if (challenge.frozen && cue.actions.some((a) => a.kind === "otc_offer"))
      return reply.code(409).send({ error: "market_frozen" });
    const cmd: EngineCommand = {
      type: "run_cue",
      challengeId: challenge.id,
      cueId: cue.id,
      ts: Date.now(),
    };
    await publishCommand(app.redis, challenge.id, cmd);
    return reply.code(202).send({ ok: true });
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
        const config = restoreNewEdenChallengeConfig(
          current.config,
          current.slug,
        );
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
          "phist-mid-5m",
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
          redisKeys.etfWindowClock(challengeId),
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

  // Rewind points, newest first. Payloads stay in Postgres.
  app.get("/:challengeId/checkpoints", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    if (!(await challengeExists(challengeId)))
      return reply.code(404).send({ error: "not_found" });
    const rows = await app.db
      .select({
        id: challengeCheckpoints.id,
        takenAt: challengeCheckpoints.takenAt,
        minuteCount: challengeCheckpoints.minuteCount,
        reason: challengeCheckpoints.reason,
      })
      .from(challengeCheckpoints)
      .where(eq(challengeCheckpoints.challengeId, challengeId))
      .orderBy(desc(challengeCheckpoints.takenAt));
    return {
      items: rows.map(
        (r): AdminCheckpoint => ({
          id: r.id,
          takenAt: r.takenAt.toISOString(),
          minuteCount: r.minuteCount,
          reason: r.reason === "before_resume" ? "before_resume" : "auto",
        }),
      ),
    };
  });

  // Resume from a checkpoint: its state comes back and every clock slides
  // forward, so the event continues from that moment with the same time left.
  app.post(
    "/:challengeId/checkpoints/:checkpointId/resume",
    async (req, reply) => {
      const { challengeId, checkpointId } = req.params as {
        challengeId: string;
        checkpointId: string;
      };
      const uuid = z.string().uuid();
      if (!uuid.safeParse(checkpointId).success)
        return reply.code(404).send({ error: "checkpoint_not_found" });
      if (!(await challengeExists(challengeId)))
        return reply.code(404).send({ error: "not_found" });
      const challenge = (await app.db.query.challenges.findFirst({
        where: eq(challenges.id, challengeId),
      }))!;
      if (challenge.finalizedAt != null || challenge.status === "ended")
        return reply.code(409).send({ error: "challenge_ended" });
      if (challenge.status !== "live" && challenge.status !== "paused")
        return reply.code(409).send({ error: "not_running" });
      const checkpoint = await app.db.query.challengeCheckpoints.findFirst({
        where: and(
          eq(challengeCheckpoints.id, checkpointId),
          eq(challengeCheckpoints.challengeId, challengeId),
        ),
      });
      if (!checkpoint)
        return reply.code(404).send({ error: "checkpoint_not_found" });
      const payload = checkpoint.payload as CheckpointPayload;
      const redisState = payload.redis as CheckpointRedisState;
      let state: EngineState;
      try {
        if (payload.version !== 1 || !Array.isArray(redisState?.listedSymbols))
          throw new Error("Unsupported checkpoint payload");
        state = payload.engine.state as EngineState;
        // The engine would crash-loop on a state it cannot load.
        new ChallengeEngine(state.config).restoreState(state);
      } catch (error) {
        req.log.error(error, "Unusable checkpoint");
        return reply.code(422).send({ error: "invalid_checkpoint" });
      }

      // Pausing makes the engine drain the runner and release the challenge.
      if (challenge.status === "live") {
        await app.db
          .update(challenges)
          .set({ status: "paused" })
          .where(
            and(eq(challenges.id, challengeId), eq(challenges.status, "live")),
          );
        await markChallengeInactive(app.redis, challengeId);
      }
      // `reset:` also blocks a manual go-live until the resume finishes.
      const lockKey = redisKeys.engineLock(challengeId);
      const owner = `reset:${randomUUID()}`;
      const deadline = Date.now() + 30_000;
      while ((await app.redis.set(lockKey, owner, "EX", 120, "NX")) !== "OK") {
        if (Date.now() > deadline)
          return reply.code(409).send({
            error: "engine_still_running",
            message:
              "The engine has not released this challenge yet. It is paused; retry in a few seconds.",
          });
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const holdsLock = async () =>
        (await app.redis.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], 120) end return 0",
          1,
          lockKey,
          owner,
        )) === 1;
      try {
        const live = await app.db.query.engineCheckpoints.findFirst({
          where: eq(engineCheckpoints.challengeId, challengeId),
        });
        if (live) {
          await saveChallengeCheckpoint(app.db, {
            challengeId,
            takenAt: live.updatedAt,
            reason: "before_resume",
            minuteMs: payload.minuteMs,
            engine: { state: live.state, minuteCount: live.minuteCount },
            redis: await readCheckpointRedis(app.redis, challengeId),
          });
        }

        const takenAt = checkpoint.takenAt.getTime();
        const shiftMs = Math.max(0, Date.now() - takenAt);
        const startsAt = resumedStartsAt(payload, shiftMs);
        const endsAt = resumedEndsAt(payload, shiftMs);
        const engineState = shiftEngineState(state, shiftMs);
        const cursor = await commandStreamTip(app.redis, challengeId);
        const error = await app.db.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(challenges)
            .where(eq(challenges.id, challengeId))
            .for("update");
          if (!current || current.finalizedAt != null) return "challenge_ended";
          if (current.status !== "paused") return "not_paused";
          await restoreChallengeCheckpoint(tx, {
            challengeId,
            payload,
            takenAt: checkpoint.takenAt,
            shiftMs,
            startsAt,
            endsAt,
            engineState,
            cursor,
            accounts: engineState.accounts.filter(
              (a) => uuid.safeParse(a.userId).success,
            ),
            resting: new Map(
              engineState.symbols
                .flatMap((s) => s.orders)
                .filter((o) => uuid.safeParse(o.id).success)
                .map((o) => [o.id, o.remaining] as const),
            ),
            startingCash: engineState.config.startingCash,
          });
          if (!(await holdsLock())) throw new Error("resume_lock_lost");
          return null;
        });
        if (error) return reply.code(409).send({ error });

        await restoreCheckpointRedis(app.redis, challengeId, redisState, {
          shiftMs,
          takenAt,
          cursor,
          symbols: engineState.symbols.map((s) => s.config.symbol),
        });
        await setNewsFeed(
          app.redis,
          challengeId,
          await loadNewsFeed(app.db, challengeId),
        );
        await app.redis.set(
          redisKeys.restored(challengeId),
          checkpoint.takenAt.toISOString(),
          "EX",
          600,
        );
        await app.db
          .update(challenges)
          .set({ status: "live" })
          .where(eq(challenges.id, challengeId));
        await markChallengeActive(app.redis, challengeId);
        return {
          ok: true,
          takenAt: checkpoint.takenAt.toISOString(),
          startsAt: startsAt?.toISOString() ?? null,
          endsAt: endsAt?.toISOString() ?? null,
        } satisfies AdminCheckpointResume;
      } finally {
        await app.redis
          .eval(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
            1,
            lockKey,
            owner,
          )
          .catch((error) => app.log.error(error, "Resume lease release failed"));
      }
    },
  );
}
