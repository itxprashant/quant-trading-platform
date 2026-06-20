import { ChallengeEngine, computeScore } from "@qtp/core";
import {
  appendEvents,
  createRedis,
  getPrice,
  publishBroadcast,
  readCommands,
  setBookSnapshot,
  setPrice,
  setTraderMetrics,
  type Redis,
} from "@qtp/bus";
import type { Challenge, Database } from "@qtp/db";
import type {
  BroadcastEnvelope,
  EngineCommand,
  EngineEvent,
  TraderMetrics,
} from "@qtp/shared";
import { env } from "./env.js";
import { BotEngine } from "./bots.js";
import { Persistence } from "./persistence.js";

/**
 * Owns the in-memory matching engine for one challenge: consumes its command
 * stream, mutates state, persists asynchronously, and publishes events.
 */
export class ChallengeRunner {
  private readonly engine: ChallengeEngine;
  private readonly persistence: Persistence;
  private readonly bots: BotEngine;
  private readonly cmdRedis: Redis;
  private running = false;
  private lastId = "$";
  private tickTimer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private botTimer?: NodeJS.Timeout;
  private metricsTimer?: NodeJS.Timeout;

  constructor(
    private readonly redis: Redis,
    private readonly db: Database,
    private readonly challenge: Challenge,
  ) {
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
      const snap = this.engine.snapshot(s.symbol);
      await setBookSnapshot(this.redis, this.challenge.id, {
        symbol: s.symbol,
        bids: snap.bids,
        asks: snap.asks,
        sequence: 0,
      });
    }

    void this.commandLoop();
    if (this.challenge.config.autonomousPrice) {
      this.tickTimer = setInterval(() => void this.tick(), env.tickMs);
    }
    if (this.bots.enabled) {
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
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.botTimer) clearInterval(this.botTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
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
          ts: cmd.ts,
        });
      default:
        return [];
    }
  }

  /** Drive autonomous bots: apply their commands and broadcast results. */
  private async botTick(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    const { places, cancels } = this.bots.act(now);
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
    for (const symbol of this.engine.symbols()) {
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

  private portfolio(userId: string) {
    const pf = this.engine.portfolioOf(userId);
    const m = this.engine.metricsOf(userId);
    const score = computeScore(
      {
        userId,
        pnl: pf.pnl,
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
      pnl: pf.pnl,
      score,
      metrics,
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
