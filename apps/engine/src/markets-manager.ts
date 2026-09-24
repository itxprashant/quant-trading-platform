import { and, eq } from "drizzle-orm";
import { etfNav, type ChallengeEngine } from "@qtp/core";
import {
  addListedSymbol,
  getEtfWindows,
  isEtfWindowOpen,
  publishBroadcast,
  setBookSnapshot,
  setEtfWindow,
  setFairValue,
  setPrice,
  type Redis,
} from "@qtp/bus";
import {
  bondHoldings as bondHoldingsT,
  type Challenge,
  type Database,
} from "@qtp/db";
import {
  bondMarkValue,
  type BondTemplate,
  type EngineEvent,
  type EtfConfig,
  type SymbolConfig,
} from "@qtp/shared";
import type { DbTransaction, Persistence } from "./persistence.js";

/**
 * Bonds + ETFs for New Eden (comp_desc Session 1):
 *
 *  - Bonds: each series once per trader. The trader picks a principal that
 *    must exceed free cash, pays it now, and receives that amount × the
 *    payout multiplier in equal game-minute credits through endsAt (the
 *    inverse cashflow of a predatory loan). Outstanding principal is marked
 *    at cost × remaining payout fraction — illiquid, so it lifts net worth
 *    but not free cash.
 *  - ETFs: a synthetic whose fair value tracks a weighted spot basket (NAV).
 *    It trades in the open market, and a periodic 30-second window lets traders
 *    create/redeem units at NAV to arbitrage market dislocations.
 */
export class MarketsManager {
  private readonly bonds: BondTemplate[];
  private readonly etfs: EtfConfig[];
  private readonly bondValue = new Map<string, number>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private running = false;
  private windowLoopStarted = false;
  private bondWork: Promise<void> = Promise.resolve();
  private persistence?: Pick<Persistence, "queueWrite" | "markUsers">;
  private dispatch: (task: () => Promise<void>) => void = (task) => {
    void task().catch(console.error);
  };

  constructor(
    private readonly engine: ChallengeEngine,
    private readonly redis: Redis,
    private readonly db: Database,
    private readonly challenge: Challenge,
    bonds: BondTemplate[],
    etfs: EtfConfig[],
    private readonly minuteMs: number,
    private readonly emit: (events: EngineEvent[]) => Promise<void>,
    private readonly refreshPortfolios: (
      userIds: string[],
      ts: number,
    ) => Promise<void>,
  ) {
    this.bonds = [...bonds];
    this.etfs = [...etfs];
  }

  get hasBonds(): boolean {
    return this.bonds.length > 0;
  }

  get hasEtfs(): boolean {
    return this.etfs.length > 0;
  }

  bondValueOf(userId: string): number {
    return this.bondValue.get(userId) ?? 0;
  }

  setDispatcher(dispatch: (task: () => Promise<void>) => void): void {
    this.dispatch = dispatch;
  }

  /** Production must install this before start; emit must flush the queued batch. */
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

  listBond(template: BondTemplate): boolean {
    if (this.bonds.some((bond) => bond.id === template.id)) return false;
    this.bonds.push(template);
    return true;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.bondValue.clear();
    // Restore aggregate bond principal so net worth survives restarts.
    const rows = await this.db
      .select()
      .from(bondHoldingsT)
      .where(eq(bondHoldingsT.challengeId, this.challenge.id));
    for (const r of rows) {
      if (r.quantity > 0) {
        this.bondValue.set(
          r.userId,
          (this.bondValue.get(r.userId) ?? 0) + bondMarkValue(r),
        );
      }
    }

    // List ETFs as tradeable (non-autonomous) instruments around their NAV.
    const now = Date.now();
    const sequence = this.engine.exportState().bookSequence;
    for (const etf of this.etfs) {
      const nav = this.navOf(etf);
      this.engine.addSymbol(
        {
          symbol: etf.symbol,
          name: etf.name,
          initialPrice: Math.max(0.1, nav),
          volatility: 0,
          tickSize: 0.1,
        },
        { autonomous: false },
      );
      await setPrice(
        this.redis,
        this.challenge.id,
        etf.symbol,
        this.engine.getPrice(etf.symbol)!,
        now,
      );
      await setFairValue(
        this.redis,
        this.challenge.id,
        etf.symbol,
        this.engine.getFairValue(etf.symbol) ??
          Math.max(0.1, this.navOf(etf, true)),
      );
      this.engine.setFairValue(
        etf.symbol,
        this.engine.getFairValue(etf.symbol) ??
          Math.max(0.1, this.navOf(etf, true)),
      );
      await setBookSnapshot(this.redis, this.challenge.id, {
        symbol: etf.symbol,
        ...this.engine.snapshot(etf.symbol),
        sequence,
      });
      await addListedSymbol(this.redis, this.challenge.id, etf.symbol);
    }

    // Periodic create/redeem windows: open every 10 game-minutes for 30s.
    if (this.etfs.length > 0) this.ensureWindowLoop();
  }

