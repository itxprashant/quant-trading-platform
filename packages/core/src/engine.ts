import {
  type EngineEvent,
  type OrderSide,
  type OrderStatus,
  type OrderType,
  type SymbolConfig,
} from "@qtp/shared";
import { OrderBook, type RestingOrder } from "./order-book.js";
import { carryCharge, freeCash, liquidationLegs } from "./margin.js";
import { intrinsicValue, proRataAssign, type OptionType } from "./options.js";

/** Metadata for a dynamically-listed option series (a tradeable book). */
export interface OptionMeta {
  symbol: string;
  underlying: string;
  optionType: OptionType;
  strike: number;
  cycleId: string;
  /** Epoch ms the cycle was opened and when it closes (for time value). */
  openedAt: number;
  expiresAt: number;
}

/** Outcome of exercising an option series, for the runner to act on. */
export interface ExerciseResult {
  events: EngineEvent[];
  holderId: string;
  /** Sellers that were assigned, with the quantity each received. */
  assigned: Array<{ userId: string; quantity: number }>;
  exercised: number;
}

export interface EngineConfig {
  challengeId: string;
  symbols: SymbolConfig[];
  startingCash: number;
  minPosition: number;
  maxPosition: number;
  maxOrderQuantity: number;
  allowMargin: boolean;
}

interface PositionState {
  qty: number;
  avgCost: number;
}

interface AccountMetrics {
  realizedPnl: number;
  volume: number;
  trades: number;
  spreadCapture: number;
  quoteUptimeMs: number;
}

interface Account {
  cash: number;
  positions: Map<string, PositionState>;
  metrics: AccountMetrics;
  /** New Eden: outstanding loan debt owed to the bank. */
  loanDebt: number;
}

export interface TraderMetricsOut {
  realizedPnl: number;
  volume: number;
  trades: number;
  spreadCapture: number;
  quoteUptime: number;
  inventory: number;
}

export interface PlaceOrderCommand {
  orderId: string;
  userId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  price: number | null;
  ts: number;
  /** Bypass the per-order quantity cap (forced liquidation, assignment). */
  force?: boolean;
}

export interface CancelOrderCommand {
  orderId: string;
  userId: string;
  symbol: string;
  side: OrderSide;
  ts: number;
}

const PRICE_TRADE_IMPACT = 0.9 / 50;

/**
 * Authoritative, in-memory state machine for one challenge. Pure logic: it
 * takes commands and returns events. The engine app wraps it with Redis I/O.
 * Single-writer by construction, so no locks are needed.
 */
export class ChallengeEngine {
  readonly challengeId: string;
  private readonly cfg: EngineConfig;
  private readonly books = new Map<string, OrderBook>();
  private readonly prices = new Map<string, number>();
  private readonly fairValues = new Map<string, number>();
  private readonly symbolCfg = new Map<string, SymbolConfig>();
  private readonly accounts = new Map<string, Account>();
  /** Symbols whose price moves on the autonomous clock (spot underlyings). */
  private readonly autonomousSet = new Set<string>();
  /** Dynamically-listed option series, keyed by tradeable symbol. */
  private readonly options = new Map<string, OptionMeta>();
  private seq = 0;
  private bookSequence = 0;
  /** Orders cancelled before placeOrder rested them on the book. */
  private readonly cancelledIds = new Set<string>();

  constructor(cfg: EngineConfig) {
    this.cfg = cfg;
    this.challengeId = cfg.challengeId;
    for (const s of cfg.symbols) {
      this.books.set(s.symbol, new OrderBook());
      this.prices.set(s.symbol, s.initialPrice);
      this.symbolCfg.set(s.symbol, s);
      this.autonomousSet.add(s.symbol);
    }
  }

  /* ----------------------------------------------------------------- *
   * Dynamic instruments (options, ETFs) — listed after construction
   * ----------------------------------------------------------------- */

  /** Symbols that the autonomous price clock should walk (spot only). */
  autonomousSymbols(): string[] {
    return [...this.autonomousSet];
  }

  hasSymbol(symbol: string): boolean {
    return this.books.has(symbol);
  }

