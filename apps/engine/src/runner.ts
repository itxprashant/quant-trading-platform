import { ChallengeEngine, computeScore, loanBleed } from "@qtp/core";
import {
  appendEvents,
  createRedis,
  getFairValue,
  getPrice,
  publishBroadcast,
  readCommands,
  setBookSnapshot,
  setFairValue,
  setMidPrice,
  setPrice,
  setTraderMetrics,
  type Redis,
} from "@qtp/bus";
import { eq } from "drizzle-orm";
import { participants, type Challenge, type Database } from "@qtp/db";
import {
  midFromBook,
  type BroadcastEnvelope,
  type EdenConfig,
  type EngineCommand,
  type EngineEvent,
  type OtcLeg,
  type TraderMetrics,
} from "@qtp/shared";
import { env } from "./env.js";
import { BotEngine } from "./bots.js";
import { EdenBotEngine } from "./eden-bots.js";
import { OptionsManager } from "./options-manager.js";
import { MarketsManager } from "./markets-manager.js";
import { Persistence } from "./persistence.js";

/**
 * Owns the in-memory matching engine for one challenge: consumes its command
 * stream, mutates state, persists asynchronously, and publishes events.
 */
export class ChallengeRunner {
  private readonly engine: ChallengeEngine;
  private readonly persistence: Persistence;
  private readonly bots: BotEngine;
  private readonly edenBots?: EdenBotEngine;
  private options?: OptionsManager;
  private markets?: MarketsManager;
  private minuteCount = 0;
  private readonly cmdRedis: Redis;
  private running = false;
  private lastId = "$";
  private tickTimer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private botTimer?: NodeJS.Timeout;
  private metricsTimer?: NodeJS.Timeout;
  private minuteTimer?: NodeJS.Timeout;
  private readonly eden?: EdenConfig;
  private readonly edenEnabled: boolean;