  /**
   * Introduce a new ETF into a live challenge (no pause). Lists it as a
   * tradeable non-autonomous instrument around its NAV and ensures the periodic
   * create/redeem window loop is running.
   */
  async listEtf(cfg: EtfConfig): Promise<SymbolConfig | null> {
    if (this.etfs.some((e) => e.symbol === cfg.symbol)) return null;
    this.etfs.push(cfg);
    const now = Date.now();
    const nav = Math.max(0.1, this.navOf(cfg));
    const symbolCfg: SymbolConfig = {
      symbol: cfg.symbol,
      name: cfg.name,
      initialPrice: nav,
      volatility: 0,
      tickSize: 0.1,
    };
    this.engine.addSymbol(symbolCfg, { autonomous: false });
    await setPrice(
      this.redis,
      this.challenge.id,
      cfg.symbol,
      this.engine.getPrice(cfg.symbol)!,
      now,
    );
    const fv =
      this.engine.getFairValue(cfg.symbol) ??
      Math.max(0.1, this.navOf(cfg, true));
    await setFairValue(this.redis, this.challenge.id, cfg.symbol, fv);
    this.engine.setFairValue(cfg.symbol, fv);
    await setBookSnapshot(this.redis, this.challenge.id, {
      symbol: cfg.symbol,
      ...this.engine.snapshot(cfg.symbol),
      sequence: this.engine.exportState().bookSequence,
    });
    await addListedSymbol(this.redis, this.challenge.id, cfg.symbol);
    this.ensureWindowLoop();
    return symbolCfg;
  }

  /** Start the periodic create/redeem window loop once. */
  private ensureWindowLoop(): void {
    if (this.windowLoopStarted || !this.running) return;
    const eden = this.challenge.config.eden;
    if (eden && "eventScript" in eden && eden.eventScript === true) return;
    this.windowLoopStarted = true;
    const open = () => {
      if (!this.running || this.etfs.length === 0) return;
      this.dispatch(() => this.openWindows());
      const close = setTimeout(() => {
        this.timers.delete(close);
        if (this.running) this.dispatch(() => this.closeWindows());
      }, 30_000);
      this.timers.add(close);
    };
    const loop = setInterval(open, this.minuteMs * 10);
    this.timers.add(loop as unknown as NodeJS.Timeout);
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.clear();
    this.windowLoopStarted = false;
  }

  /** Recompute and broadcast ETF NAVs (called on the engine tick). */
  async updateNavs(now: number): Promise<void> {
    const events: EngineEvent[] = [];
    for (const etf of this.etfs) {
      const nav = Math.max(0.01, this.navOf(etf, true));
      const fv = this.engine.setFairValue(etf.symbol, nav);
      events.push({
        type: "fair_value",
        challengeId: this.challenge.id,
        symbol: etf.symbol,
        fairValue: fv,
        ts: now,
      });
    }
    if (events.length > 0) await this.emit(events);
  }

  /** Pay scheduled bond credits — called by the runner every game-minute. */
  payCoupons(now: number): Promise<void> {
    const work = this.bondWork.then(() => this.payBondPayouts(now));
    this.bondWork = work.catch(() => {});
    return work;
  }

