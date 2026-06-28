import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  optionSymbol,
  theoreticalOption,
  type ChallengeEngine,
  type OptionType,
} from "@qtp/core";
import {
  addListedSymbol,
  publishBroadcast,
  removeListedSymbol,
  setBookSnapshot,
  setFairValue,
  setOptionContracts,
  setPrice,
  type Redis,
} from "@qtp/bus";
import {
  optionContracts as optionContractsT,
  optionCycles as optionCyclesT,
  type Challenge,
  type Database,
} from "@qtp/db";
import {
  redisKeys,
  type EdenOptionsConfig,
  type EdenRules,
  type EngineEvent,
  type OptionContract,
} from "@qtp/shared";

interface CycleContract {
  symbol: string;
  optionType: OptionType;
  strike: number;
}

interface CycleState {
  cycleId: string;
  underlying: string;
  contracts: CycleContract[];
  phase: "open" | "exercise_window";
  openedAt: number;
  expiresAt: number;
}

/**
 * Owns the New Eden options market for one challenge: opens 5-minute cycles of
 * call/put series around spot, runs the 15-second exercise window, settles
 * exercises physically against pro-rata assigned sellers, and enforces the
 * assignment-breach rule (over the inventory cap ⇒ high alert, then forced
 * "border price" liquidation if not cured within the grace window).
 */
export class OptionsManager {
  private readonly cycles = new Map<string, CycleState>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly breachTimers = new Map<string, NodeJS.Timeout>();
  private running = false;

  constructor(
    private readonly engine: ChallengeEngine,
    private readonly redis: Redis,
    private readonly db: Database,
    private readonly challenge: Challenge,
    private readonly opts: EdenOptionsConfig,
    private readonly rules: EdenRules,
    private readonly minuteMs: number,
    private readonly emit: (events: EngineEvent[]) => Promise<void>,
    private readonly refreshPortfolios: (userIds: string[], ts: number) => Promise<void>,
  ) {}

  get enabled(): boolean {
    return !!this.opts.enabled;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.restore();
    if (this.opts.autoCycle && this.cycles.size === 0) {
      // Kick off the first cycle shortly after the engine settles.
      this.schedule(() => void this.openAll(), 3000);
    }
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    for (const t of this.breachTimers.values()) clearTimeout(t);
    this.timers.clear();
    this.breachTimers.clear();
  }

  /* ---- Cycle lifecycle ---- */

  /** Open a fresh cycle on every configured underlying. */
  async openAll(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    const underlyings =
      this.opts.underlyings.length > 0
        ? this.opts.underlyings
        : this.engine.autonomousSymbols();
    for (const u of underlyings) await this.open(u, now);
    await this.broadcastContracts(now);
  }

  async open(underlying: string, now: number): Promise<void> {
    const spot =
      this.engine.getFairValue(underlying) ??
      this.engine.getPrice(underlying);
    if (spot === undefined) return;
    const cycleId = randomUUID();
    const expiresAt = now + this.opts.cycleMinutes * this.minuteMs;
    const strikes = this.strikes(spot);
    const contracts: CycleContract[] = [];

    await this.db.insert(optionCyclesT).values({
      id: cycleId,
      challengeId: this.challenge.id,
      underlying,
      status: "open",
      expiresAt: new Date(expiresAt),
    });

    const vol = this.symbolVol(underlying);
    for (const strike of strikes) {
      for (const optionType of ["call", "put"] as OptionType[]) {
        const symbol = optionSymbol(underlying, optionType, strike);
        const theo = Math.max(
          0.1,
          theoreticalOption(optionType, spot, strike, vol, 1),
        );
        this.engine.addSymbol(
          { symbol, initialPrice: theo, volatility: 0, tickSize: 0.1 },
          { autonomous: false },
        );
        this.engine.registerOption({
          symbol,
          underlying,
          optionType,
          strike,
          cycleId,
          openedAt: now,
          expiresAt,
        });
        await setPrice(this.redis, this.challenge.id, symbol, theo, now);
        await setFairValue(this.redis, this.challenge.id, symbol, theo);
        await setBookSnapshot(this.redis, this.challenge.id, {
          symbol,
          bids: [],
          asks: [],
          sequence: 0,
        });
        await addListedSymbol(this.redis, this.challenge.id, symbol);
        contracts.push({ symbol, optionType, strike });
      }
    }

    await this.db.insert(optionContractsT).values(
      contracts.map((c) => ({
        challengeId: this.challenge.id,
        cycleId,
        symbol: c.symbol,
        underlying,
        optionType: c.optionType,
        strike: c.strike,
        status: "open" as const,
        expiresAt: new Date(expiresAt),
      })),
    );

    this.cycles.set(cycleId, {
      cycleId,
      underlying,
      contracts,
      phase: "open",
      openedAt: now,
      expiresAt,
    });
    this.schedule(() => void this.close(cycleId), expiresAt - now);
    await this.emit([
      {
        type: "alert",
        challengeId: this.challenge.id,
        userId: "all",
        level: "info",
        message: `Options cycle open on ${underlying}: ${contracts.length} series, ${this.opts.cycleMinutes}m to expiry.`,
        ts: now,
      },
    ]);
  }