  constructor(
    private readonly redis: Redis,
    private readonly db: Database,
    private readonly challenge: Challenge,
  ) {
    this.eden =
      challenge.type === "new_eden" ? challenge.config.eden : undefined;
    this.edenEnabled = !!this.eden?.rules.enabled;
    this.engine = new ChallengeEngine({
      challengeId: challenge.id,
      symbols: challenge.config.symbols,
      startingCash: challenge.config.startingCash,
      minPosition: challenge.config.minPosition,
      maxPosition: challenge.config.maxPosition,
      maxOrderQuantity: challenge.config.maxOrderQuantity,
      allowMargin: challenge.config.allowMargin,
    });
    this.persistence = new Persistence(db, challenge.id, this.engine);
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
    if (this.edenEnabled && this.eden?.options?.enabled) {
      this.options = new OptionsManager(
        this.engine,
        this.redis,
        this.db,
        challenge,
        this.eden.options,
        this.eden.rules,
        env.minuteMs,
        (events) => this.emit(events),
        (userIds, ts) => this.refreshPortfolios(userIds, ts),
      );
    }
    if (
      this.edenEnabled &&
      this.eden &&
      ((this.eden.bonds?.length ?? 0) > 0 || (this.eden.etfs?.length ?? 0) > 0)
    ) {
      this.markets = new MarketsManager(
        this.engine,
        this.redis,
        this.db,
        challenge,
        this.eden,
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

  async start(): Promise<void> {
    this.running = true;
    // Publish initial price + book snapshots so late joiners see state.
    const now = Date.now();
    for (const s of this.challenge.config.symbols) {
      // Resume from persisted price if one exists, else seed the initial.
      const persisted = await getPrice(this.redis, this.challenge.id, s.symbol);
      if (persisted != null) this.engine.restorePrice(s.symbol, persisted);
      const price = this.engine.getPrice(s.symbol) ?? s.initialPrice;
      await setPrice(this.redis, this.challenge.id, s.symbol, price, now);
      // New Eden: seed/restore fair value (defaults to the initial price).
      if (this.edenEnabled) {
        const persistedFv = await getFairValue(this.redis, this.challenge.id, s.symbol);
        const fv = this.engine.setFairValue(s.symbol, persistedFv ?? s.initialPrice);
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

    // New Eden: restore aggregate loan debt so free cash is correct on restart.
    if (this.edenEnabled) {
      const rows = await this.db
        .select({ userId: participants.userId, loanDebt: participants.loanDebt })
        .from(participants)
        .where(eq(participants.challengeId, this.challenge.id));
      for (const r of rows) {
        if (r.loanDebt > 0) this.engine.setLoanDebt(r.userId, r.loanDebt);
      }
    }

    if (this.options) await this.options.start();
    if (this.markets) await this.markets.start();

    void this.commandLoop();
    if (this.challenge.config.autonomousPrice) {
      this.tickTimer = setInterval(() => void this.tick(), env.tickMs);
    }
    if (this.edenEnabled) {
      this.minuteTimer = setInterval(
        () => void this.minuteTick(),
        env.minuteMs,
      );
    }
    if (this.edenBots?.enabled || this.bots.enabled) {
      this.botTimer = setInterval(() => void this.botTick(), env.botMs);
    }
    this.flushTimer = setInterval(() => {
      this.persistence.flush().catch((err) =>
        console.error(`[${this.challenge.slug}] flush error`, err),
      );
    }, env.flushMs);
    this.metricsTimer = setInterval(() => {
      this.publishMetrics().catch((err) =>
        console.error(`[${this.challenge.slug}] metrics error`, err),
      );
    }, env.metricsMs);
    console.log(`[engine] running challenge ${this.challenge.slug}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.options?.stop();
    this.markets?.stop();
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.botTimer) clearInterval(this.botTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    if (this.minuteTimer) clearInterval(this.minuteTimer);
    await this.persistence.flush().catch(() => {});
    await this.cmdRedis.quit().catch(() => {});
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
        this.lastId = nextId;
        if (messages.length === 0) continue;
        const events: EngineEvent[] = [];
        for (const m of messages) {
          events.push(...this.process(m.data));
        }
        await this.emit(events);
      } catch (err) {
        if (this.running) {
          console.error(`[${this.challenge.slug}] command loop error`, err);
          await sleep(500);
        }
      }
    }
  }

  private process(cmd: EngineCommand): EngineEvent[] {
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
        });
      case "cancel_order":
        return this.engine.cancelOrder({
          orderId: cmd.orderId,
          userId: cmd.userId,
          symbol: cmd.symbol,
          side: cmd.side,
          ts: cmd.ts,
        });
      case "issue_loan":
        return this.handleIssueLoan(cmd.userId, cmd.loanId, cmd.principal, cmd.ts);
      case "force_liquidate":
        return this.liquidate(cmd.userId, cmd.reason, cmd.ts);
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
        return this.options?.exercise(cmd.userId, cmd.symbol, cmd.quantity, cmd.ts) ?? [];
      case "open_option_cycle":
        void this.options?.openAll();
        return [];
      case "close_option_cycle":
        void this.options?.close(cmd.cycleId);
        return [];
      case "purchase_bond":
        void this.markets?.purchaseBond(cmd.userId, cmd.bondId, cmd.quantity, cmd.ts);
        return [];
      case "etf_trade":
        void this.markets?.etfTrade(
          cmd.userId,
          cmd.etfSymbol,
          cmd.action,
          cmd.quantity,
          cmd.ts,
        );
        return [];
      case "etf_window":
        void this.markets?.setWindow(cmd.etfSymbol, cmd.open, cmd.ts);
        return [];
      case "execute_otc":
        return this.settleOtc(cmd.offerId, cmd.userId, cmd.legs, cmd.cashToTrader, cmd.ts);
      default:
        return [];
    }
  }

  /** Disburse a loan: credit cash, record 2× repayment, notify the trader. */
  private handleIssueLoan(
    userId: string,
    loanId: string,
    principal: number,
    ts: number,
  ): EngineEvent[] {
    const mult = this.eden?.rules.loanRepayMultiplier ?? 2;
    const totalRepay = principal * mult;
    this.engine.issueLoan(userId, principal, totalRepay);
    return [
      {
        type: "loan_update",
        challengeId: this.challenge.id,
        userId,
        loanId,
        principal,
        remaining: this.engine.loanDebtOf(userId),
        status: "active",
        ts,
      },
      {
        type: "alert",
        challengeId: this.challenge.id,
        userId,
        level: "warning",
        message: `Loan funded: +$${principal.toFixed(0)} now, $${totalRepay.toFixed(0)} due to the bank.`,
        ts,
      },
    ];
  }

  /** Flatten a trader's positions at market and emit a margin-call notice. */
  private liquidate(userId: string, reason: string, ts: number): EngineEvent[] {
    const freeBefore = this.engine.freeCashOf(userId);
    const cmds = this.engine.liquidationCommands(userId, ts);
    const events: EngineEvent[] = [];
    for (const c of cmds) events.push(...this.engine.placeOrder(c));
    events.push({
      type: "margin_call",
      challengeId: this.challenge.id,
      userId,
      freeCash: freeBefore,
      liquidated: cmds.length > 0,
      ts,
    });
    events.push({
      type: "alert",
      challengeId: this.challenge.id,
      userId,
      level: "urgent",
      message: `Margin call — ${reason}. Positions liquidated at market.`,
      ts,
    });
    return events;
  }

  /**
   * Settle a binding OTC deal atomically: each leg transfers signed units at
   * its price, then the net cash term is applied. A binding deal cannot be
   * declined once accepted (comp_desc Deal Desk "Obligation").
   */
  private settleOtc(
    offerId: string,
    userId: string,
    legs: OtcLeg[],
    cashToTrader: number,
    ts: number,
  ): EngineEvent[] {
    for (const leg of legs) {
      if (leg.quantity !== 0) {
        this.engine.settleFill(userId, leg.symbol, leg.quantity, leg.price);
      }
    }
    if (cashToTrader !== 0) this.engine.adjustCash(userId, cashToTrader);
    const summary = legs
      .map((l) => `${l.quantity > 0 ? "+" : ""}${l.quantity} ${l.symbol}@${l.price}`)
      .join(", ");
    return [
      {
        type: "otc_settled",
        challengeId: this.challenge.id,
        offerId,
        userId,
        ts,
      },
      {
        type: "alert",
        challengeId: this.challenge.id,
        userId,
        level: "info",
        message: `Deal settled: ${summary}${cashToTrader ? `, net cash ${cashToTrader > 0 ? "+" : ""}$${cashToTrader.toFixed(0)}` : ""}.`,
        ts,
      },
    ];
  }

  /** Drive autonomous bots: apply their commands and broadcast results. */
  private async botTick(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    const { places, cancels } = this.edenBots
      ? this.edenBots.act(now)
      : this.bots.act(now);
    const events: EngineEvent[] = [];
    for (const c of cancels) {
      events.push(...this.engine.cancelOrder(c));
    }
    for (const p of places) {
      events.push(...this.engine.placeOrder(p));
    }
    await this.emit(events);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
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
        const ev = this.engine.tickPrice(symbol, now);
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
  private async minuteTick(): Promise<void> {
    if (!this.running || !this.edenEnabled || !this.eden) return;
    const now = Date.now();
    const rules = this.eden.rules;
    const events: EngineEvent[] = [];

    // Bond coupons accrue every 5th game-minute (comp_desc Session 1).
    this.minuteCount += 1;
    if (this.markets && this.minuteCount % 5 === 0) {
      await this.markets.payCoupons(now);
    }

    const endsAt = this.challenge.endsAt
      ? new Date(this.challenge.endsAt).getTime()
      : null;
    const minutesLeft = endsAt
      ? Math.max(1, Math.ceil((endsAt - now) / 60_000))
      : 30;

    for (const userId of this.engine.accountIds()) {
      if (!UUID_RE.test(userId)) continue; // skip bots

      // 1. Cost of carry on absolute inventory.
      const carried = this.engine.applyCarry(
        userId,
        rules.costOfCarryPerUnitPerMinute,
      );
      if (carried > 0) {
        events.push({
          type: "carry_charge",
          challengeId: this.challenge.id,
          userId,
          amount: carried,
          ts: now,
        });
      }

      // 2. Predatory loan bleed — amortise remaining debt over minutes left.
      const debt = this.engine.loanDebtOf(userId);
      if (debt > 0) {
        const due = loanBleed(debt, minutesLeft);
        const paid = this.engine.repayLoan(userId, due);
        if (paid > 0) {
          events.push({
            type: "loan_update",
            challengeId: this.challenge.id,
            userId,
            loanId: "",
            principal: 0,
            remaining: this.engine.loanDebtOf(userId),
            status: this.engine.loanDebtOf(userId) <= 0 ? "repaid" : "active",
            ts: now,
          });
        }
      }

      // 3. Margin call when free cash breaches the threshold.
      const free = this.engine.freeCashOf(userId);
      if (free <= rules.marginCallThreshold) {
        if (rules.forcedLiquidation && this.engine.absInventoryOf(userId) > 0) {
          events.push(...this.liquidate(userId, "free cash exhausted", now));
        } else {
          events.push({
            type: "margin_call",
            challengeId: this.challenge.id,
            userId,
            freeCash: free,
            liquidated: false,
            ts: now,
          });
          events.push({
            type: "alert",
            challengeId: this.challenge.id,
            userId,
            level: "urgent",
            message: `Margin warning — free cash $${free.toFixed(0)}. Reduce risk or borrow.`,
            ts: now,
          });
        }
      }
    }

    await this.emit(events);
  }

  private async emit(events: EngineEvent[]): Promise<void> {
    if (events.length === 0) return;
    this.persistence.collect(events);
    const now = Date.now();
    const envelopes: BroadcastEnvelope[] = [];
    const affectedUsers = new Set<string>();

    for (const e of events) {
      switch (e.type) {
        case "price_update":
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
          break;
        case "book_update":
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
        case "margin_call":
          affectedUsers.add(e.userId);
          envelopes.push({
            target: e.userId,
            msg: {
              type: "margin_call",
              challengeId: this.challenge.id,
              data: { freeCash: e.freeCash, liquidated: e.liquidated, ts: e.ts },
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
          await setFairValue(this.redis, this.challenge.id, e.symbol, e.fairValue);
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
