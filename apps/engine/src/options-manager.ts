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
import type { DbTransaction, Persistence } from "./persistence.js";

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
  autoRoll: boolean;
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
  private readonly breaches = new Map<
    string,
    {
      userId: string;
      underlying: string;
      deadline: number;
      sellPrice: number;
      buyPrice: number;
    }
  >();
  private readonly opening = new Set<string>();
  private dispatch: (task: () => Promise<void>) => void = (task) => {
    void task().catch(console.error);
  };
  private running = false;
  private persistence?: Pick<Persistence, "queueWrite" | "markUsers">;

  constructor(
    private readonly engine: ChallengeEngine,
    private readonly redis: Redis,
    private readonly db: Database,
    private readonly challenge: Challenge,
    private readonly opts: EdenOptionsConfig,
    private readonly rules: EdenRules,
    private readonly minuteMs: number,
    private readonly emit: (events: EngineEvent[]) => Promise<void>,
    private readonly refreshPortfolios: (
      userIds: string[],
      ts: number,
    ) => Promise<void>,
  ) {}

  get enabled(): boolean {
    return !!this.opts.enabled;
  }

  /** Route timer work through the runner's single-writer queue, before start(). */
  setDispatcher(dispatch: (task: () => Promise<void>) => void): void {
    this.dispatch = dispatch;
  }

  /** Production must install this before start; emit commits writes + checkpoint. */
  setPersistence(
    persistence: Pick<Persistence, "queueWrite" | "markUsers">,
  ): void {
    this.persistence = persistence;
  }

  private async write(
    write: (tx: DbTransaction) => Promise<void>,
  ): Promise<void> {
    if (this.persistence) this.persistence.queueWrite(write);
    else await this.db.transaction(write);
  }

  private async writeCycleStatus(
    cycleIds: string[],
    status: "exercise_window" | "expired",
  ): Promise<void> {
    if (cycleIds.length === 0) return;
    await this.write(async (tx) => {
      await tx
        .update(optionCyclesT)
        .set({ status })
        .where(inArray(optionCyclesT.id, cycleIds));
      await tx
        .update(optionContractsT)
        .set({ status })
        .where(inArray(optionContractsT.cycleId, cycleIds));
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.restore();
    const breaches = await this.redis.hgetall(this.breachKey());
    for (const [key, value] of Object.entries(breaches)) {
      const breach = JSON.parse(value) as {
        userId: string;
        underlying: string;
        deadline: number;
        sellPrice: number;
        buyPrice: number;
      };
      this.breaches.set(key, breach);
      this.schedule(
        () => this.borderLiquidate(breach.userId, breach.underlying),
        breach.deadline - Date.now(),
      );
    }
    if (
      this.opts.autoCycle &&
      ![...this.cycles.values()].some((c) => c.phase === "open" && c.autoRoll)
    ) {
      await this.openAll();
    }
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Final shutdown, not a pause: cancel timers/books and expire every series. */
  async expireAll(now: number): Promise<void> {
    if (!Number.isFinite(now)) throw new Error("Invalid shutdown timestamp");
    this.stop();
    const symbols = new Set(this.engine.optionSymbols());
    const cycleIds = new Set(
      this.engine.optionMetas().map((meta) => meta.cycleId),
    );
    for (const cycle of this.cycles.values()) {
      cycleIds.add(cycle.cycleId);
      for (const contract of cycle.contracts) symbols.add(contract.symbol);
    }
    await this.writeCycleStatus([...cycleIds], "expired");
    const events: EngineEvent[] = [];
    const affected = new Set<string>();
    for (const symbol of symbols) {
      events.push(...this.engine.closeSymbol(symbol, now));
      for (const userId of this.engine.expireOption(symbol))
        affected.add(userId);
      this.engine.removeSymbol(symbol);
    }
    this.cycles.clear();
    this.persistence?.markUsers([...affected]);
    events.push({
      type: "alert",
      challengeId: this.challenge.id,
      userId: "all",
      level: "info",
      message:
        "Options market closed; all remaining contracts expired worthless.",
      ts: now,
    });
    await this.emit(events);
    await this.refreshPortfolios([...affected], now);
    for (const symbol of symbols) {
      await removeListedSymbol(this.redis, this.challenge.id, symbol);
      await this.redis.del(
        redisKeys.price(this.challenge.id, symbol),
        redisKeys.bookSnapshot(this.challenge.id, symbol),
        redisKeys.fairValue(this.challenge.id, symbol),
      );
      await this.redis.srem(redisKeys.fairValueSet(this.challenge.id), symbol);
    }
    this.breaches.clear();
    await this.redis.del(this.breachKey());
    await this.broadcastContracts(now);
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

  /** Explicit expiry lists an additional, non-rolling series for event hedges. */
  async openOn(underlying: string, expiresAt?: number): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    await this.open(underlying, now, expiresAt);
    await this.broadcastContracts(now);
  }

  async open(
    underlying: string,
    now: number,
    explicitExpiry?: number,
  ): Promise<void> {
    const expiresAt =
      explicitExpiry ?? now + this.opts.cycleMinutes * this.minuteMs;
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      expiresAt <= Date.now()
    )
      throw new Error("Option expiry must be in the future");
    if (
      !this.running ||
      this.opening.has(underlying) ||
      [...this.cycles.values()].some(
        (c) =>
          c.underlying === underlying &&
          c.phase === "open" &&
          (explicitExpiry === undefined
            ? c.autoRoll
            : c.expiresAt === expiresAt),
      )
    )
      return;
    const spot =
      this.engine.getFairValue(underlying) ?? this.engine.getPrice(underlying);
    if (spot === undefined) return;
    this.opening.add(underlying);
    try {
      const cycleId = randomUUID();
      const strikes = this.strikes(spot);
      const contracts: CycleContract[] = [];
      const marks = new Map<string, number>();

      const vol = this.symbolVol(underlying);
      for (const strike of strikes) {
        for (const optionType of ["call", "put"] as OptionType[]) {
          const symbol = optionSymbol(underlying, optionType, strike, cycleId);
          const theo = Math.max(
            0.1,
            theoreticalOption(optionType, spot, strike, vol, 1),
          );
          marks.set(symbol, theo);
          contracts.push({ symbol, optionType, strike });
        }
      }

      await this.write(async (tx) => {
        await tx.insert(optionCyclesT).values({
          id: cycleId,
          challengeId: this.challenge.id,
          underlying,
          status: "open",
          expiresAt: new Date(expiresAt),
          createdAt: new Date(now),
        });
        await tx.insert(optionContractsT).values(
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
      });

      for (const contract of contracts) {
        this.engine.addSymbol(
          {
            symbol: contract.symbol,
            initialPrice: marks.get(contract.symbol)!,
            volatility: 0,
            tickSize: 0.1,
          },
          { autonomous: false },
        );
        this.engine.registerOption({
          ...contract,
          underlying,
          cycleId,
          openedAt: now,
          expiresAt,
          autoRoll: explicitExpiry === undefined,
        });
      }

      this.cycles.set(cycleId, {
        cycleId,
        underlying,
        contracts,
        phase: "open",
        openedAt: now,
        expiresAt,
        autoRoll: explicitExpiry === undefined,
      });
      await this.emit([
        {
          type: "alert",
          challengeId: this.challenge.id,
          userId: "all",
          level: "info",
          message: `Options cycle open on ${underlying}: ${contracts.length} series, expiry ${new Date(expiresAt).toISOString()}.`,
          ts: now,
        },
      ]);
      this.schedule(() => this.close(cycleId), expiresAt - Date.now());
      for (const contract of contracts) {
        const symbol = contract.symbol;
        const mark = marks.get(symbol)!;
        await setPrice(this.redis, this.challenge.id, symbol, mark, now);
        await setFairValue(this.redis, this.challenge.id, symbol, mark);
        await setBookSnapshot(this.redis, this.challenge.id, {
          symbol,
          bids: [],
          asks: [],
          sequence: 0,
        });
        await addListedSymbol(this.redis, this.challenge.id, symbol);
      }
    } finally {
      this.opening.delete(underlying);
    }
  }

  /** Close a cycle: open the 15-second exercise window. */
  async close(cycleId: string): Promise<void> {
    const cycle = this.cycles.get(cycleId);
    if (!cycle || !this.running || cycle.phase !== "open") return;
    const now = Date.now();
    if (now < cycle.expiresAt) return;
    await this.writeCycleStatus([cycleId], "exercise_window");
    cycle.phase = "exercise_window";
    const cancellations = cycle.contracts.flatMap((c) =>
      this.engine.closeSymbol(c.symbol, now),
    );
    await this.emit([
      ...cancellations,
      {
        type: "alert",
        challengeId: this.challenge.id,
        userId: "all",
        level: "warning",
        message: `${cycle.underlying} options expiring: EXERCISE before ${new Date(cycle.expiresAt + 15_000).toISOString()}.`,
        ts: now,
      },
    ]);
    await this.broadcastContracts(now);
    this.schedule(
      () => this.expire(cycleId),
      cycle.expiresAt + 15_000 - Date.now(),
    );
    // The next cycle overlaps the old exercise window, anchored to expiry.
    if (this.opts.autoCycle && cycle.autoRoll) {
      const duration = this.opts.cycleMinutes * this.minuteMs;
      const openedAt =
        cycle.expiresAt +
        Math.floor(Math.max(0, now - cycle.expiresAt) / duration) * duration;
      await this.open(cycle.underlying, openedAt);
      await this.broadcastContracts(now);
    }
  }

  /** Expire a cycle: settle remaining open positions to zero, delist series. */
  async expire(cycleId: string): Promise<void> {
    const cycle = this.cycles.get(cycleId);
    if (!cycle || !this.running) return;
    const now = Date.now();
    if (now < cycle.expiresAt + 15_000) return;
    await this.writeCycleStatus([cycleId], "expired");
    this.cycles.delete(cycleId);
    const affected = new Set<string>();
    const events: EngineEvent[] = [];
    for (const c of cycle.contracts) {
      events.push(...this.engine.closeSymbol(c.symbol, now));
      for (const u of this.engine.expireOption(c.symbol)) affected.add(u);
      this.engine.removeSymbol(c.symbol);
    }
    this.persistence?.markUsers([...affected]);
    events.push({
      type: "alert",
      challengeId: this.challenge.id,
      userId: "all",
      level: "info",
      message: `${cycle.underlying} option cycle expired.`,
      ts: now,
    });
    await this.emit(events);
    await this.refreshPortfolios([...affected], now);
    for (const c of cycle.contracts) {
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
    await this.broadcastContracts(now);
  }

  /* ---- Exercise + assignment ---- */

  /**
   * Exercise an option held by `userId`. Valid only during the exercise window.
   * Returns events to emit; schedules breach liquidation for any seller pushed
   * over the inventory cap by assignment.
   */
  async exercise(
    userId: string,
    symbol: string,
    quantity: number,
    ts: number,
  ): Promise<EngineEvent[]> {
    const meta = this.engine.getOption(symbol);
    if (!meta)
      return this.reject(userId, "That option series is not listed.", ts);
    const cycle = this.cycles.get(meta.cycleId);
    const now = Date.now();
    if (
      !cycle ||
      now < cycle.expiresAt ||
      now >= cycle.expiresAt + 15_000 ||
      ts < cycle.expiresAt ||
      ts >= cycle.expiresAt + 15_000
    ) {
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
    this.persistence?.markUsers([
      userId,
      ...result.assigned.map((assigned) => assigned.userId),
    ]);
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
      await this.checkBreach(a.userId, meta.underlying, now, events);
    }
    await this.checkBreach(userId, meta.underlying, now, events);
    return events;
  }

  /** High-alert + delayed border-price liquidation if over the inventory cap. */
  private async checkBreach(
    userId: string,
    underlying: string,
    ts: number,
    events: EngineEvent[],
  ): Promise<void> {
    const pos = Math.abs(this.engine.positionOf(userId, underlying));
    if (pos <= this.rules.positionCap || userId.startsWith("bot:")) return;
    const key = `${userId}:${underlying}`;
    if (this.breaches.has(key)) return;
    const fv =
      this.engine.getFairValue(underlying) ?? this.engine.getPrice(underlying);
    if (fv === undefined || !Number.isFinite(fv))
      throw new Error("Missing border valuation");
    const breach = {
      userId,
      underlying,
      deadline: ts + 30_000,
      sellPrice: Math.max(0, fv * 0.8),
      buyPrice: Math.max(0, fv * 1.2),
    };
    this.breaches.set(key, breach);
    await this.redis.hset(this.breachKey(), key, JSON.stringify(breach));
    events.push({
      type: "alert",
      challengeId: this.challenge.id,
      userId,
      level: "urgent",
      message: `🚨 ASSIGNMENT BREACH: ${pos} ${underlying} exceeds the ${this.rules.positionCap} cap. Trade back under in 30s or face border-price liquidation.`,
      ts,
    });
    this.schedule(
      () => this.borderLiquidate(userId, underlying),
      breach.deadline - Date.now(),
    );
  }

  private breachKey(): string {
    return `qtp:assignment-breaches:${this.challenge.id}`;
  }

  /** Guaranteed clearing-house settlement at the price fixed on first breach. */
  private async borderLiquidate(
    userId: string,
    underlying: string,
  ): Promise<void> {
    const key = `${userId}:${underlying}`;
    if (!this.running) return;
    const breach = this.breaches.get(key);
    if (!breach || Date.now() < breach.deadline) return;
    const pos = this.engine.positionOf(userId, underlying);
    if (Math.abs(pos) <= this.rules.positionCap) {
      this.breaches.delete(key);
      await this.redis.hdel(this.breachKey(), key);
      return;
    }
    const now = Date.now();
    const fillEvents = this.engine.cancelUserOrders(userId, now);
    const price = pos > 0 ? breach.sellPrice : breach.buyPrice;
    this.engine.settleFill(userId, underlying, -pos, price);
    this.engine.settleFill("bot:clearing", underlying, pos, price);
    this.persistence?.markUsers([userId, "bot:clearing"]);
    await this.emit([
      ...fillEvents,
      {
        type: "alert",
        challengeId: this.challenge.id,
        userId,
        level: "urgent",
        message: `Border-price liquidation executed on ${underlying} at ${price.toFixed(2)}.`,
        ts: now,
      },
    ]);
    await this.refreshPortfolios([userId, "bot:clearing"], now);
    this.breaches.delete(key);
    await this.redis.hdel(this.breachKey(), key);
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
    this.cycles.clear();
    // A checkpoint is authoritative, including an intentionally empty registry.
    // Reconstruct manager scheduling without replacing its books or marks.
    for (const meta of this.engine.optionMetas()) {
      const cycle = this.cycles.get(meta.cycleId) ?? {
        cycleId: meta.cycleId,
        underlying: meta.underlying,
        contracts: [],
        phase: this.engine.isSymbolOpen(meta.symbol)
          ? ("open" as const)
          : ("exercise_window" as const),
        openedAt: meta.openedAt,
        expiresAt: meta.expiresAt,
        autoRoll: meta.autoRoll ?? true,
      };
      cycle.contracts.push({
        symbol: meta.symbol,
        optionType: meta.optionType,
        strike: meta.strike,
      });
      this.cycles.set(meta.cycleId, cycle);
      await addListedSymbol(this.redis, this.challenge.id, meta.symbol);
    }
    const cycleRows = this.engine.restoredFromCheckpoint
      ? []
      : await this.db
          .select()
          .from(optionCyclesT)
          .where(
            and(
              eq(optionCyclesT.challengeId, this.challenge.id),
              inArray(optionCyclesT.status, ["open", "exercise_window"]),
            ),
          );
    const now = Date.now();
    for (const cy of cycleRows) {
      if (this.cycles.has(cy.id)) continue;
      const rows = await this.db
        .select()
        .from(optionContractsT)
        .where(eq(optionContractsT.cycleId, cy.id));
      const expiresAt = cy.expiresAt.getTime();
      const contracts: CycleContract[] = [];
      for (const r of rows) {
        const optionType = r.optionType as OptionType;
        const underlyingFv =
          this.engine.getFairValue(r.underlying) ??
          this.engine.getPrice(r.underlying) ??
          r.strike;
        const fraction = Math.max(
          0,
          Math.min(
            1,
            (expiresAt - now) / Math.max(1, expiresAt - cy.createdAt.getTime()),
          ),
        );
        const mark = Math.max(
          0.1,
          theoreticalOption(
            optionType,
            underlyingFv,
            r.strike,
            this.symbolVol(r.underlying),
            fraction,
          ),
        );
        this.engine.addSymbol(
          {
            symbol: r.symbol,
            initialPrice: mark,
            volatility: 0,
            tickSize: 0.1,
          },
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
          autoRoll:
            expiresAt - cy.createdAt.getTime() ===
            this.opts.cycleMinutes * this.minuteMs,
        });
        await addListedSymbol(this.redis, this.challenge.id, r.symbol);
        contracts.push({ symbol: r.symbol, optionType, strike: r.strike });
      }
      const phase =
        cy.status === "exercise_window" ? "exercise_window" : "open";
      this.cycles.set(cy.id, {
        cycleId: cy.id,
        underlying: cy.underlying,
        contracts,
        phase,
        openedAt: cy.createdAt.getTime(),
        expiresAt,
        autoRoll:
          expiresAt - cy.createdAt.getTime() ===
          this.opts.cycleMinutes * this.minuteMs,
      });
    }
    // Load every cycle first so failover never opens a duplicate next cycle.
    for (const cycle of [...this.cycles.values()]) {
      if (cycle.phase === "open") {
        if (cycle.expiresAt <= now) await this.close(cycle.cycleId);
        else
          this.schedule(() => this.close(cycle.cycleId), cycle.expiresAt - now);
      } else {
        await this.writeCycleStatus([cycle.cycleId], "exercise_window");
        await this.emit(
          cycle.contracts.flatMap((c) =>
            this.engine.closeSymbol(c.symbol, now),
          ),
        );
        if (this.opts.autoCycle && cycle.autoRoll) {
          const duration = this.opts.cycleMinutes * this.minuteMs;
          const openedAt =
            cycle.expiresAt +
            Math.floor(Math.max(0, now - cycle.expiresAt) / duration) *
              duration;
          await this.open(cycle.underlying, openedAt);
        }
      }
      if (now >= cycle.expiresAt + 15_000) await this.expire(cycle.cycleId);
      else if (cycle.phase === "exercise_window")
        this.schedule(
          () => this.expire(cycle.cycleId),
          cycle.expiresAt + 15_000 - now,
        );
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

  private schedule(fn: () => Promise<void>, ms: number): void {
    const t = setTimeout(
      () => {
        this.timers.delete(t);
        if (this.running)
          this.dispatch(async () => {
            if (this.running) await fn();
          });
      },
      Math.max(0, ms),
    );
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