  /**
   * List a new tradeable instrument with its own order book. `autonomous`
   * controls whether the price clock walks it (ETFs/options do not).
   */
  addSymbol(cfg: SymbolConfig, opts: { autonomous?: boolean } = {}): void {
    if (this.books.has(cfg.symbol)) return;
    this.books.set(cfg.symbol, new OrderBook());
    this.prices.set(cfg.symbol, cfg.initialPrice);
    this.symbolCfg.set(cfg.symbol, cfg);
    if (opts.autonomous) this.autonomousSet.add(cfg.symbol);
  }

  /** Remove an instrument and its book (e.g. an expired option series). */
  removeSymbol(symbol: string): void {
    this.books.delete(symbol);
    this.prices.delete(symbol);
    this.symbolCfg.delete(symbol);
    this.fairValues.delete(symbol);
    this.autonomousSet.delete(symbol);
    this.options.delete(symbol);
  }

  setPrice(symbol: string, price: number): void {
    this.prices.set(symbol, price);
  }

  /* ----------------------------------------------------------------- *
   * Option registry + physical exercise / assignment
   * ----------------------------------------------------------------- */
  registerOption(meta: OptionMeta): void {
    this.options.set(meta.symbol, meta);
  }

  getOption(symbol: string): OptionMeta | undefined {
    return this.options.get(symbol);
  }

  optionSymbols(): string[] {
    return [...this.options.keys()];
  }

  optionMetas(): OptionMeta[] {
    return [...this.options.values()];
  }

  /** Best resting bid/ask prices for a symbol (undefined if no liquidity). */
  bestBidAsk(symbol: string): { bid?: number; ask?: number } {
    const book = this.books.get(symbol);
    if (!book) return {};
    return { bid: book.bestBid(), ask: book.bestAsk() };
  }

  /** Current signed position a user holds in a symbol. */
  positionOf(userId: string, symbol: string): number {
    return this.ensureAccount(userId).positions.get(symbol)?.qty ?? 0;
  }

  /** Users net-short a symbol, with their (positive) short quantity. */
  shortHoldersOf(symbol: string): Array<{ id: string; qty: number }> {
    const out: Array<{ id: string; qty: number }> = [];
    for (const [userId, acct] of this.accounts) {
      const q = acct.positions.get(symbol)?.qty ?? 0;
      if (q < 0) out.push({ id: userId, qty: -q });
    }
    return out;
  }

  /** Direct cash adjustment (coupons, grants, taxes, OTC net cash). */
  adjustCash(userId: string, delta: number): void {
    this.ensureAccount(userId).cash += delta;
  }

  /**
   * Apply an off-book settlement fill (option exercise/assignment, OTC, ETF
   * create/redeem). Mutates cash, position, avg cost and realized PnL exactly
   * like a matched trade, but without touching any order book.
   */
  settleFill(
    userId: string,
    symbol: string,
    deltaQty: number,
    price: number,
  ): void {
    if (deltaQty === 0) {
      this.ensureAccount(userId);
      return;
    }
    this.applyFill(userId, symbol, deltaQty, price);
  }

  /**
   * Exercise `quantity` of an option series held long by `holderId`. Long is
   * physically settled against pro-rata assigned short holders: calls deliver
   * the underlying at the strike, puts take it in. Returns the resulting events
   * plus the assigned sellers so the caller can check inventory-cap breaches.
   */
  exerciseOption(
    holderId: string,
    optionSymbol: string,
    quantity: number,
    ts: number,
  ): ExerciseResult {
    const meta = this.options.get(optionSymbol);
    const events: EngineEvent[] = [];
    if (!meta || quantity <= 0) {
      return { events, holderId, assigned: [], exercised: 0 };
    }
    const held = this.positionOf(holderId, optionSymbol);
    const qty = Math.min(quantity, Math.max(0, held));
    if (qty <= 0) return { events, holderId, assigned: [], exercised: 0 };

    const { underlying, optionType, strike } = meta;
    // Only worth exercising when in-the-money; closes the option at zero so the
    // premium already paid is realized as the option's cost.
    const shorts = this.shortHoldersOf(optionSymbol);
    const assigned = proRataAssign(shorts, qty);

    // Holder leg: close the long option, take/deliver underlying at strike.
    this.settleFill(holderId, optionSymbol, -qty, 0);
    if (optionType === "call") {
      this.settleFill(holderId, underlying, qty, strike); // buy underlying @K
    } else {
      this.settleFill(holderId, underlying, -qty, strike); // sell underlying @K
    }
    events.push({
      type: "option_exercised",
      challengeId: this.challengeId,
      userId: holderId,
      symbol: optionSymbol,
      quantity: qty,
      ts,
    });

    // Assigned sellers: close their short option and take the opposite leg.
    const assignedOut: Array<{ userId: string; quantity: number }> = [];
    for (const a of assigned) {
      this.settleFill(a.id, optionSymbol, a.qty, 0); // buy back short option
      if (optionType === "call") {
        this.settleFill(a.id, underlying, -a.qty, strike); // deliver underlying
      } else {
        this.settleFill(a.id, underlying, a.qty, strike); // take underlying
      }
      assignedOut.push({ userId: a.id, quantity: a.qty });
      events.push({
        type: "option_assigned",
        challengeId: this.challengeId,
        userId: a.id,
        symbol: optionSymbol,
        quantity: a.qty,
        ts,
      });
    }

    return { events, holderId, assigned: assignedOut, exercised: qty };
  }