  private async payBondPayouts(now: number): Promise<void> {
    if (this.challenge.frozen) return;
    const rows = await this.db
      .select()
      .from(bondHoldingsT)
      .where(eq(bondHoldingsT.challengeId, this.challenge.id));
    const end = this.challenge.endsAt?.getTime();
    const touched = new Set<string>();
    const events: EngineEvent[] = [];
    const payments: Array<{
      id: string;
      userId: string;
      coupon: number;
      couponsPaid: number;
      markBefore: number;
      markAfter: number;
    }> = [];
    for (const r of rows) {
      if (r.quantity <= 0) continue;
      const remaining = r.faceValue - r.couponsPaid;
      if (!(remaining > 0) || !Number.isFinite(remaining)) continue;
      const minutes =
        end != null && now < end
          ? Math.max(1, Math.ceil((end - now) / this.minuteMs))
          : 1;
      const coupon = remaining / minutes;
      if (!Number.isFinite(coupon) || coupon === 0) continue;
      const couponsPaid = r.couponsPaid + coupon;
      payments.push({
        id: r.id,
        userId: r.userId,
        coupon,
        couponsPaid,
        markBefore: bondMarkValue(r),
        markAfter: bondMarkValue({ ...r, couponsPaid }),
      });
      touched.add(r.userId);
      events.push({
        type: "alert",
        challengeId: this.challenge.id,
        userId: r.userId,
        level: "info",
        message: `Bond payout: +$${coupon.toFixed(2)} from ${r.name}.`,
        ts: now,
      });
    }
    if (payments.length === 0) return;
    await this.write(async (tx) => {
      for (const payment of payments) {
        await tx
          .update(bondHoldingsT)
          .set({ couponsPaid: payment.couponsPaid })
          .where(eq(bondHoldingsT.id, payment.id));
      }
    });
    for (const payment of payments) {
      this.engine.adjustCash(payment.userId, payment.coupon);
      this.bondValue.set(
        payment.userId,
        Math.max(
          0,
          (this.bondValue.get(payment.userId) ?? 0) -
            (payment.markBefore - payment.markAfter),
        ),
      );
    }
    this.persistence?.markUsers([...touched]);
    if (events.length > 0) await this.emit(events);
    await this.refreshPortfolios([...touched], now);
  }

  /* ---- Trader commands ---- */

  purchaseBond(
    userId: string,
    bondId: string,
    price: number,
    ts: number,
  ): Promise<void> {
    const work = this.bondWork.then(() =>
      this.buyBond(userId, bondId, price, ts),
    );
    this.bondWork = work.catch(() => {});
    return work;
  }

  private async buyBond(
    userId: string,
    bondId: string,
    price: number,
    ts: number,
  ): Promise<void> {
    const tpl = this.bonds.find((b) => b.id === bondId);
    if (
      !tpl ||
      !Number.isFinite(price) ||
      price <= 0 ||
      price > 1_000_000
    ) {
      await this.alert(userId, "Unknown bond or invalid price.", "warning", ts);
      return;
    }
    const existing = await this.db
      .select()
      .from(bondHoldingsT)
      .where(
        and(
          eq(bondHoldingsT.challengeId, this.challenge.id),
          eq(bondHoldingsT.userId, userId),
          eq(bondHoldingsT.bondId, bondId),
        ),
      );
    if ((existing[0]?.quantity ?? 0) > 0) {
      await this.alert(
        userId,
        `${tpl.name} can be bought only once.`,
        "warning",
        ts,
      );
      return;
    }
    const end = this.challenge.endsAt?.getTime();
    if (end == null || end <= ts) {
      await this.alert(
        userId,
        "Bond purchase requires a future session end.",
        "warning",
        ts,
      );
      return;
    }
    const free = this.engine.freeCashOf(userId);
    if (!Number.isFinite(free) || !(price > free)) {
      await this.alert(
        userId,
        `Price must exceed free cash ($${free.toFixed(2)}).`,
        "warning",
        ts,
      );
      return;
    }
    const multiplier =
      tpl.payoutMultiplier ??
      this.challenge.config.eden?.rules.loanRepayMultiplier ??
      2;
    const faceValue = price * multiplier;
    await this.write(async (tx) => {
      await tx.insert(bondHoldingsT).values({
        challengeId: this.challenge.id,
        userId,
        bondId,
        name: tpl.name,
        quantity: 1,
        price,
        faceValue,
        couponsPaid: 0,
      });
    });
    this.engine.adjustCash(userId, -price);
    this.bondValue.set(
      userId,
      (this.bondValue.get(userId) ?? 0) +
        bondMarkValue({ quantity: 1, price, faceValue, couponsPaid: 0 }),
    );
    this.persistence?.markUsers([userId]);
    await this.alert(
      userId,
      `Bought ${tpl.name} for $${price.toFixed(2)}; ${multiplier}× paid uniformly until the end.`,
      "info",
      ts,
    );
    await this.refreshPortfolios([userId], ts);
  }