  /** Close a cycle: open the 15-second exercise window. */
  async close(cycleId: string): Promise<void> {
    const cycle = this.cycles.get(cycleId);
    if (!cycle || !this.running) return;
    const now = Date.now();
    cycle.phase = "exercise_window";
    await this.db
      .update(optionCyclesT)
      .set({ status: "exercise_window" })
      .where(eq(optionCyclesT.id, cycleId));
    await this.db
      .update(optionContractsT)
      .set({ status: "exercise_window" })
      .where(eq(optionContractsT.cycleId, cycleId));
    await this.broadcastContracts(now);
    await this.emit([
      {
        type: "alert",
        challengeId: this.challenge.id,
        userId: "all",
        level: "warning",
        message: `${cycle.underlying} options expiring — ${this.opts.exerciseWindowSec}s to EXERCISE in-the-money contracts.`,
        ts: now,
      },
    ]);
    this.schedule(
      () => void this.expire(cycleId),
      this.opts.exerciseWindowSec * 1000,
    );
  }

  /** Expire a cycle: settle remaining open positions to zero, delist series. */
  async expire(cycleId: string): Promise<void> {
    const cycle = this.cycles.get(cycleId);
    if (!cycle) return;
    const now = Date.now();
    const affected = new Set<string>();
    for (const c of cycle.contracts) {
      for (const u of this.engine.expireOption(c.symbol)) affected.add(u);
      this.engine.removeSymbol(c.symbol);
      await removeListedSymbol(this.redis, this.challenge.id, c.symbol);
      await this.redis.del(
        redisKeys.price(this.challenge.id, c.symbol),
        redisKeys.bookSnapshot(this.challenge.id, c.symbol),
        redisKeys.fairValue(this.challenge.id, c.symbol),
      );
      await this.redis.srem(
        redisKeys.fairValueSet(this.challenge.id),
        c.symbol,
      );
    }
    await this.db
      .update(optionCyclesT)
      .set({ status: "expired" })
      .where(eq(optionCyclesT.id, cycleId));
    await this.db
      .update(optionContractsT)
      .set({ status: "expired" })
      .where(eq(optionContractsT.cycleId, cycleId));
    this.cycles.delete(cycleId);
    await this.broadcastContracts(now);
    await this.refreshPortfolios([...affected], now);

    // Continuous cycling: open the next round once all cycles have expired.
    if (this.running && this.opts.autoCycle && this.cycles.size === 0) {
      this.schedule(() => void this.openAll(), this.minuteMs);
    }
  }

  /* ---- Exercise + assignment ---- */

  /**
   * Exercise an option held by `userId`. Valid only during the exercise window.
   * Returns events to emit; schedules breach liquidation for any seller pushed
   * over the inventory cap by assignment.
   */
  exercise(
    userId: string,
    symbol: string,
    quantity: number,
    ts: number,
  ): EngineEvent[] {
    const meta = this.engine.getOption(symbol);
    if (!meta) return this.reject(userId, "That option series is not listed.", ts);
    const cycle = this.cycles.get(meta.cycleId);
    if (!cycle || cycle.phase !== "exercise_window") {
      return this.reject(
        userId,
        "Exercise window is closed for that series.",
        ts,
      );
    }
    const intrinsic = this.engine.optionIntrinsic(symbol);
    if (intrinsic <= 0) {
      return this.reject(userId, "Option is out-of-the-money.", ts);
    }
    const result = this.engine.exerciseOption(userId, symbol, quantity, ts);
    if (result.exercised <= 0) {
      return this.reject(userId, "No long position to exercise.", ts);
    }
    const events = [...result.events];
    events.push({
      type: "alert",
      challengeId: this.challenge.id,
      userId,
      level: "info",
      message: `Exercised ${result.exercised} ${symbol}. Underlying delivered at ${meta.strike}.`,
      ts,
    });
    // Assignment breach check for each assigned seller.
    for (const a of result.assigned) {
      this.checkBreach(a.userId, meta.underlying, ts, events);
    }
    this.checkBreach(userId, meta.underlying, ts, events);
    return events;
  }