  /**
   * Expire an option series worthless: every open long/short position is
   * settled to zero, realizing the premium as PnL for both sides. Returns the
   * affected user ids so the caller can refresh their portfolios.
   */
  expireOption(optionSymbol: string): string[] {
    const affected: string[] = [];
    for (const [userId, acct] of this.accounts) {
      const q = acct.positions.get(optionSymbol)?.qty ?? 0;
      if (q !== 0) {
        this.settleFill(userId, optionSymbol, -q, 0);
        affected.push(userId);
      }
    }
    return affected;
  }

  /** Intrinsic value of an option series at the current underlying price. */
  optionIntrinsic(optionSymbol: string): number {
    const meta = this.options.get(optionSymbol);
    if (!meta) return 0;
    const spot = this.prices.get(meta.underlying) ?? 0;
    return intrinsicValue(meta.optionType, spot, meta.strike);
  }

  getPrice(symbol: string): number | undefined {
    return this.prices.get(symbol);
  }

  /** Resume a price from persisted state (e.g. after engine restart). */
  restorePrice(symbol: string, price: number): void {
    if (this.prices.has(symbol)) this.prices.set(symbol, price);
  }

  getPrices(): Record<string, number> {
    return Object.fromEntries(this.prices);
  }

  snapshot(symbol: string, depth = 12) {
    return this.books.get(symbol)?.snapshot(depth) ?? { bids: [], asks: [] };
  }

  getAccount(userId: string): { cash: number; positions: PositionState[] } {
    const acct = this.ensureAccount(userId);
    return {
      cash: acct.cash,
      positions: [...acct.positions.entries()]
        .filter(([, p]) => p.qty !== 0 || p.avgCost !== 0)
        .map(([symbol, p]) => ({ symbol, ...p }) as never),
    };
  }

  /** Full per-user portfolio with PnL marked to current prices. */
  portfolioOf(userId: string): {
    cash: number;
    positions: Array<{ symbol: string; quantity: number; avgPrice: number }>;
    marketValue: number;
    pnl: number;
    loanDebt: number;
    freeCash: number;
  } {
    const acct = this.ensureAccount(userId);
    let marketValue = 0;
    const positions: Array<{
      symbol: string;
      quantity: number;
      avgPrice: number;
    }> = [];
    for (const [symbol, p] of acct.positions) {
      const price = this.prices.get(symbol) ?? 0;
      marketValue += p.qty * price;
      if (p.qty !== 0)
        positions.push({ symbol, quantity: p.qty, avgPrice: p.avgCost });
    }
    // PnL nets out loan debt — borrowed cash is not wealth (comp_desc S1).
    const pnl = acct.cash + marketValue - acct.loanDebt;
    return {
      cash: acct.cash,
      positions,
      marketValue,
      pnl,
      loanDebt: acct.loanDebt,
      freeCash: freeCash({ cash: acct.cash, marketValue, loanDebt: acct.loanDebt }),
    };
  }

  /** Iterate every account that has traded (for leaderboard building). */
  accountIds(): string[] {
    return [...this.accounts.keys()];
  }

  /** All positions for a user including closed (qty 0) ones, for persistence. */
  allPositions(
    userId: string,
  ): Array<{ symbol: string; quantity: number; avgPrice: number }> {
    const acct = this.ensureAccount(userId);
    return [...acct.positions.entries()].map(([symbol, p]) => ({
      symbol,
      quantity: p.qty,
      avgPrice: p.avgCost,
    }));
  }

