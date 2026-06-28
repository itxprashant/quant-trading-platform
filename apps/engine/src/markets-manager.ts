import { and, eq } from "drizzle-orm";
import { etfNav, peggedCoupon, type ChallengeEngine } from "@qtp/core";
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
import type {
  BondTemplate,
  EdenConfig,
  EngineEvent,
  EtfConfig,
} from "@qtp/shared";

/**
 * Bonds + ETFs for New Eden (comp_desc Session 1):
 *
 *  - Bonds: bought from the bank for a cash outlay; pay a coupon every 5 game
 *    minutes — either fixed, or the inverse-pegged Aerium yield `(base − price)
 *    / divisor` that bleeds when the underlying spikes (the structural-exploit
 *    trap). Face value is an illiquid asset (counts toward net worth, not free
 *    cash) so locking cash into bonds shrinks margin headroom.
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

  constructor(
    private readonly engine: ChallengeEngine,
    private readonly redis: Redis,
    private readonly db: Database,
    private readonly challenge: Challenge,
    private readonly eden: EdenConfig,
    private readonly minuteMs: number,
    private readonly emit: (events: EngineEvent[]) => Promise<void>,
    private readonly refreshPortfolios: (
      userIds: string[],
      ts: number,
    ) => Promise<void>,
  ) {
    this.bonds = eden.bonds ?? [];
    this.etfs = eden.etfs ?? [];
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

  async start(): Promise<void> {
    this.running = true;
    // Restore aggregate bond face value so net worth survives restarts.
    const rows = await this.db
      .select()
      .from(bondHoldingsT)
      .where(eq(bondHoldingsT.challengeId, this.challenge.id));
    for (const r of rows) {
      if (r.quantity > 0) {
        this.bondValue.set(
          r.userId,
          (this.bondValue.get(r.userId) ?? 0) + r.faceValue * r.quantity,
        );
      }
    }

    // List ETFs as tradeable (non-autonomous) instruments around their NAV.
    const now = Date.now();
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
      await setPrice(this.redis, this.challenge.id, etf.symbol, Math.max(0.1, nav), now);
      await setFairValue(this.redis, this.challenge.id, etf.symbol, Math.max(0.1, nav));
      await setBookSnapshot(this.redis, this.challenge.id, {
        symbol: etf.symbol,
        bids: [],
        asks: [],
        sequence: 0,
      });
      await addListedSymbol(this.redis, this.challenge.id, etf.symbol);
    }

    // Periodic create/redeem windows: open every 10 game-minutes for 30s.
    if (this.etfs.length > 0) {
      const open = () => {
        if (!this.running) return;
        void this.openWindows();
        const close = setTimeout(() => void this.closeWindows(), 30_000);
        this.timers.add(close);
      };
      const loop = setInterval(open, this.minuteMs * 10);
      this.timers.add(loop as unknown as NodeJS.Timeout);
    }
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.clear();
  }

  /** Recompute and broadcast ETF NAVs (called on the engine tick). */
  async updateNavs(now: number): Promise<void> {
    const events: EngineEvent[] = [];
    for (const etf of this.etfs) {
      const nav = Math.max(0.01, this.navOf(etf));
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

  /** Pay bond coupons — called by the runner every 5th game-minute. */
  async payCoupons(now: number): Promise<void> {
    if (this.bonds.length === 0) return;
    const rows = await this.db
      .select()
      .from(bondHoldingsT)
      .where(eq(bondHoldingsT.challengeId, this.challenge.id));
    const touched = new Set<string>();
    const events: EngineEvent[] = [];
    for (const r of rows) {
      if (r.quantity <= 0) continue;
      const tpl = this.bonds.find((b) => b.id === r.bondId);
      if (!tpl) continue;
      const coupon = this.couponFor(tpl) * r.quantity;
      if (coupon === 0) continue;
      this.engine.adjustCash(r.userId, coupon);
      await this.db
        .update(bondHoldingsT)
        .set({ couponsPaid: r.couponsPaid + coupon })
        .where(eq(bondHoldingsT.id, r.id));
      touched.add(r.userId);
      events.push({
        type: "alert",
        challengeId: this.challenge.id,
        userId: r.userId,
        level: coupon > 0 ? "info" : "warning",
        message:
          coupon > 0
            ? `Coupon paid: +$${coupon.toFixed(0)} from ${tpl.name}.`
            : `Negative yield: −$${Math.abs(coupon).toFixed(0)} bled by ${tpl.name}.`,
        ts: now,
      });
    }
    if (events.length > 0) await this.emit(events);
    await this.refreshPortfolios([...touched], now);
  }

  /* ---- Trader commands ---- */

  async purchaseBond(
    userId: string,
    bondId: string,
    quantity: number,
    ts: number,
  ): Promise<void> {
    const tpl = this.bonds.find((b) => b.id === bondId);
    if (!tpl || quantity <= 0) {
      await this.alert(userId, "Unknown bond.", "warning", ts);
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
    const held = existing[0]?.quantity ?? 0;
    if (held + quantity > tpl.maxPerUser) {
      await this.alert(
        userId,
        `Bond limit reached (max ${tpl.maxPerUser} of ${tpl.name}).`,
        "warning",
        ts,
      );
      return;
    }
    const cost = tpl.price * quantity;
    this.engine.adjustCash(userId, -cost);
    this.bondValue.set(
      userId,
      (this.bondValue.get(userId) ?? 0) + tpl.faceValue * quantity,
    );
    if (existing[0]) {
      await this.db
        .update(bondHoldingsT)
        .set({ quantity: held + quantity })
        .where(eq(bondHoldingsT.id, existing[0].id));
    } else {
      await this.db.insert(bondHoldingsT).values({
        challengeId: this.challenge.id,
        userId,
        bondId,
        name: tpl.name,
        quantity,
        price: tpl.price,
        faceValue: tpl.faceValue,
        couponsPaid: 0,
      });
    }
    await this.alert(
      userId,
      `Bought ${quantity} × ${tpl.name} for $${cost.toFixed(0)}.`,
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
    if (!etf || quantity <= 0) {
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
    if (action === "create") {
      this.engine.settleFill(userId, etfSymbol, quantity, nav); // mint @ NAV
    } else {
      if (this.engine.positionOf(userId, etfSymbol) < quantity) {
        await this.alert(userId, "Not enough ETF units to redeem.", "warning", ts);
        return;
      }
      this.engine.settleFill(userId, etfSymbol, -quantity, nav); // burn @ NAV
    }
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
  private navOf(etf: EtfConfig): number {
    const prices: Record<string, number> = {};
    for (const c of etf.basket) {
      prices[c.symbol] = this.engine.getPrice(c.symbol) ?? 0;
    }
    return etfNav(etf.basket, prices);
  }

  private couponFor(tpl: BondTemplate): number {
    if (tpl.peggedYield) {
      const price = this.engine.getPrice(tpl.peggedYield.symbol) ?? 0;
      return peggedCoupon(tpl.peggedYield.base, price, tpl.peggedYield.divisor);
    }
    return tpl.couponPer5Min ?? 0;
  }

  private async alert(
    userId: string,
    message: string,
    level: "info" | "warning" | "urgent",
    ts: number,
  ): Promise<void> {
    await this.emit([
      { type: "alert", challengeId: this.challenge.id, userId, level, message, ts },
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
