import { ChallengeEngine, computeScore } from "@qtp/core";
import {
  addListedSymbol,
  appendEvents,
  createRedis,
  getFairValue,
  getPrice,
  getTraderMetricsMap,
  publishBroadcast,
  pushNews,
  readCommands,
  setBookSnapshot,
  setFairValue,
  setMidPrice,
  setMarketFrozen,
  setPrice,
  setSymbolTradeable,
  setTraderMetrics,
  type Redis,
} from "@qtp/bus";
import { and, asc, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import {
  challengeNews,
  challenges,
  engineCheckpoints,
  eventActions,
  fairValues,
  orders,
  participants,
  positions,
  type Challenge,
  type Database,
} from "@qtp/db";
import {
  midFromBook,
  redisKeys,
  zEdenOptionsConfig,
  zEdenRules,
  edenEventStateAt,
  EDEN_EVENT_NEWS,
  type BroadcastEnvelope,
  type EdenConfig,
  type EngineCommand,
  type EngineEvent,
  type EtfConfig,
  type NewsItem,
  type SymbolConfig,
  type TraderMetrics,
} from "@qtp/shared";
import { env } from "./env.js";
import { BotEngine } from "./bots.js";
import { EdenBotEngine } from "./eden-bots.js";
import { OptionsManager } from "./options-manager.js";
import { MarketsManager } from "./markets-manager.js";
import { Persistence } from "./persistence.js";
import { EdenSettlements } from "./eden-settlements.js";
import { EventTimeline, eventActionUuid } from "./event-timeline.js";
import { EventExecutor } from "./event-executor.js";
import { finalizeScores } from "./final-scoring.js";

/**
 * Owns the in-memory matching engine for one challenge: consumes its command
 * stream, mutates state, persists asynchronously, and publishes events.
 */
export class ChallengeRunner {
  private readonly engine: ChallengeEngine;
  private readonly persistence: Persistence;
  private readonly settlements: EdenSettlements;
  private timeline?: EventTimeline;
  private work: Promise<void> = Promise.resolve();
  private commandWork?: Promise<void>;
  private poisoned = false;
  private leaseLost = false;
  private finalized = false;
  private clockBusy = false;
  private botBusy = false;
  private priceBusy = false;
  private recoveryAt = 0;
  private readonly scriptedNews = new Set<string>();
  private newsBusy = false;
  private readonly marginNotices = new Map<string, number>();
  private readonly bots: BotEngine;
  private readonly edenBots?: EdenBotEngine;
  private options?: OptionsManager;
  private markets?: MarketsManager;
  private minuteCount = 0;
  private readonly cmdRedis: Redis;
  private running = false;
  /** Stream cursor. See `loadCommandCursor`. */
  private lastId = "0-0";
  private tickTimer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private botTimer?: NodeJS.Timeout;
  private metricsTimer?: NodeJS.Timeout;
  private minuteTimer?: NodeJS.Timeout;
  private newsTimer?: NodeJS.Timeout;
  private eden?: EdenConfig;
  private readonly edenEnabled: boolean;
  private frozen: boolean;

  constructor(
    private readonly redis: Redis,
    private readonly db: Database,
    private readonly challenge: Challenge,
  ) {
    // `eden` config drives the options/ETF managers for ANY challenge type
    // (so instruments introduced live survive a runner restart); the full New
    // Eden bot ecosystem + rules only activate for `new_eden` challenges.
    this.eden = challenge.config.eden;
    this.edenEnabled =
      challenge.type === "new_eden" && !!this.eden?.rules.enabled;
    this.frozen = challenge.frozen ?? false;
    this.engine = new ChallengeEngine({
      challengeId: challenge.id,
      symbols: challenge.config.symbols,
      startingCash: challenge.config.startingCash,
      minPosition: challenge.config.minPosition,
      maxPosition: challenge.config.maxPosition,
      maxOrderQuantity: challenge.config.maxOrderQuantity,
      ...(this.edenEnabled
        ? { positionCap: this.eden!.rules.positionCap }
        : {}),
      maxOpenOrders: challenge.config.maxOpenOrders ?? 25,
      allowMargin: challenge.config.allowMargin,
    });
    this.engine.setFrozen(this.frozen);
    this.persistence = new Persistence(db, challenge.id, this.engine);
    this.persistence.setCommitGuard(() => {
      if (this.leaseLost)
        throw new Error("Engine lease lost before checkpoint commit");
    });
    this.settlements = new EdenSettlements({
      engine: this.engine,
      db,
      redis,
      challenge,
      minuteMs: env.minuteMs,
      persistence: this.persistence,
      emit: (events) => this.emit(events),
      refreshPortfolios: (ids, ts) => this.refreshPortfolios(ids, ts),
    });
    this.bots = new BotEngine(
      this.engine,
      challenge.config.bots ?? {
        marketMakers: 0,
        noiseTraders: 0,
        spread: 0.5,
        quoteSize: 5,
        intensity: 0.5,
      },
      challenge.config.symbols,
    );
    // New Eden challenges run the four-archetype bot ecosystem instead.
    if (this.edenEnabled && this.eden?.bots) {
      this.edenBots = new EdenBotEngine(
        this.engine,
        this.eden.bots,
        challenge.config.symbols,
      );
    }
    if (this.eden?.options?.enabled) {
      this.options = new OptionsManager(
        this.engine,
        this.redis,
        this.db,
        challenge,
        this.eden.options,
        this.eden.rules ?? zEdenRules.parse({}),
        env.minuteMs,
        (events) => this.emit(events),
        (userIds, ts) => this.refreshPortfolios(userIds, ts),
      );
    }
    if (
      (this.eden?.bonds?.length ?? 0) > 0 ||
      (this.eden?.etfs?.length ?? 0) > 0
    ) {
      this.markets = new MarketsManager(
        this.engine,
        this.redis,
        this.db,
        challenge,
        this.eden?.bonds ?? [],
        this.eden?.etfs ?? [],
        env.minuteMs,
        (events) => this.emit(events),
        (userIds, ts) => this.refreshPortfolios(userIds, ts),
      );
    }
    this.cmdRedis = createRedis(env.redisUrl);
  }

  get challengeId(): string {
    return this.challenge.id;
  }

  get healthy(): boolean {
    return !this.poisoned;
  }

  invalidateLease(): void {
    this.leaseLost = true;
    this.running = false;
    this.poisoned = true;
    this.engine.setFrozen(true);
    this.options?.stop();
    this.markets?.stop();
    this.cmdRedis.disconnect();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.work.then(async () => {
      if (this.poisoned || !this.running) return;
      try {
        if (this.edenEnabled) await this.settlements.reserveOtc(Date.now());
        await task();
        if (this.leaseLost) throw new Error("Engine lease lost");
        await this.persistence.flush({ minuteCount: this.minuteCount });
      } catch (error) {
        // Do not execute subsequent commands against partially committed state.
        // Reconciliation restores the last committed checkpoint into a new runner.
        this.poisoned = true;
        this.running = false;
        this.options?.stop();
        this.markets?.stop();
        throw error;
      }
    });
    this.work = next.catch((error) =>
      console.error(`[${this.challenge.slug}] mutation failed`, error),
    );
    return next;
  }

  private dispatch = (task: () => Promise<void>): void => {
    if (this.running) void this.enqueue(task).catch(() => {});
  };

  async start(): Promise<void> {
    this.running = true;
    // Persist the event epoch once; deployments must never restart its clock.
    if (!this.challenge.startsAt) {
      this.challenge.startsAt = new Date();
      await this.db
        .update(challenges)
        .set({ startsAt: this.challenge.startsAt })
        .where(eq(challenges.id, this.challenge.id));
    }
    if (this.eden?.eventScript) {
      this.challenge.endsAt = new Date(
        this.challenge.startsAt.getTime() + 130 * env.minuteMs,
      );
      await this.db
        .update(challenges)
        .set({ endsAt: this.challenge.endsAt })
        .where(eq(challenges.id, this.challenge.id));
    }
    // A scripted market opens at minute 0 (`market_open`), even if the host
    // flips the challenge live before startsAt.
    if (
      this.edenEnabled &&
      this.eden?.eventScript &&
      !this.frozen &&
      Date.now() < this.challenge.startsAt.getTime()
    ) {
      this.frozen = true;
      this.challenge.frozen = true;
      await this.db
        .update(challenges)
        .set({ frozen: true })
        .where(eq(challenges.id, this.challenge.id));
    }
    const checkpoint = await this.db.query.engineCheckpoints.findFirst({
      where: eq(engineCheckpoints.challengeId, this.challenge.id),
    });
    if (checkpoint) {
      this.engine.restoreState(checkpoint.state);
      this.lastId = checkpoint.cursor;
      this.minuteCount = checkpoint.minuteCount;
    } else {
      const accounts = await this.db
        .select()
        .from(participants)
        .where(eq(participants.challengeId, this.challenge.id));
      const holdings = await this.db
        .select()
        .from(positions)
        .where(eq(positions.challengeId, this.challenge.id));
      const metrics = await getTraderMetricsMap(this.redis, this.challenge.id);
      for (const account of accounts) {
        const m = metrics.get(account.userId);
        this.engine.restoreAccount(account.userId, {
          cash: account.cash,
          loanDebt: account.loanDebt,
          positions: holdings.filter((p) => p.userId === account.userId),
          ...(m
            ? { metrics: { ...m, quoteUptimeMs: m.quoteUptime * 1000 } }
            : {}),
        });
      }
      this.lastId = await this.loadCommandCursor();
    }
    this.engine.setFrozen(this.frozen);
    // Publish initial price + book snapshots so late joiners see state.
    const now = Date.now();
    for (const s of this.challenge.config.symbols) {
      // Resume from persisted price if one exists, else seed the initial.
      const persisted = await getPrice(this.redis, this.challenge.id, s.symbol);
      if (!checkpoint && persisted != null)
        this.engine.restorePrice(s.symbol, persisted);
      const price = this.engine.getPrice(s.symbol) ?? s.initialPrice;
      await setPrice(this.redis, this.challenge.id, s.symbol, price, now);
      // New Eden: seed/restore fair value (defaults to the initial price).
      if (this.edenEnabled) {
        const persistedFv = await getFairValue(
          this.redis,
          this.challenge.id,
          s.symbol,
        );
        const fv = this.engine.setFairValue(
          s.symbol,
          this.engine.getFairValue(s.symbol) ?? persistedFv ?? s.initialPrice,
        );
        await setFairValue(this.redis, this.challenge.id, s.symbol, fv);
      }
      const snap = this.engine.snapshot(s.symbol);
      const mid = midFromBook(snap.bids, snap.asks) ?? price;
      await setMidPrice(this.redis, this.challenge.id, s.symbol, mid, now);
      await setBookSnapshot(this.redis, this.challenge.id, {
        symbol: s.symbol,
        bids: snap.bids,
        asks: snap.asks,
        sequence: 0,
      });
    }

    const persistedFvs = await this.db
      .select()
      .from(fairValues)
      .where(eq(fairValues.challengeId, this.challenge.id));
    for (const fv of persistedFvs)
      this.engine.setFairValue(fv.symbol, fv.fairValue);
    // Driver quote IDs are process-local; retain bot inventory, not stale quotes.
    const botCancels: EngineEvent[] = [];
    for (const id of this.engine.accountIds()) {
      if (id.startsWith("bot:"))
        botCancels.push(...this.engine.cancelUserOrders(id, Date.now()));
    }
    this.persistence.collect(botCancels);
    this.options?.setDispatcher(this.dispatch);
    this.options?.setPersistence(this.persistence);
    this.markets?.setDispatcher(this.dispatch);
    this.markets?.setPersistence(this.persistence);
    if (this.options) await this.options.start();
    if (this.markets) await this.markets.start();
    if (!this.options && this.engine.optionMetas().length > 0) {
      await this.ensureOptions(false);
    }
    this.edenBots?.restore(Date.now());
    this.edenBots?.setEtfs(this.challenge.config.eden?.etfs ?? []);
    if (!checkpoint && this.lastId !== "0-0") {
      const resting = await this.db
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.challengeId, this.challenge.id),
            inArray(orders.status, ["open", "partially_filled"]),
          ),
        )
        .orderBy(asc(orders.createdAt), asc(orders.id));
      let seq = 0;
      for (const order of resting) {
        if (order.type !== "limit" || order.price == null) continue;
        this.engine.restoreRestingOrder(order.symbol, {
          id: order.id,
          userId: order.userId,
          side: order.side,
          price: order.price,
          remaining: order.remainingQuantity,
          seq: ++seq,
        });
      }
    }
    this.configureTimeline();
    if (this.edenEnabled) await this.settlements.recoverPremium(Date.now());
    await this.syncMarketStatus();
    await this.persistence.flush({
      cursor: this.lastId,
      minuteCount: this.minuteCount,
    });
    await this.enqueue(() => this.advanceClock(Date.now()));

    if (this.finalized) return;
    this.commandWork = this.commandLoop();
    if (this.challenge.config.autonomousPrice) {
      this.tickTimer = setInterval(() => {
        if (!this.running || this.priceBusy) return;
        this.priceBusy = true;
        void this.enqueue(async () => {
          await this.advanceClock(Date.now());
          await this.tick();
        })
          .catch(() => {})
          .finally(() => {
            this.priceBusy = false;
          });
      }, env.tickMs);
    }
    if (this.edenEnabled) {
      this.minuteTimer = setInterval(
        () => {
          if (!this.running || this.clockBusy) return;
          this.clockBusy = true;
          void this.enqueue(() => this.advanceClock(Date.now()))
            .catch(() => {})
            .finally(() => {
              this.clockBusy = false;
            });
        },
        Math.min(250, env.minuteMs / 60),
      );
    }
    if (this.edenBots?.enabled || this.bots.enabled) {
      this.botTimer = setInterval(() => {
        if (!this.running || this.botBusy) return;
        this.botBusy = true;
        void this.enqueue(async () => {
          await this.advanceClock(Date.now());
          await this.botTick();
        })
          .catch(() => {})
          .finally(() => {
            this.botBusy = false;
          });
      }, env.botMs);
    }
    this.flushTimer = setInterval(() => {
      if (this.running) this.dispatch(() => this.persistence.flush());
    }, env.flushMs);
    this.metricsTimer = setInterval(() => {
      if (this.running) this.dispatch(() => this.publishMetrics());
    }, env.metricsMs);
    // Publish any scheduled news items whose publish time has arrived. The
    // runner holds the per-challenge engine lock, so it is the single writer.
    this.newsTimer = setInterval(() => {
      if (!this.running || this.newsBusy) return;
      this.newsBusy = true;
      void this.enqueue(() => this.publishDueNews())
        .catch(() => {})
        .finally(() => {
          this.newsBusy = false;
        });
    }, 250);
    console.log(`[engine] running challenge ${this.challenge.slug}`);
  }

  async stop(persist = true): Promise<void> {
    if (!persist) this.invalidateLease();
    this.running = false;
    this.options?.stop();
    this.markets?.stop();
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.botTimer) clearInterval(this.botTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    if (this.minuteTimer) clearInterval(this.minuteTimer);
    if (this.newsTimer) clearInterval(this.newsTimer);
    // Disconnect the blocking reader before draining; no late batch can enqueue.
    this.cmdRedis.disconnect();
    await this.commandWork;
    await this.work;
    if (persist && !this.poisoned)
      await this.persistence.flush({ minuteCount: this.minuteCount });
    console.log(`[engine] stopped challenge ${this.challenge.slug}`);
  }

  private async commandLoop(): Promise<void> {
    while (this.running) {
      try {
        const { nextId, messages } = await readCommands(
          this.cmdRedis,
          this.challenge.id,
          this.lastId,
          1000,
        );
        if (!this.running) break;
        if (messages.length === 0) continue;
        await this.enqueue(async () => {
          await this.advanceClock(Date.now());
          for (const m of messages) {
            if (this.finalized) break;
            this.persistence.setProgress({
              cursor: m.id,
              minuteCount: this.minuteCount,
            });
            await this.emit(await this.process(m.data));
            await this.persistence.flush();
            this.lastId = m.id;
          }
          await this.persistence.flush({
            cursor: nextId,
            minuteCount: this.minuteCount,
          });
          this.lastId = nextId;
        });
        await this.redis.set(
          redisKeys.commandCursor(this.challenge.id),
          this.lastId,
        );
      } catch (err) {
        if (this.running) {
          console.error(`[${this.challenge.slug}] command loop error`, err);
          await sleep(500);
        }
      }
    }
  }

  private configureTimeline(): void {
    if (
      !this.edenEnabled ||
      !this.eden?.eventScript ||
      !this.challenge.startsAt
    )
      return;
    for (const news of EDEN_EVENT_NEWS)
      this.scriptedNews.add(eventActionUuid(this.challenge.id, news.id));
    const executor = new EventExecutor({
      challenge: this.challenge,
      db: this.db,
      redis: this.redis,
      engine: this.engine,
      minuteMs: env.minuteMs,
      emit: (events) => this.emit(events),
      addSpotSymbol: (cfg, locked, ts) => this.addSpotSymbol(cfg, locked, ts),
      addEtf: (cfg, ts) => this.addEtf(cfg, ts),
      addBond: async (template) => {
        (await this.ensureMarkets()).listBond(template);
      },
      openOptions: async (config) => {
        this.eden = this.challenge.config.eden;
        if (this.eden) this.eden.options = config;
        await this.ensureOptions();
      },
      setFrozen: async (frozen) => {
        this.frozen = frozen;
        this.challenge.frozen = frozen;
        this.engine.setFrozen(frozen);
        await this.db
          .update(challenges)
          .set({ frozen })
          .where(eq(challenges.id, this.challenge.id));
        await this.syncMarketStatus();
        await publishBroadcast(this.redis, this.challenge.id, [
          {
            target: "all",
            msg: {
              type: "alert",
              challengeId: this.challenge.id,
              data: {
                level: "info",
                message: frozen
                  ? "Trading halted. Positions are retained."
                  : "Trading resumed.",
                ts: Date.now(),
              },
            },
          },
        ]);
      },
      resolveAuction: (id, ts, until) =>
        this.settlements.resolveAuction(id, ts, until),
      resolveVote: (id, ts) => this.settlements.resolveVote(id, ts),
      awardGrant: (id, ts) => this.settlements.awardGrant(id, ts),
      rescueLoans: (ts) => this.settlements.rescueLoans(ts),
      setVolatility: (multiplier) => {
        this.engine.setVolatilityMultiplier(multiplier);
        this.edenBots?.setVolatilityMultiplier(multiplier);
      },
      prepareVega: async (symbol, releaseAt, now) => {
        // A later-dated event series avoids the normal cycle expiring before the dump.
        await (
          await this.ensureOptions()
        ).openOn(symbol, releaseAt + env.minuteMs);
        this.edenBots?.prepareVolEvent(symbol, releaseAt, now, env.minuteMs);
        await this.botTick();
      },
      resolveVega: async (symbol, now) => {
        this.edenBots?.resolveVolEvent(symbol, now);
        await this.botTick();
      },
      newsPulse: (effects, vol) => this.edenBots?.onNewsPulse(effects, vol),
      setEtfWindow: async (symbol, open, ts) => {
        await (await this.ensureMarkets()).setWindow(symbol, open, ts);
      },
      finalize: (ts) => this.finalize(ts),
    });
    this.timeline = new EventTimeline({
      challengeId: this.challenge.id,
      enabled: true,
      startsAt: this.challenge.startsAt.getTime(),
      minuteMs: env.minuteMs,
      loadCompletedActionIds: async () =>
        (
          await this.db
            .select()
            .from(eventActions)
            .where(eq(eventActions.challengeId, this.challenge.id))
        ).map((row) => row.actionId),
      execute: async (action, context) => {
        await executor.execute(action, context);
        await this.persistence.flush({
          receipt: action.id,
          minuteCount: this.minuteCount,
        });
      },
    });
    const state = edenEventStateAt(
      ((Date.now() - this.challenge.startsAt.getTime()) / env.minuteMs) * 60,
    );
    this.engine.setVolatilityMultiplier(state.botVolatilityMultiplier);
    this.edenBots?.setVolatilityMultiplier(state.botVolatilityMultiplier);
  }

  private async advanceClock(now: number): Promise<void> {
    if (this.finalized) return;
    if (this.edenEnabled && this.challenge.startsAt) {
      const start = this.challenge.startsAt.getTime();
      const end = Math.min(now, this.challenge.endsAt?.getTime() ?? now);
      const due = Math.max(0, Math.floor((end - start) / env.minuteMs));
      while (this.minuteCount < due && !this.finalized) {
        const boundary = start + (this.minuteCount + 1) * env.minuteMs;
        await this.timeline?.tick(now, boundary - 0.001);
        if (this.finalized) break;
        // Charge the completed minute before the transition at its end.
        await this.minuteTick(boundary);
        this.minuteCount++;
        this.persistence.setProgress({ minuteCount: this.minuteCount });
        await this.persistence.flush({ minuteCount: this.minuteCount });
        await this.timeline?.tick(now, boundary);
      }
    }
    await this.timeline?.tick(now);
    if (this.finalized) return;
    if (this.challenge.endsAt && now >= this.challenge.endsAt.getTime()) {
      await this.finalize(this.challenge.endsAt.getTime());
      return;
    }
    if (now - this.recoveryAt >= Math.min(1000, env.minuteMs / 10)) {
      this.recoveryAt = now;
      if (this.edenEnabled) await this.settlements.recover(now);
    }
  }

  private async syncMarketStatus(): Promise<void> {
    await setMarketFrozen(this.redis, this.challenge.id, this.frozen);
    await publishBroadcast(this.redis, this.challenge.id, [
      {
        target: "all",
        msg: {
          type: "market_status",
          challengeId: this.challenge.id,
          data: { frozen: this.frozen },
        },
      },
    ]);
  }

  /** Called under the mutation queue, before the challenge leaves active scoring. */
  private async finalize(ts: number): Promise<void> {
    if (this.finalized) return;
    this.frozen = true;
    this.engine.setFrozen(true);
    await this.syncMarketStatus();
    await this.db
      .update(challenges)
      .set({ frozen: true })
      .where(eq(challenges.id, this.challenge.id));
    this.markets?.stop();
    await this.options?.expireAll(ts);
    const events: EngineEvent[] = [];
    for (const id of this.engine.accountIds())
      events.push(...this.engine.cancelUserOrders(id, ts));
    await this.emit(events);
    if (this.edenEnabled) await this.settlements.repayLoans(ts, true);
    await this.persistence.flush({ minuteCount: this.minuteCount });
    await this.db
      .update(challenges)
      .set({ status: "ended" })
      .where(eq(challenges.id, this.challenge.id));
    await finalizeScores(this.db, this.redis, this.challenge.id);
    await this.db
      .update(challenges)
      .set({ finalizedAt: new Date(), frozen: true })
      .where(eq(challenges.id, this.challenge.id));
    this.finalized = true;
    this.challenge.status = "ended";
    await publishBroadcast(this.redis, this.challenge.id, [
      {
        target: "all",
        msg: {
          type: "alert",
          challengeId: this.challenge.id,
          data: {
            level: "info",
            message:
              "Trading halted. Final mark-to-market and rankings are complete.",
            ts,
          },
        },
      },
    ]);
  }

  async finish(): Promise<void> {
    await this.enqueue(() => this.finalize(Date.now()));
  }

  private async process(cmd: EngineCommand): Promise<EngineEvent[]> {
    switch (cmd.type) {
      case "place_order":
        return this.engine.placeOrder({
          orderId: cmd.orderId,
          userId: cmd.userId,
          symbol: cmd.symbol,
          side: cmd.side,
          orderType: cmd.orderType,
          quantity: cmd.quantity,
          price: cmd.price,
          ts: cmd.ts,
          admin: cmd.admin,
        });
      case "cancel_order":
        return this.engine.cancelOrder({
          orderId: cmd.orderId,
          userId: cmd.userId,
          symbol: cmd.symbol,
          side: cmd.side,
          ts: cmd.ts,
        });
      case "set_frozen":
        this.frozen = cmd.frozen;
        this.challenge.frozen = cmd.frozen;
        this.engine.setFrozen(cmd.frozen);
        return [];
      case "issue_loan":
        await this.settlements.issueLoan(cmd.loanId, Date.now());
        return [];
      case "resolve_auction":
        await this.settlements.resolveAuction(cmd.auctionId, Date.now());
        return [];
      case "force_liquidate":
        if (this.frozen) return [];
        return this.liquidate(cmd.userId, cmd.reason, cmd.ts);
      case "admin_set_account":
        return this.setAccount(cmd);
      case "set_fair_value": {
        const fv = this.engine.setFairValue(cmd.symbol, cmd.fairValue);
        return [
          {
            type: "fair_value",
            challengeId: this.challenge.id,
            symbol: cmd.symbol,
            fairValue: fv,
            ts: cmd.ts,
          },
        ];
      }
      case "apply_fv_delta":
        return cmd.effects.map((e) => ({
          type: "fair_value" as const,
          challengeId: this.challenge.id,
          symbol: e.symbol,
          fairValue: this.engine.applyFairValueDelta(e.symbol, e.delta),
          ts: cmd.ts,
        }));
      case "news_pulse":
        this.edenBots?.onNewsPulse(cmd.effects, cmd.volEvent);
        return [];
      case "exercise_option":
        if (this.frozen) return [];
        return (
          (await this.options?.exercise(
            cmd.userId,
            cmd.symbol,
            cmd.quantity,
            Date.now(),
          )) ?? []
        );
      case "add_symbol":
        await this.addSpotSymbol(cmd.config, cmd.locked, cmd.ts);
        return [];
      case "add_etf":
        await this.addEtf(cmd.config, cmd.ts);
        return [];
      case "open_option_cycle": {
        const mgr = await this.ensureOptions();
        if (cmd.underlying) await mgr.openOn(cmd.underlying);
        else await mgr.openAll();
        return [];
      }
      case "close_option_cycle":
        await this.options?.close(cmd.cycleId);
        return [];
      case "purchase_bond":
        if (this.frozen) return [];
        await this.markets?.purchaseBond(
          cmd.userId,
          cmd.bondId,
          cmd.quantity,
          cmd.ts,
        );
        return [];
      case "etf_trade":
        if (this.frozen) return [];
        await this.markets?.etfTrade(
          cmd.userId,
          cmd.etfSymbol,
          cmd.action,
          cmd.quantity,
          cmd.ts,
        );
        return [];
      case "etf_window":
        await this.markets?.setWindow(cmd.etfSymbol, cmd.open, cmd.ts);
        return [];
      case "execute_otc":
        await this.settlements.settleOtc(cmd.offerId, Date.now());
        return [];
      case "apply_wealth_tax":
        if (cmd.proposalId)
          await this.settlements.applyTax(cmd.proposalId, Date.now());
        return [];
      case "award_grant":
        await this.settlements.awardGrant(cmd.grantId, Date.now());
        return [];
      default:
        return [];
    }
  }

  /**
   * Resume the command stream without dropping the go-live backlog or
   * replaying a live challenge's history after a deploy.
   *
   * - Stored cursor: always win (normal restart).
   * - No cursor + no event stream: first runner for this challenge — read
   *   from the beginning so place_order / issue_loan in the reconcile window
   *   are not skipped (`$` would drop them).
   * - No cursor + existing events: a prior runner already processed the
   *   stream. Start at the tip so we do not re-apply fills against empty books.
   */
  private async loadCommandCursor(): Promise<string> {
    const stored = await this.redis.get(
      redisKeys.commandCursor(this.challenge.id),
    );
    if (stored && stored.length > 0) return stored;
    const priorEvents = await this.redis.xlen(
      redisKeys.eventStream(this.challenge.id),
    );
    return priorEvents > 0 ? "$" : "0-0";
  }

  /**
   * Publish scheduled news whose publish time has arrived. Atomically claims
   * due rows by stamping `publishedAt`, then caches + broadcasts each item and
   * applies its signal/momentum side effects (derived from stored fvEffects).
   */
  private async publishDueNews(): Promise<void> {
    const now = new Date();
    if (this.finalized) return;
    const due = await this.db
      .select()
      .from(challengeNews)
      .where(
        and(
          eq(challengeNews.challengeId, this.challenge.id),
          or(
            isNull(challengeNews.publishAt),
            lte(challengeNews.publishAt, now),
          ),
          or(
            isNull(challengeNews.publishedAt),
            isNull(challengeNews.effectsAppliedAt),
          ),
        ),
      )
      .orderBy(asc(challengeNews.publishAt), asc(challengeNews.createdAt));
    for (const row of due) {
      if (this.scriptedNews.has(row.id)) continue;
      const item: NewsItem = {
        id: row.id,
        challengeId: row.challengeId,
        message: row.message,
        level: row.level,
        feed: row.feed,
        createdAt: row.createdAt.toISOString(),
        embargoUntil: row.embargoUntil ? row.embargoUntil.toISOString() : null,
      };
      if (!row.publishedAt) {
        await pushNews(this.redis, this.challenge.id, item);
        await publishBroadcast(this.redis, this.challenge.id, [
          {
            target: "all",
            msg: { type: "news", challengeId: this.challenge.id, data: item },
          },
        ]);
        await this.db
          .update(challengeNews)
          .set({ publishedAt: now })
          .where(eq(challengeNews.id, row.id));
      }
      if (row.effectsAppliedAt || (row.embargoUntil && row.embargoUntil > now))
        continue;
      const fvEvents: EngineEvent[] = [];
      const effects = row.fvEffects ?? [];
      if (row.kind === "signal" && effects.length > 0) {
        for (const e of effects) {
          fvEvents.push({
            type: "fair_value",
            challengeId: this.challenge.id,
            symbol: e.symbol,
            fairValue: this.engine.applyFairValueDelta(e.symbol, e.delta),
            ts: now.getTime(),
          });
        }
      }
      const momentum =
        row.momentum ??
        effects
          .filter((e) => e.delta !== 0)
          .map((e) => ({ symbol: e.symbol, sentiment: Math.sign(e.delta) }));
      if (momentum.length > 0) {
        this.edenBots?.onNewsPulse(momentum, row.volEvent);
      }
      this.persistence.queueWrite(async (tx) => {
        await tx
          .update(challengeNews)
          .set({ effectsAppliedAt: now })
          .where(eq(challengeNews.id, row.id));
      });
      await this.emit(fvEvents);
      await this.persistence.flush();
    }
  }

  /* ------------------------------------------------------------------ *
   * Live instrument introduction (any challenge type, no pause)
   * ------------------------------------------------------------------ */

  /** Lazily construct the options manager so any challenge type can list them. */
  private async ensureOptions(autoCycle?: boolean): Promise<OptionsManager> {
    if (!this.options) {
      const opts = zEdenOptionsConfig.parse({
        ...this.challenge.config.eden?.options,
        enabled: true,
        autoCycle:
          autoCycle ?? this.challenge.config.eden?.options?.autoCycle ?? false,
      });
      const rules = this.eden?.rules ?? zEdenRules.parse({});
      this.options = new OptionsManager(
        this.engine,
        this.redis,
        this.db,
        this.challenge,
        opts,
        rules,
        env.minuteMs,
        (events) => this.emit(events),
        (userIds, ts) => this.refreshPortfolios(userIds, ts),
      );
      this.options.setDispatcher(this.dispatch);
      this.options.setPersistence(this.persistence);
      await this.options.start();
    }
    return this.options;
  }

  /** Lazily construct the markets manager so any challenge type can list ETFs. */
  private async ensureMarkets(): Promise<MarketsManager> {
    if (!this.markets) {
      this.markets = new MarketsManager(
        this.engine,
        this.redis,
        this.db,
        this.challenge,
        [],
        [],
        env.minuteMs,
        (events) => this.emit(events),
        (userIds, ts) => this.refreshPortfolios(userIds, ts),
      );
      this.markets.setDispatcher(this.dispatch);
      this.markets.setPersistence(this.persistence);
      await this.markets.start();
    }
    return this.markets;
  }

  /** Introduce a spot asset into the live book and announce it to clients. */
  private async addSpotSymbol(
    cfg: SymbolConfig,
    locked: boolean,
    ts: number,
  ): Promise<void> {
    // Skip if the symbol already has a book (idempotent on redelivery).
    if (this.engine.getPrice(cfg.symbol) !== undefined) return;
    this.engine.addSymbol(cfg, { autonomous: true });
    this.bots.addSymbol(cfg);
    this.edenBots?.addSymbol(cfg);
    await setPrice(
      this.redis,
      this.challenge.id,
      cfg.symbol,
      cfg.initialPrice,
      ts,
    );
    await setBookSnapshot(this.redis, this.challenge.id, {
      symbol: cfg.symbol,
      bids: [],
      asks: [],
      sequence: 0,
    });
    if (this.edenEnabled) {
      const fv = this.engine.setFairValue(cfg.symbol, cfg.initialPrice);
      await setFairValue(this.redis, this.challenge.id, cfg.symbol, fv);
    }
    await addListedSymbol(this.redis, this.challenge.id, cfg.symbol);
    if (locked) {
      await setSymbolTradeable(
        this.redis,
        this.challenge.id,
        cfg.symbol,
        false,
      );
    }
    await publishBroadcast(this.redis, this.challenge.id, [
      {
        target: "all",
        msg: {
          type: "symbol_listed",
          challengeId: this.challenge.id,
          data: { config: cfg, kind: "spot", locked, ts },
        },
      },
    ]);
  }

  /** Introduce an ETF into the live challenge and announce it to clients. */
  private async addEtf(cfg: EtfConfig, ts: number): Promise<void> {
    const mgr = await this.ensureMarkets();
    const listed = await mgr.listEtf(cfg);
    const etfs = this.challenge.config.eden?.etfs ?? [];
    this.edenBots?.setEtfs(
      etfs.some((e) => e.symbol === cfg.symbol) ? etfs : [...etfs, cfg],
    );
    if (!listed) return;
    await publishBroadcast(this.redis, this.challenge.id, [
      {
        target: "all",
        msg: {
          type: "symbol_listed",
          challengeId: this.challenge.id,
          data: { config: listed, kind: "etf", locked: false, ts },
        },
      },
    ]);
  }

  /** Apply a host account override, persist it, and tell the trader. */
  private async setAccount(
    cmd: Extract<EngineCommand, { type: "admin_set_account" }>,
  ): Promise<EngineEvent[]> {
    try {
      this.engine.setAccount(cmd.userId, {
        cash: cmd.cash,
        cashDelta: cmd.cashDelta,
        positions: cmd.positions,
      });
    } catch (err) {
      console.warn(
        `[${this.challenge.slug}] rejected account edit for ${cmd.userId}`,
        err,
      );
      return [];
    }
    const signed = (n: string) => (n.startsWith("-") ? n : `+${n}`);
    const changes = [
      ...(cmd.cash !== undefined ? [`cash ${cmd.cash.toFixed(2)}`] : []),
      ...(cmd.cashDelta !== undefined
        ? [`cash ${signed(cmd.cashDelta.toFixed(2))}`]
        : []),
      ...(cmd.positions ?? []).map((p) =>
        p.delta !== undefined
          ? `${p.symbol} ${signed(String(p.delta))}`
          : `${p.symbol} ${p.quantity}`,
      ),
    ];
    await this.refreshPortfolios([cmd.userId], cmd.ts);
    return [
      {
        type: "alert",
        challengeId: this.challenge.id,
        userId: cmd.userId,
        level: "warning",
        message: `The host adjusted your account: ${changes.join(", ")}.`,
        ts: cmd.ts,
      },
    ];
  }

  /** Flatten a trader's positions at market and emit a margin-call notice. */
  private liquidate(userId: string, reason: string, ts: number): EngineEvent[] {
    const freeBefore = this.engine.freeCashOf(userId);
    const events = this.engine.cancelUserOrders(userId, ts);
    const cmds = this.engine.liquidationCommands(userId, ts);
    for (const c of cmds) events.push(...this.engine.placeOrder(c));
    const liquidated = this.engine.absInventoryOf(userId) === 0;
    events.push({
      type: "margin_call",
      challengeId: this.challenge.id,
      userId,
      freeCash: freeBefore,
      liquidated,
      ts,
    });
    events.push({
      type: "alert",
      challengeId: this.challenge.id,
      userId,
      level: "urgent",
      message: `Margin call: ${reason}. ${liquidated ? "Inventory liquidated at market." : "IOC liquidation attempted; remaining inventory awaits liquidity."}`,
      ts,
    });
    return events;
  }

  /** Drive autonomous bots: apply their commands and broadcast results. */
  private async botTick(): Promise<void> {
    if (!this.running || this.frozen) return;
    const now = Date.now();
    const action: ReturnType<EdenBotEngine["act"]> = this.edenBots
      ? this.edenBots.act(now)
      : this.bots.act(now);
    const { places, cancels } = action;
    const events: EngineEvent[] = [];
    for (const c of cancels) {
      events.push(...this.engine.cancelOrder(c));
    }
    for (const p of places) {
      events.push(...this.engine.placeOrder(p));
      events.push(...this.enforceMargins(now));
    }
    if ("batches" in action) {
      for (const batch of action.batches ?? []) {
        events.push(...this.engine.placeAtomicOrders(batch));
        events.push(...this.enforceMargins(now));
      }
    }
    await this.emit(events);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.frozen) return;
    const now = Date.now();
    const events: EngineEvent[] = [];
    // Sample two-sided quoting for market-making uptime scoring.
    if (this.challenge.scoring.kind === "market_making") {
      this.engine.sampleQuoteUptime(
        env.tickMs,
        this.challenge.scoring.maxSpread,
        this.challenge.scoring.minQuoteSize,
      );
    }
    const commonShock = Math.random();
    const correlated =
      this.eden?.eventScript &&
      this.challenge.startsAt &&
      now < this.challenge.startsAt.getTime() + 90 * env.minuteMs;
    for (const symbol of this.engine.autonomousSymbols()) {
      const driftKey = `qtp:drift_target:${this.challenge.id}:${symbol}`;
      const target = await this.redis.get(driftKey);
      if (target != null) {
        const speed = Number(
          (await this.redis.get(
            `qtp:drift_speed:${this.challenge.id}:${symbol}`,
          )) ?? 5,
        );
        const { event, reached } = this.engine.driftTick(
          symbol,
          now,
          Number(target),
          speed,
        );
        if (event) events.push(event);
        if (reached) {
          await this.redis.del(driftKey);
          await this.redis.del(
            `qtp:drift_speed:${this.challenge.id}:${symbol}`,
          );
        }
      } else {
        const rng =
          correlated && (symbol === "AERIUM" || symbol === "NEURO")
            ? () => 0.8 * commonShock + 0.2 * Math.random()
            : Math.random;
        const ev = this.engine.tickPrice(symbol, now, rng);
        if (ev) events.push(ev);
      }
    }
    await this.emit(events);
    // Re-mark ETF NAVs against the fresh basket prices.
    await this.markets?.updateNavs(now);
  }

  /**
   * New Eden game-minute accrual: cost of carry, predatory loan bleed, and
   * margin-call enforcement with forced liquidation. Runs once per game-minute.
   */
  private async minuteTick(now: number): Promise<void> {
    if (!this.edenEnabled || !this.eden) return;
    const rules = this.eden.rules;
    const minute = this.minuteCount + 1;
    // Each substep has its own receipt because managers commit at settlement boundaries.
    const step = async (kind: string, apply: () => Promise<void>) => {
      const actionId = `minute:${minute}:${kind}`;
      const [done] = await this.db
        .select()
        .from(eventActions)
        .where(
          and(
            eq(eventActions.challengeId, this.challenge.id),
            eq(eventActions.actionId, actionId),
          ),
        );
      if (done) return;
      this.persistence.queueWrite(async (tx) => {
        await tx
          .insert(eventActions)
          .values({ challengeId: this.challenge.id, actionId })
          .onConflictDoNothing();
      });
      await apply();
      await this.persistence.flush();
    };
    await step("carry", async () => {
      const events: EngineEvent[] = [];
      for (const userId of this.engine.accountIds()) {
        if (!UUID_RE.test(userId)) continue;
        const amount = this.engine.applyCarry(
          userId,
          rules.costOfCarryPerUnitPerMinute,
        );
        if (amount > 0)
          events.push({
            type: "carry_charge",
            challengeId: this.challenge.id,
            userId,
            amount,
            ts: now,
          });
      }
      await this.emit(events);
    });
    if (this.markets && minute % 5 === 0) {
      await step("coupons", () => this.markets!.payCoupons(now));
    }
    await this.settlements.repayLoans(now);
  }

  private enforceMargins(now: number): EngineEvent[] {
    if (!this.edenEnabled || !this.eden) return [];
    const events: EngineEvent[] = [];
    // Revisit counterparties once after liquidation trades; bound work if liquidity is absent.
    for (let pass = 0; pass < 2; pass++) {
      for (const id of this.engine.accountIds()) {
        if (!UUID_RE.test(id)) continue;
        const free = this.engine.freeCashOf(id);
        if (free > this.eden.rules.marginCallThreshold) {
          this.marginNotices.delete(id);
          continue;
        }
        if (
          !this.frozen &&
          this.eden.rules.forcedLiquidation &&
          this.engine.absInventoryOf(id) > 0
        ) {
          events.push(...this.liquidate(id, "cash exhausted", now));
        } else if (now - (this.marginNotices.get(id) ?? 0) >= 1000) {
          events.push({
            type: "margin_call",
            challengeId: this.challenge.id,
            userId: id,
            freeCash: free,
            liquidated: false,
            ts: now,
          });
        }
        this.marginNotices.set(id, now);
      }
    }
    return events;
  }

  private async emit(events: EngineEvent[]): Promise<void> {
    events.push(...this.enforceMargins(Date.now()));
    if (events.length === 0) return;
    this.persistence.collect(events);
    const now = Date.now();
    const envelopes: BroadcastEnvelope[] = [];
    const affectedUsers = new Set<string>();
    // Bot cancel-replace emits a book_update per cancel and per place. Only
    // the last snapshot per symbol is hot-cached and broadcast so clients do
    // not paint the empty intermediate book.
    const lastPrice = new Map<
      string,
      Extract<EngineEvent, { type: "price_update" }>
    >();
    const lastBook = new Map<
      string,
      Extract<EngineEvent, { type: "book_update" }>
    >();

    for (const e of events) {
      switch (e.type) {
        case "price_update":
          lastPrice.set(e.symbol, e);
          break;
        case "book_update":
          lastBook.set(e.symbol, e);
          break;
        case "trade":
          affectedUsers.add(e.buyerId);
          affectedUsers.add(e.sellerId);
          envelopes.push({
            target: "all",
            msg: {
              type: "trade",
              challengeId: this.challenge.id,
              data: {
                symbol: e.symbol,
                price: e.price,
                quantity: e.quantity,
                takerSide: e.takerSide,
                ts: e.ts,
              },
            },
          });
          break;
        case "order_update":
          affectedUsers.add(e.userId);
          envelopes.push({
            target: e.userId,
            msg: {
              type: "order",
              challengeId: this.challenge.id,
              data: {
                orderId: e.orderId,
                symbol: e.symbol,
                side: e.side,
                status: e.status,
                remainingQuantity: e.remainingQuantity,
                ts: e.ts,
              },
            },
          });
          break;
        case "carry_charge":
        case "loan_update":
        case "option_exercised":
        case "option_assigned":
        case "otc_settled":
          // Cash/positions changed — refresh the trader's portfolio.
          affectedUsers.add(e.userId);
          break;
        case "grant_awarded":
          if (e.userId) affectedUsers.add(e.userId);
          break;
        case "wealth_tax":
          // Redistribution touched many accounts; the alerts that accompany it
          // carry per-user portfolio refreshes via their own affectedUsers set.
          break;
        case "margin_call":
          affectedUsers.add(e.userId);
          envelopes.push({
            target: e.userId,
            msg: {
              type: "margin_call",
              challengeId: this.challenge.id,
              data: {
                freeCash: e.freeCash,
                liquidated: e.liquidated,
                ts: e.ts,
              },
            },
          });
          break;
        case "alert":
          envelopes.push({
            target: e.userId,
            msg: {
              type: "alert",
              challengeId: this.challenge.id,
              data: { level: e.level, message: e.message, ts: e.ts },
            },
          });
          break;
        case "fair_value":
          await setFairValue(
            this.redis,
            this.challenge.id,
            e.symbol,
            e.fairValue,
          );
          this.persistence.queueWrite(async (tx) => {
            await tx
              .insert(fairValues)
              .values({
                challengeId: this.challenge.id,
                symbol: e.symbol,
                fairValue: e.fairValue,
                updatedAt: new Date(e.ts),
              })
              .onConflictDoUpdate({
                target: [fairValues.challengeId, fairValues.symbol],
                set: { fairValue: e.fairValue, updatedAt: new Date(e.ts) },
              });
          });
          envelopes.push({
            target: "all",
            msg: {
              type: "fair_value",
              challengeId: this.challenge.id,
              data: { symbol: e.symbol, fairValue: e.fairValue, ts: e.ts },
            },
          });
          break;
      }
    }

    for (const e of lastPrice.values()) {
      await setPrice(this.redis, this.challenge.id, e.symbol, e.price, now);
      {
        const snap = this.engine.snapshot(e.symbol);
        const mid = midFromBook(snap.bids, snap.asks) ?? e.price;
        await setMidPrice(this.redis, this.challenge.id, e.symbol, mid, now);
      }
      envelopes.push({
        target: "all",
        msg: {
          type: "price",
          challengeId: this.challenge.id,
          data: {
            symbol: e.symbol,
            price: e.price,
            change: e.change,
            timestamp: e.ts,
          },
        },
      });
    }
    for (const e of lastBook.values()) {
      await setBookSnapshot(this.redis, this.challenge.id, {
        symbol: e.symbol,
        bids: e.bids,
        asks: e.asks,
        sequence: e.sequence,
      });
      {
        const mid = midFromBook(e.bids, e.asks);
        if (mid != null) {
          await setMidPrice(this.redis, this.challenge.id, e.symbol, mid, now);
        }
      }
      envelopes.push({
        target: "all",
        msg: {
          type: "book",
          challengeId: this.challenge.id,
          data: {
            symbol: e.symbol,
            bids: e.bids,
            asks: e.asks,
            sequence: e.sequence,
          },
        },
      });
    }

    // Push fresh portfolio snapshots to affected users.
    for (const userId of affectedUsers) {
      envelopes.push({
        target: userId,
        msg: {
          type: "portfolio",
          challengeId: this.challenge.id,
          data: this.portfolio(userId),
        },
      });
    }

    await this.persistence.flush({ minuteCount: this.minuteCount });
    await appendEvents(this.redis, this.challenge.id, events);
    await publishBroadcast(this.redis, this.challenge.id, envelopes);
  }

  /** Re-sync + push fresh portfolios for users touched by off-book settlement. */
  private async refreshPortfolios(
    userIds: string[],
    _ts: number,
  ): Promise<void> {
    if (userIds.length === 0) return;
    this.persistence.markUsers(userIds);
    const marginEvents = this.enforceMargins(Date.now());
    if (marginEvents.length) await this.emit(marginEvents);
    await this.persistence.flush({ minuteCount: this.minuteCount });
    const envelopes: BroadcastEnvelope[] = userIds.map((userId) => ({
      target: userId,
      msg: {
        type: "portfolio",
        challengeId: this.challenge.id,
        data: this.portfolio(userId),
      },
    }));
    await publishBroadcast(this.redis, this.challenge.id, envelopes);
  }

  private portfolio(userId: string) {
    const pf = this.engine.portfolioOf(userId);
    const m = this.engine.metricsOf(userId);
    // Bond face value is an illiquid asset: it lifts net worth (PnL) but not
    // free cash, so locking cash into bonds still shrinks margin headroom.
    const bondValue = this.markets?.bondValueOf(userId) ?? 0;
    const pnl = pf.pnl + bondValue;
    const score = computeScore(
      {
        userId,
        pnl,
        absInventory: m.inventory,
        spreadCapture: m.spreadCapture,
        quoteUptime: m.quoteUptime,
      },
      this.challenge.scoring,
    );
    const metrics: TraderMetrics = {
      realizedPnl: m.realizedPnl,
      volume: m.volume,
      trades: m.trades,
      spreadCapture: m.spreadCapture,
      quoteUptime: m.quoteUptime,
      inventory: m.inventory,
    };
    return {
      challengeId: this.challenge.id,
      cash: pf.cash,
      positions: pf.positions,
      marketValue: pf.marketValue,
      pnl,
      score,
      metrics,
      ...(this.edenEnabled
        ? { loanDebt: pf.loanDebt, freeCash: pf.freeCash }
        : {}),
    };
  }

  /** Persist per-trader metrics to Redis for the scoring worker + analytics. */
  private async publishMetrics(): Promise<void> {
    if (!this.running) return;
    const entries: Array<{ userId: string; metrics: TraderMetrics }> = [];
    for (const userId of this.engine.accountIds()) {
      if (!UUID_RE.test(userId)) continue; // skip bots / synthetic ids
      const m = this.engine.metricsOf(userId);
      entries.push({
        userId,
        metrics: {
          realizedPnl: m.realizedPnl,
          volume: m.volume,
          trades: m.trades,
          spreadCapture: m.spreadCapture,
          quoteUptime: m.quoteUptime,
          inventory: m.inventory,
        },
      });
    }
    await setTraderMetrics(this.redis, this.challenge.id, entries);
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