  cashOf(userId: string): number {
    return this.ensureAccount(userId).cash;
  }

  /* ----------------------------------------------------------------- *
   * New Eden — bank, carry, margin, liquidation
   * ----------------------------------------------------------------- */
  loanDebtOf(userId: string): number {
    return this.ensureAccount(userId).loanDebt;
  }

  /** Restore loan debt from persistence (engine restart). */
  setLoanDebt(userId: string, amount: number): void {
    this.ensureAccount(userId).loanDebt = Math.max(0, amount);
  }

  /** Disburse a loan: credit cash, record total to repay (principal×mult). */
  issueLoan(userId: string, principal: number, totalRepay: number): void {
    const acct = this.ensureAccount(userId);
    acct.cash += principal;
    acct.loanDebt += totalRepay;
  }

  /**
   * Apply a loan repayment from cash, capped at the outstanding balance and at
   * available cash. Returns the amount actually paid.
   */
  repayLoan(userId: string, amount: number): number {
    const acct = this.ensureAccount(userId);
    const pay = Math.max(0, Math.min(amount, acct.loanDebt));
    acct.cash -= pay;
    acct.loanDebt = Math.max(0, acct.loanDebt - pay);
    return pay;
  }

  freeCashOf(userId: string): number {
    return this.portfolioOf(userId).freeCash;
  }

  /** Total absolute inventory across symbols for a user. */
  absInventoryOf(userId: string): number {
    let inv = 0;
    for (const p of this.ensureAccount(userId).positions.values())
      inv += Math.abs(p.qty);
    return inv;
  }

  /**
   * Charge the per-minute holding fee against a user's cash. Returns the
   * amount charged (0 if flat). Does not emit events — the caller decides.
   */
  applyCarry(userId: string, ratePerUnitPerMinute: number): number {
    const charge = carryCharge(
      this.absInventoryOf(userId),
      ratePerUnitPerMinute,
    );
    if (charge > 0) this.ensureAccount(userId).cash -= charge;
    return charge;
  }

  /** Market orders that flatten a user's book, for forced liquidation. */
  liquidationCommands(userId: string, ts: number): PlaceOrderCommand[] {
    const acct = this.ensureAccount(userId);
    const legs = liquidationLegs(
      [...acct.positions.entries()].map(([symbol, p]) => ({
        symbol,
        quantity: p.qty,
      })),
    );
    let n = 0;
    return legs.map((leg) => ({
      orderId: `liq:${userId}:${ts}:${++n}`,
      userId,
      symbol: leg.symbol,
      side: leg.side,
      orderType: "market" as OrderType,
      quantity: leg.quantity,
      price: null,
      ts,
      // Liquidation must bypass the per-order quantity cap.
      force: true,
    }));
  }