  /** High-alert + delayed border-price liquidation if over the inventory cap. */
  private checkBreach(
    userId: string,
    underlying: string,
    ts: number,
    events: EngineEvent[],
  ): void {
    const pos = Math.abs(this.engine.positionOf(userId, underlying));
    if (pos <= this.rules.positionCap) return;
    events.push({
      type: "alert",
      challengeId: this.challenge.id,
      userId,
      level: "urgent",
      message: `🚨 ASSIGNMENT BREACH: ${pos} ${underlying} exceeds the ${this.rules.positionCap} cap. Trade back under in 30s or face border-price liquidation.`,
      ts,
    });
    const key = `${userId}:${underlying}`;
    const existing = this.breachTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => void this.borderLiquidate(userId, underlying), 30_000);
    this.breachTimers.set(key, timer);
    this.timers.add(timer);
  }

  /** Forcibly flatten an over-cap underlying position at market. */
  private async borderLiquidate(userId: string, underlying: string): Promise<void> {
    const key = `${userId}:${underlying}`;
    this.breachTimers.delete(key);
    if (!this.running) return;
    const pos = this.engine.positionOf(userId, underlying);
    if (Math.abs(pos) <= this.rules.positionCap) return; // cured in time
    const now = Date.now();
    const side = pos > 0 ? "sell" : "buy";
    const fillEvents = this.engine.placeOrder({
      orderId: `border:${userId}:${underlying}:${now}`,
      userId,
      symbol: underlying,
      side,
      orderType: "market",
      quantity: Math.abs(pos),
      price: null,
      ts: now,
      force: true,
    });
    await this.emit([
      ...fillEvents,
      {
        type: "alert",
        challengeId: this.challenge.id,
        userId,
        level: "urgent",
        message: `Border-price liquidation executed on ${underlying}.`,
        ts: now,
      },
    ]);
  }

  /* ---- Snapshot / restore / helpers ---- */

  contractsSnapshot(): OptionContract[] {
    const out: OptionContract[] = [];
    for (const cycle of this.cycles.values()) {
      for (const c of cycle.contracts) {
        out.push({
          symbol: c.symbol,
          underlying: cycle.underlying,
          optionType: c.optionType,
          strike: c.strike,
          cycleId: cycle.cycleId,
          expiresAt: new Date(cycle.expiresAt).toISOString(),
          status:
            cycle.phase === "exercise_window" ? "exercise_window" : "open",
        });
      }
    }
    return out;
  }

  private async broadcastContracts(ts: number): Promise<void> {
    const contracts = this.contractsSnapshot();
    await setOptionContracts(this.redis, this.challenge.id, contracts);
    await publishBroadcast(this.redis, this.challenge.id, [
      {
        target: "all",
        msg: {
          type: "option_cycle",
          challengeId: this.challenge.id,
          data: { contracts, ts },
        },
      },
    ]);
  }

  /** Restore live cycles after an engine restart so options survive failover. */
  private async restore(): Promise<void> {
    const cycleRows = await this.db
      .select()
      .from(optionCyclesT)
      .where(
        and(
          eq(optionCyclesT.challengeId, this.challenge.id),
          inArray(optionCyclesT.status, ["open", "exercise_window"]),
        ),
      );
    if (cycleRows.length === 0) return;
    const now = Date.now();
    for (const cy of cycleRows) {
      const rows = await this.db
        .select()
        .from(optionContractsT)
        .where(eq(optionContractsT.cycleId, cy.id));
      const expiresAt = cy.expiresAt.getTime();
      const contracts: CycleContract[] = [];
      for (const r of rows) {
        const optionType = r.optionType as OptionType;
        this.engine.addSymbol(
          { symbol: r.symbol, initialPrice: r.strike, volatility: 0, tickSize: 0.1 },
          { autonomous: false },
        );
        this.engine.registerOption({
          symbol: r.symbol,
          underlying: r.underlying,
          optionType,
          strike: r.strike,
          cycleId: cy.id,
          openedAt: cy.createdAt.getTime(),
          expiresAt,
        });
        await addListedSymbol(this.redis, this.challenge.id, r.symbol);
        contracts.push({ symbol: r.symbol, optionType, strike: r.strike });
      }
      const phase = cy.status === "exercise_window" ? "exercise_window" : "open";
      this.cycles.set(cy.id, {
        cycleId: cy.id,
        underlying: cy.underlying,
        contracts,
        phase,
        openedAt: cy.createdAt.getTime(),
        expiresAt,
      });
      if (phase === "open") {
        this.schedule(() => void this.close(cy.id), Math.max(0, expiresAt - now));
      } else {
        this.schedule(() => void this.expire(cy.id), this.opts.exerciseWindowSec * 1000);
      }
    }
    await this.broadcastContracts(now);
  }

  private reject(userId: string, message: string, ts: number): EngineEvent[] {
    return [
      {
        type: "alert",
        challengeId: this.challenge.id,
        userId,
        level: "warning",
        message,
        ts,
      },
    ];
  }

  private strikes(spot: number): number[] {
    const step = niceStep(spot);
    const atm = Math.max(step, Math.round(spot / step) * step);
    const steps = this.opts.strikeSteps;
    const out: number[] = [];
    for (let i = -steps; i <= steps; i++) {
      const k = atm + i * step;
      if (k > 0) out.push(round2(k));
    }
    return out;
  }

  private symbolVol(underlying: string): number {
    return (
      this.challenge.config.symbols.find((s) => s.symbol === underlying)
        ?.volatility ?? 1
    );
  }

  private schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, Math.max(0, ms));
    this.timers.add(t);
  }
}

/** A "nice" strike increment ≈ 5% of spot, snapped to 1/2/5 × 10ⁿ. */
function niceStep(spot: number): number {
  const raw = Math.max(0.5, spot * 0.05);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const snapped = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return snapped * mag;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