  async etfTrade(
    userId: string,
    etfSymbol: string,
    action: "create" | "redeem",
    quantity: number,
    ts: number,
  ): Promise<void> {
    const etf = this.etfs.find((e) => e.symbol === etfSymbol);
    if (!etf || !Number.isSafeInteger(quantity) || quantity <= 0) {
      await this.alert(userId, "Unknown ETF.", "warning", ts);
      return;
    }
    if (!(await isEtfWindowOpen(this.redis, this.challenge.id, etfSymbol))) {
      await this.alert(
        userId,
        `${etfSymbol} create/redeem window is closed.`,
        "warning",
        ts,
      );
      return;
    }
    const nav = Math.max(0.01, this.navOf(etf));
    if (
      !this.engine.exchangeBasket(
        userId,
        etfSymbol,
        etf.basket,
        action,
        quantity,
      )
    ) {
      await this.alert(
        userId,
        "Basket exchange rejected: insufficient inventory, unavailable component, or position/working-order cap exceeded.",
        "warning",
        ts,
      );
      return;
    }
    this.persistence?.markUsers([userId]);
    await this.alert(
      userId,
      `${action === "create" ? "Created" : "Redeemed"} ${quantity} × ${etfSymbol} at NAV $${nav.toFixed(2)}.`,
      "info",
      ts,
    );
    await this.refreshPortfolios([userId], ts);
  }

  /* ---- Window control ---- */
  async openWindows(): Promise<void> {
    const now = Date.now();
    for (const etf of this.etfs) {
      await setEtfWindow(this.redis, this.challenge.id, etf.symbol, true);
    }
    await this.broadcast(
      "info",
      `ETF create/redeem window OPEN for 30s: ${this.etfs.map((e) => e.symbol).join(", ")}.`,
      now,
    );
  }

  async closeWindows(): Promise<void> {
    const now = Date.now();
    for (const etf of this.etfs) {
      await setEtfWindow(this.redis, this.challenge.id, etf.symbol, false);
    }
    await this.broadcast("info", "ETF create/redeem window closed.", now);
  }

  async setWindow(etfSymbol: string, open: boolean, ts: number): Promise<void> {
    await setEtfWindow(this.redis, this.challenge.id, etfSymbol, open);
    await this.broadcast(
      "info",
      `${etfSymbol} create/redeem window ${open ? "OPEN" : "closed"}.`,
      ts,
    );
  }

  async openWindowSymbols(): Promise<string[]> {
    return getEtfWindows(this.redis, this.challenge.id);
  }

  /* ---- Internals ---- */
  private navOf(etf: EtfConfig, fair = false): number {
    const prices: Record<string, number> = {};
    for (const c of etf.basket) {
      prices[c.symbol] =
        (fair ? this.engine.getFairValue(c.symbol) : undefined) ??
        this.engine.getPrice(c.symbol) ??
        0;
    }
    return etfNav(etf.basket, prices);
  }

  private async alert(
    userId: string,
    message: string,
    level: "info" | "warning" | "urgent",
    ts: number,
  ): Promise<void> {
    await this.emit([
      {
        type: "alert",
        challengeId: this.challenge.id,
        userId,
        level,
        message,
        ts,
      },
    ]);
  }

  private async broadcast(
    level: "info" | "warning" | "urgent",
    message: string,
    ts: number,
  ): Promise<void> {
    await publishBroadcast(this.redis, this.challenge.id, [
      {
        target: "all",
        msg: {
          type: "alert",
          challengeId: this.challenge.id,
          data: { level, message, ts },
        },
      },
    ]);
  }
}