  /* ----------------------------------------------------------------- *
   * Commands
   * ----------------------------------------------------------------- */
  placeOrder(cmd: PlaceOrderCommand): EngineEvent[] {
    const events: EngineEvent[] = [];
    const book = this.books.get(cmd.symbol);
    if (!book) {
      return [this.rejected(cmd, "unknown symbol")];
    }
    if (cmd.quantity <= 0) {
      return [this.rejected(cmd, "invalid quantity")];
    }
    if (!cmd.force && cmd.quantity > this.cfg.maxOrderQuantity) {
      return [this.rejected(cmd, "invalid quantity")];
    }
    if (cmd.orderType === "limit" && (cmd.price == null || cmd.price <= 0)) {
      return [this.rejected(cmd, "limit order requires price")];
    }

    let remaining = cmd.quantity;
    const oppSide: OrderSide = cmd.side === "buy" ? "sell" : "buy";
    const symbol = cmd.symbol;
    let lastTradePrice: number | null = null;
    const touched = new Set<string>(); // symbols whose books changed

    while (remaining > 0) {
      const best = book.peekBest(oppSide);
      if (!best) break;
      // Price acceptability for limit orders.
      if (cmd.orderType === "limit" && cmd.price != null) {
        if (cmd.side === "buy" && best.price > cmd.price) break;
        if (cmd.side === "sell" && best.price < cmd.price) break;
      }

      const takerCap = this.capacity(cmd.userId, symbol, cmd.side);
      if (takerCap <= 0) break; // taker at position limit
      const makerCap = this.capacity(best.userId, symbol, best.side);
      if (makerCap <= 0) {
        // Maker can no longer trade within limits; pull their order.
        book.remove(best.id);
        events.push(this.orderUpdate(best, symbol, "cancelled", cmd.ts));
        touched.add(symbol);
        continue;
      }

      const fill = Math.min(remaining, best.remaining, takerCap, makerCap);
      const tradePrice = best.price; // trade at the resting (maker) price
      const midBefore = this.prices.get(symbol) ?? tradePrice;
      remaining -= fill;
      lastTradePrice = tradePrice;

      // Maker (the resting order) earns the spread relative to pre-trade mid.
      this.recordSpreadCapture(best.userId, best.side, midBefore, tradePrice, fill);

      const buyerId = cmd.side === "buy" ? cmd.userId : best.userId;
      const sellerId = cmd.side === "buy" ? best.userId : cmd.userId;
      const buyOrderId = cmd.side === "buy" ? cmd.orderId : best.id;
      const sellOrderId = cmd.side === "buy" ? best.id : cmd.orderId;

      this.applyFill(buyerId, symbol, fill, tradePrice);
      this.applyFill(sellerId, symbol, -fill, tradePrice);

      const tradeId = `${cmd.orderId}:${++this.seq}`;
      events.push({
        type: "trade",
        challengeId: this.challengeId,
        tradeId,
        symbol,
        price: tradePrice,
        quantity: fill,
        takerSide: cmd.side,
        buyOrderId,
        sellOrderId,
        buyerId,
        sellerId,
        ts: cmd.ts,
      });

      // Maker order update.
      book.reduceBest(oppSide, fill);
        events.push(this.orderUpdate(best, symbol, best.remaining <= 0 ? "filled" : "partially_filled", cmd.ts));
      touched.add(symbol);
    }

    // Rest remainder for limit orders.
    let status: OrderStatus;
    if (remaining > 0 && cmd.orderType === "limit" && cmd.price != null) {
      if (this.cancelledIds.delete(cmd.orderId)) {
        status = "cancelled";
        remaining = 0;
      } else {
        const resting: RestingOrder = {
          id: cmd.orderId,
          userId: cmd.userId,
          side: cmd.side,
          price: cmd.price,
          remaining,
          seq: ++this.seq,
        };
        book.add(resting);
        status = remaining === cmd.quantity ? "open" : "partially_filled";
        touched.add(symbol);
      }
    } else if (remaining > 0) {
      // Market remainder (or limit at-limit) is cancelled.
      status = remaining === cmd.quantity ? "cancelled" : "partially_filled";
    } else {
      status = "filled";
    }

    events.push({
      type: "order_update",
      challengeId: this.challengeId,
      orderId: cmd.orderId,
      userId: cmd.userId,
      symbol,
      side: cmd.side,
      status,
      quantity: cmd.quantity,
      remainingQuantity: remaining,
      price: cmd.price,
      ts: cmd.ts,
    });

    if (lastTradePrice != null) {
      events.push(this.updatePriceFromTrade(symbol, lastTradePrice, cmd.ts));
    }
    if (touched.has(symbol)) {
      events.push(this.bookUpdate(symbol, cmd.ts));
    }
    return events;
  }

  cancelOrder(cmd: CancelOrderCommand): EngineEvent[] {
    for (const [symbol, book] of this.books) {
      if (book.has(cmd.orderId)) {
        if (book.getOwner(cmd.orderId) !== cmd.userId) {
          return []; // not the owner; ignore
        }
        const removed = book.remove(cmd.orderId);
        if (!removed) return [];
        this.cancelledIds.delete(cmd.orderId);
        return [
          this.orderUpdate(removed, symbol, "cancelled", cmd.ts),
          this.bookUpdate(symbol, cmd.ts),
        ];
      }
    }
    if (this.cancelledIds.has(cmd.orderId)) return [];
    this.cancelledIds.add(cmd.orderId);
    return [this.offBookCancelUpdate(cmd)];
  }

  /** Autonomous random-walk price movement for one symbol. */
  tickPrice(symbol: string, ts: number, rng = Math.random): EngineEvent | null {
    const cfg = this.symbolCfg.get(symbol);
    const cur = this.prices.get(symbol);
    if (!cfg || cur === undefined) return null;
    const delta = (rng() * 2 - 1) * cfg.volatility;
    const next = this.roundTick(Math.max(cfg.tickSize, cur + delta), cfg.tickSize);
    this.prices.set(symbol, next);
    return {
      type: "price_update",
      challengeId: this.challengeId,
      symbol,
      price: next,
      change: next - cur,
      ts,
    };
  }

  /** Biased movement toward an admin-set target at speed 1..10. */
  driftTick(
    symbol: string,
    ts: number,
    target: number,
    speed: number,
    rng = Math.random,
  ): { event: EngineEvent | null; reached: boolean } {
    const cfg = this.symbolCfg.get(symbol);
    const cur = this.prices.get(symbol);
    if (!cfg || cur === undefined) return { event: null, reached: true };
    const maxStep = (speed / 10) * cfg.volatility * 3;
    const dir = Math.sign(target - cur);
    const toward = Math.min(Math.abs(target - cur), maxStep) * dir;
    const noise = (rng() * 2 - 1) * cfg.volatility * 0.3;
    const next = this.roundTick(
      Math.max(cfg.tickSize, cur + toward + noise),
      cfg.tickSize,
    );
    this.prices.set(symbol, next);
    return {
      event: {
        type: "price_update",
        challengeId: this.challengeId,
        symbol,
        price: next,
        change: next - cur,
        ts,
      },
      reached: Math.abs(target - next) <= cfg.tickSize,
    };
  }

  symbols(): string[] {
    return [...this.symbolCfg.keys()];
  }

  /* ----------------------------------------------------------------- *
   * New Eden — fair value (separate from last-trade price)
   * ----------------------------------------------------------------- */
  getFairValue(symbol: string): number | undefined {
    return this.fairValues.get(symbol);
  }

  getFairValues(): Record<string, number> {
    return Object.fromEntries(this.fairValues);
  }

  /** Set a symbol's fair value absolutely. Returns the new FV. */
  setFairValue(symbol: string, fairValue: number): number {
    const fv = Math.max(0, fairValue);
    this.fairValues.set(symbol, fv);
    return fv;
  }

  /** Apply an additive delta to a symbol's fair value (signal news). */
  applyFairValueDelta(symbol: string, delta: number): number {
    const cur = this.fairValues.get(symbol) ?? this.prices.get(symbol) ?? 0;
    const fv = Math.max(0, cur + delta);
    this.fairValues.set(symbol, fv);
    return fv;
  }

  /* ----------------------------------------------------------------- *
   * Internals
   * ----------------------------------------------------------------- */
  private capacity(userId: string, symbol: string, side: OrderSide): number {
    const pos = this.ensureAccount(userId).positions.get(symbol)?.qty ?? 0;
    return side === "buy"
      ? this.cfg.maxPosition - pos
      : pos - this.cfg.minPosition;
  }

  private applyFill(
    userId: string,
    symbol: string,
    deltaQty: number,
    price: number,
  ): void {
    const acct = this.ensureAccount(userId);
    acct.cash -= price * deltaQty;
    acct.metrics.volume += Math.abs(deltaQty);
    acct.metrics.trades += 1;
    const pos = acct.positions.get(symbol) ?? { qty: 0, avgCost: 0 };
    const newQty = pos.qty + deltaQty;
    const sameDir = pos.qty === 0 || Math.sign(pos.qty) === Math.sign(deltaQty);
    if (sameDir) {
      const totalCost =
        Math.abs(pos.qty) * pos.avgCost + Math.abs(deltaQty) * price;
      pos.avgCost = newQty === 0 ? 0 : totalCost / Math.abs(newQty);
    } else {
      // Reducing or flipping: realize PnL on the closed portion.
      const closed = Math.min(Math.abs(pos.qty), Math.abs(deltaQty));
      const dir = pos.qty > 0 ? 1 : -1; // long closed by sell, short by buy
      acct.metrics.realizedPnl += (price - pos.avgCost) * closed * dir;
      if (Math.abs(deltaQty) > Math.abs(pos.qty)) {
        pos.avgCost = price; // flipped through zero
      }
    }
    pos.qty = newQty;
    acct.positions.set(symbol, pos);
  }

  /** Maker captures the half-spread relative to mid on a passive fill. */
  private recordSpreadCapture(
    makerId: string,
    makerSide: OrderSide,
    mid: number,
    tradePrice: number,
    qty: number,
  ): void {
    const captured =
      (makerSide === "sell" ? tradePrice - mid : mid - tradePrice) * qty;
    if (captured > 0) {
      this.ensureAccount(makerId).metrics.spreadCapture += captured;
    }
  }

  private updatePriceFromTrade(
    symbol: string,
    tradePrice: number,
    ts: number,
  ): EngineEvent {
    const cfg = this.symbolCfg.get(symbol)!;
    const cur = this.prices.get(symbol) ?? tradePrice;
    const delta = (tradePrice - cur) * PRICE_TRADE_IMPACT * 50;
    const next = this.roundTick(Math.max(cfg.tickSize, cur + delta), cfg.tickSize);
    this.prices.set(symbol, next);
    return {
      type: "price_update",
      challengeId: this.challengeId,
      symbol,
      price: next,
      change: next - cur,
      ts,
    };
  }

  private bookUpdate(symbol: string, ts: number): EngineEvent {
    const snap = this.books.get(symbol)!.snapshot(12);
    return {
      type: "book_update",
      challengeId: this.challengeId,
      symbol,
      bids: snap.bids,
      asks: snap.asks,
      sequence: ++this.bookSequence,
      ts,
    };
  }

  private orderUpdate(
    o: RestingOrder,
    symbol: string,
    status: OrderStatus,
    ts: number,
  ): EngineEvent {
    return {
      type: "order_update",
      challengeId: this.challengeId,
      orderId: o.id,
      userId: o.userId,
      symbol,
      side: o.side,
      status,
      quantity: 0,
      remainingQuantity: status === "cancelled" ? 0 : Math.max(0, o.remaining),
      price: o.price,
      ts,
    };
  }

  private offBookCancelUpdate(cmd: CancelOrderCommand): EngineEvent {
    return {
      type: "order_update",
      challengeId: this.challengeId,
      orderId: cmd.orderId,
      userId: cmd.userId,
      symbol: cmd.symbol,
      side: cmd.side,
      status: "cancelled",
      quantity: 0,
      remainingQuantity: 0,
      price: null,
      ts: cmd.ts,
    };
  }

  private rejected(cmd: PlaceOrderCommand, _reason: string): EngineEvent {
    return {
      type: "order_update",
      challengeId: this.challengeId,
      orderId: cmd.orderId,
      userId: cmd.userId,
      symbol: cmd.symbol,
      side: cmd.side,
      status: "rejected",
      quantity: cmd.quantity,
      remainingQuantity: cmd.quantity,
      price: cmd.price,
      ts: cmd.ts,
    };
  }

  private ensureAccount(userId: string): Account {
    let acct = this.accounts.get(userId);
    if (!acct) {
      acct = {
        cash: this.cfg.startingCash,
        positions: new Map(),
        metrics: {
          realizedPnl: 0,
          volume: 0,
          trades: 0,
          spreadCapture: 0,
          quoteUptimeMs: 0,
        },
        loanDebt: 0,
      };
      this.accounts.set(userId, acct);
    }
    return acct;
  }

  /** Aggregated performance metrics for one account. */
  metricsOf(userId: string): TraderMetricsOut {
    const acct = this.ensureAccount(userId);
    let inventory = 0;
    for (const p of acct.positions.values()) inventory += Math.abs(p.qty);
    return {
      realizedPnl: acct.metrics.realizedPnl,
      volume: acct.metrics.volume,
      trades: acct.metrics.trades,
      spreadCapture: acct.metrics.spreadCapture,
      quoteUptime: acct.metrics.quoteUptimeMs / 1000,
      inventory,
    };
  }

  /**
   * Sample valid two-sided quoting for the elapsed interval. A user counts if,
   * for any symbol, they rest both a bid and an ask within `maxSpread` and each
   * side carries at least `minSize`. Call this on the engine tick.
   */
  sampleQuoteUptime(dtMs: number, maxSpread: number, minSize: number): void {
    const eligible = new Set<string>();
    for (const book of this.books.values()) {
      for (const [userId, q] of book.quotesByUser()) {
        if (q.bid === undefined || q.ask === undefined) continue;
        if (q.ask - q.bid > maxSpread) continue;
        if (q.bidQty < minSize || q.askQty < minSize) continue;
        eligible.add(userId);
      }
    }
    for (const userId of eligible) {
      this.ensureAccount(userId).metrics.quoteUptimeMs += dtMs;
    }
  }

  private roundTick(price: number, tick: number): number {
    return Math.round(price / tick) * tick;
  }
}
