import {
  type EngineEvent,
  type OrderSide,
  type OrderStatus,
  type OrderType,
  type SymbolConfig,
} from "@qtp/shared";
import { OrderBook, type RestingOrder } from "./order-book.js";
import { profitPnl } from "./scoring.js";
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
  /** Supplemental event hedges expire once instead of starting another cycle. */
  autoRoll?: boolean;
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
  /** New Eden absolute human position/working cap; absent preserves legacy sizing. */
  positionCap?: number;
  /** Max resting orders per human trader. Bots are not counted. */
  maxOpenOrders?: number;
  allowMargin: boolean;
}

interface PositionState {
  qty: number;
  avgCost: number;
}

export interface AccountMetrics {
  realizedPnl: number;
  volume: number;
  trades: number;
  spreadCapture: number;
  quoteUptimeMs: number;
}

export interface AccountSnapshot {
  cash: number;
  positions: Array<{ symbol: string; quantity: number; avgPrice: number }>;
  loanDebt?: number;
  metrics?: Partial<AccountMetrics>;
}

/** Versioned JSON checkpoint. Manager timers and runner cursors are separate. */
export interface EngineState {
  version: 1;
  config: EngineConfig;
  accounts: Array<{
    userId: string;
    cash: number;
    positions: AccountSnapshot["positions"];
    loanDebt: number;
    metrics: AccountMetrics;
  }>;
  symbols: Array<{
    config: SymbolConfig;
    autonomous: boolean;
    orders: RestingOrder[];
  }>;
  options: OptionMeta[];
  prices: Record<string, number>;
  fairValues: Record<string, number>;
  frozen: boolean;
  closedSymbols: string[];
  cancelledIds: string[];
  seq: number;
  bookSequence: number;
  volatilityMultiplier: number;
  /** Older version-1 checkpoints predate accepted-deal reservations. */
  reservations?: Array<{ id: string; userId: string; legs: SettlementLeg[] }>;
}

export interface SettlementLeg {
  symbol: string;
  quantity: number;
  price: number;
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
  /** Bypass maxOrderQuantity (per-order and working-size) for admins. */
  admin?: boolean;
  /** A priced IOC never rests; used for executable, price-bounded bot legs. */
  timeInForce?: "IOC";
}

export interface CancelOrderCommand {
  orderId: string;
  userId: string;
  symbol: string;
  side: OrderSide;
  ts: number;
}

const PRICE_TRADE_IMPACT = 0.9 / 50;

/** Largest qty that still fits ±maxOrderQuantity after inventory and working orders. */
export function clampOrderQuantity(args: {
  side: OrderSide;
  requested: number;
  position: number;
  openBuyQty: number;
  openSellQty: number;
  maxOrderQuantity: number;
}): number {
  const room =
    args.side === "buy"
      ? args.maxOrderQuantity - args.position - args.openBuyQty
      : args.maxOrderQuantity + args.position - args.openSellQty;
  if (args.requested <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(args.requested), Math.floor(room)));
}

/**
 * Authoritative, in-memory state machine for one challenge. Pure logic: it
 * takes commands and returns events. The engine app wraps it with Redis I/O.
 * Single-writer by construction, so no locks are needed.
 */
export class ChallengeEngine {
  readonly challengeId: string;
  private cfg: EngineConfig;
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
  /** When true, new placements are rejected; cancels still apply. */
  private frozen = false;
  private readonly closedSymbols = new Set<string>();
  private volatilityMultiplier = 1;
  private checkpointRestored = false;
  private readonly reservations = new Map<
    string,
    { userId: string; legs: SettlementLeg[] }
  >();

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

  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
  }

  /** Managers must not merge newer/stale DB projections over a full checkpoint. */
  get restoredFromCheckpoint(): boolean {
    return this.checkpointRestored;
  }

  exportState(): EngineState {
    return structuredClone({
      version: 1,
      config: this.cfg,
      accounts: [...this.accounts].map(([userId, account]) => ({
        userId,
        cash: account.cash,
        positions: this.allPositions(userId),
        loanDebt: account.loanDebt,
        metrics: account.metrics,
      })),
      symbols: [...this.symbolCfg].map(([symbol, config]) => ({
        config,
        autonomous: this.autonomousSet.has(symbol),
        orders: this.books.get(symbol)!.orders(),
      })),
      options: [...this.options.values()],
      prices: Object.fromEntries(this.prices),
      fairValues: Object.fromEntries(this.fairValues),
      frozen: this.frozen,
      closedSymbols: [...this.closedSymbols],
      cancelledIds: [...this.cancelledIds],
      seq: this.seq,
      bookSequence: this.bookSequence,
      volatilityMultiplier: this.volatilityMultiplier,
      reservations: [...this.reservations].map(([id, reservation]) => ({
        id,
        ...reservation,
      })),
    });
  }

  /** Validate completely before replacing live state; never replay fills. */
  restoreState(state: unknown): void {
    function assert(condition: unknown, field: string): asserts condition {
      if (!condition) throw new Error(`Invalid engine checkpoint: ${field}`);
    }
    const object = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    const text = (v: unknown): v is string =>
      typeof v === "string" && v.length > 0;
    const finite = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v);
    const counter = (v: unknown): v is number =>
      finite(v) && Number.isSafeInteger(v) && v >= 0;
    const symbolConfig = (v: unknown): boolean =>
      object(v) &&
      text(v.symbol) &&
      finite(v.initialPrice) &&
      v.initialPrice >= 0 &&
      finite(v.volatility) &&
      v.volatility >= 0 &&
      finite(v.tickSize) &&
      v.tickSize > 0 &&
      (v.name === undefined || typeof v.name === "string");
    const uniqueStrings = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every(text) && new Set(v).size === v.length;
    assert(object(state), "object");
    assert(state.version === 1, `unsupported version ${String(state.version)}`);
    const cfg = state.config;
    assert(
      object(cfg) && cfg.challengeId === this.challengeId,
      "challenge identity",
    );
    assert(
      Array.isArray(cfg.symbols) &&
        cfg.symbols.every(symbolConfig) &&
        new Set(cfg.symbols.map((s) => s.symbol)).size === cfg.symbols.length,
      "config.symbols",
    );
    assert(
      finite(cfg.startingCash) &&
        finite(cfg.minPosition) &&
        finite(cfg.maxPosition) &&
        cfg.minPosition <= cfg.maxPosition &&
        counter(cfg.maxOrderQuantity) &&
        cfg.maxOrderQuantity > 0 &&
        typeof cfg.allowMargin === "boolean",
      "config limits",
    );
    assert(
      cfg.positionCap === undefined ||
        (counter(cfg.positionCap) && cfg.positionCap > 0),
      "positionCap",
    );
    assert(
      cfg.maxOpenOrders === undefined ||
        (counter(cfg.maxOpenOrders) && cfg.maxOpenOrders > 0),
      "maxOpenOrders",
    );
    assert(
      counter(state.seq) && counter(state.bookSequence),
      "sequence counters",
    );
    assert(
      typeof state.frozen === "boolean" &&
        finite(state.volatilityMultiplier) &&
        state.volatilityMultiplier > 0,
      "market controls",
    );
    assert(
      uniqueStrings(state.closedSymbols) && uniqueStrings(state.cancelledIds),
      "symbol/cancel sets",
    );
    assert(
      Array.isArray(state.accounts) &&
        Array.isArray(state.symbols) &&
        Array.isArray(state.options),
      "accounts/symbols/options",
    );
    const users = new Set<string>();
    for (const account of state.accounts) {
      assert(
        object(account) && text(account.userId) && !users.has(account.userId),
        "account identity",
      );
      users.add(account.userId);
      assert(
        finite(account.cash) &&
          finite(account.loanDebt) &&
          account.loanDebt >= 0 &&
          Array.isArray(account.positions),
        "account balances",
      );
      const positions = new Set<string>();
      for (const p of account.positions) {
        assert(
          object(p) &&
            text(p.symbol) &&
            !positions.has(p.symbol) &&
            finite(p.quantity) &&
            finite(p.avgPrice) &&
            p.avgPrice >= 0,
          "position",
        );
        positions.add(p.symbol);
      }
      assert(
        object(account.metrics) &&
          [
            "realizedPnl",
            "volume",
            "trades",
            "spreadCapture",
            "quoteUptimeMs",
          ].every((key) =>
            finite((account.metrics as Record<string, unknown>)[key]),
          ),
        "account metrics",
      );
    }
    const symbols = new Set<string>();
    const orderIds = new Set<string>();
    for (const entry of state.symbols) {
      assert(
        object(entry) &&
          symbolConfig(entry.config) &&
          object(entry.config) &&
          text(entry.config.symbol),
        "symbol config",
      );
      const symbol = entry.config.symbol;
      assert(
        !symbols.has(symbol) &&
          typeof entry.autonomous === "boolean" &&
          Array.isArray(entry.orders),
        "symbol identity/book",
      );
      symbols.add(symbol);
      for (const order of entry.orders) {
        assert(
          object(order) &&
            text(order.id) &&
            !orderIds.has(order.id) &&
            text(order.userId) &&
            (order.side === "buy" || order.side === "sell") &&
            finite(order.price) &&
            order.price > 0 &&
            counter(order.remaining) &&
            order.remaining > 0 &&
            counter(order.seq) &&
            order.seq <= state.seq,
          "resting order",
        );
        orderIds.add(order.id);
      }
    }
    const optionSymbols = new Set<string>();
    for (const option of state.options) {
      assert(
        object(option) &&
          text(option.symbol) &&
          !optionSymbols.has(option.symbol) &&
          text(option.underlying) &&
          text(option.cycleId) &&
          (option.optionType === "call" || option.optionType === "put") &&
          finite(option.strike) &&
          option.strike > 0 &&
          finite(option.openedAt) &&
          finite(option.expiresAt) &&
          option.expiresAt > option.openedAt,
        "option metadata",
      );
      assert(
        option.autoRoll === undefined || typeof option.autoRoll === "boolean",
        "option rollover",
      );
      optionSymbols.add(option.symbol);
    }
    for (const prices of [state.prices, state.fairValues]) {
      assert(
        object(prices) &&
          Object.entries(prices).every(
            ([symbol, price]) => text(symbol) && finite(price) && price >= 0,
          ),
        "prices/fair values",
      );
    }
    assert(
      [...symbols].every((symbol) =>
        Object.hasOwn(state.prices as object, symbol),
      ),
      "missing listed price",
    );
    const reservations =
      state.reservations === undefined ? [] : state.reservations;
    assert(Array.isArray(reservations), "reservations");
    const reservationIds = new Set<string>();
    for (const reservation of reservations) {
      assert(
        object(reservation) &&
          text(reservation.id) &&
          !reservationIds.has(reservation.id) &&
          text(reservation.userId) &&
          Array.isArray(reservation.legs),
        "reservation identity",
      );
      reservationIds.add(reservation.id);
      for (const leg of reservation.legs) {
        assert(
          object(leg) &&
            text(leg.symbol) &&
            finite(leg.quantity) &&
            Number.isSafeInteger(leg.quantity) &&
            finite(leg.price) &&
            leg.price >= 0 &&
            Number.isFinite(leg.quantity * leg.price),
          "reservation leg",
        );
      }
    }

    // Build separately so even failed hydration cannot partially replace state.
    const saved = structuredClone(state) as unknown as EngineState;
    const next = new ChallengeEngine(saved.config);
    next.books.clear();
    next.symbolCfg.clear();
    next.prices.clear();
    next.autonomousSet.clear();
    for (const entry of saved.symbols) {
      next.addSymbol(entry.config, { autonomous: entry.autonomous });
      for (const order of entry.orders)
        next.books.get(entry.config.symbol)!.add(order);
    }
    for (const option of saved.options) next.registerOption(option);
    for (const account of saved.accounts)
      next.restoreAccount(account.userId, account);
    for (const [symbol, price] of Object.entries(saved.prices))
      next.prices.set(symbol, price);
    for (const [symbol, fv] of Object.entries(saved.fairValues))
      next.fairValues.set(symbol, fv);
    const replace = <K, V>(target: Map<K, V>, source: Map<K, V>): void => {
      target.clear();
      for (const [key, value] of source) target.set(key, value);
    };
    this.cfg = next.cfg;
    replace(this.books, next.books);
    replace(this.symbolCfg, next.symbolCfg);
    replace(this.accounts, next.accounts);
    replace(this.options, next.options);
    replace(this.prices, next.prices);
    replace(this.fairValues, next.fairValues);
    this.autonomousSet.clear();
    for (const symbol of next.autonomousSet) this.autonomousSet.add(symbol);
    this.closedSymbols.clear();
    for (const symbol of saved.closedSymbols) this.closedSymbols.add(symbol);
    this.cancelledIds.clear();
    for (const id of saved.cancelledIds) this.cancelledIds.add(id);
    this.frozen = saved.frozen;
    this.seq = saved.seq;
    this.bookSequence = saved.bookSequence;
    this.volatilityMultiplier = saved.volatilityMultiplier;
    this.reservations.clear();
    // Assignment may have breached capacity since acceptance; do not re-underwrite.
    for (const reservation of saved.reservations ?? []) {
      this.reservations.set(reservation.id, {
        userId: reservation.userId,
        legs: reservation.legs,
      });
    }
    this.checkpointRestored = true;
  }

  setVolatilityMultiplier(multiplier: number): void {
    if (!Number.isFinite(multiplier) || multiplier <= 0)
      throw new Error("Invalid volatility multiplier");
    this.volatilityMultiplier = multiplier;
  }

  isSymbolOpen(symbol: string, now = Date.now()): boolean {
    const option = this.options.get(symbol);
    return (
      this.books.has(symbol) &&
      !this.closedSymbols.has(symbol) &&
      (!option || now < option.expiresAt)
    );
  }

  closeSymbol(symbol: string, ts: number): EngineEvent[] {
    this.closedSymbols.add(symbol);
    return this.cancelSymbolOrders(symbol, ts);
  }

  /** Replace persisted state without replaying fills or charging starting cash. */
  restoreAccount(userId: string, state: AccountSnapshot): void {
    if (
      !Number.isFinite(state.cash) ||
      !Number.isFinite(state.loanDebt ?? 0) ||
      (state.loanDebt ?? 0) < 0 ||
      state.positions.some(
        (p) =>
          !Number.isFinite(p.quantity) ||
          !Number.isFinite(p.avgPrice) ||
          p.avgPrice < 0,
      ) ||
      Object.values(state.metrics ?? {}).some((v) => !Number.isFinite(v))
    )
      throw new Error("Invalid account snapshot");
    const acct = this.ensureAccount(userId);
    acct.cash = state.cash;
    acct.loanDebt = state.loanDebt ?? 0;
    acct.positions = new Map(
      state.positions.map((p) => [
        p.symbol,
        { qty: p.quantity, avgCost: p.avgPrice },
      ]),
    );
    acct.metrics = {
      realizedPnl: 0,
      volume: 0,
      trades: 0,
      spreadCapture: 0,
      quoteUptimeMs: 0,
      ...state.metrics,
    };
  }

  /** Hydrate in persisted price-time order, without matching or emitting fills. */
  restoreRestingOrder(symbol: string, order: RestingOrder): boolean {
    const book = this.books.get(symbol);
    if (
      !book ||
      this.closedSymbols.has(symbol) ||
      !Number.isSafeInteger(order.remaining) ||
      order.remaining <= 0 ||
      !Number.isFinite(order.price) ||
      order.price <= 0 ||
      !Number.isSafeInteger(order.seq) ||
      [...this.books.values()].some((b) => b.has(order.id))
    )
      return false;
    book.add({ ...order });
    this.seq = Math.max(this.seq, order.seq);
    return true;
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
    this.closedSymbols.delete(symbol);
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
   * Host override: set cash and/or per-symbol inventory absolutely, or shift
   * them by `cashDelta` / `delta` against the live account, without touching
   * loan debt or trading metrics. A position that keeps its sign keeps its
   * average cost; otherwise it is costed at `avgPrice` or the mark.
   */
  setAccount(
    userId: string,
    edit: {
      cash?: number;
      cashDelta?: number;
      positions?: Array<{
        symbol: string;
        quantity?: number;
        delta?: number;
        avgPrice?: number;
      }>;
    },
  ): void {
    const existing = this.accounts.get(userId);
    const held = existing?.positions;
    // Both or neither of an absolute value and a delta resolves to NaN and is rejected.
    const cash =
      edit.cashDelta === undefined
        ? edit.cash
        : edit.cash === undefined
          ? (existing?.cash ?? this.cfg.startingCash) + edit.cashDelta
          : Number.NaN;
    const rows = (edit.positions ?? []).map((p) => ({
      symbol: p.symbol,
      avgPrice: p.avgPrice,
      quantity:
        p.delta === undefined
          ? (p.quantity ?? Number.NaN)
          : p.quantity === undefined
            ? (held?.get(p.symbol)?.qty ?? 0) + p.delta
            : Number.NaN,
    }));
    if (
      (cash !== undefined && !Number.isFinite(cash)) ||
      rows.some(
        (p) =>
          // Held symbols stay editable after delisting so they can be zeroed.
          !(this.books.has(p.symbol) || held?.has(p.symbol)) ||
          !Number.isSafeInteger(p.quantity) ||
          (p.avgPrice !== undefined &&
            (!Number.isFinite(p.avgPrice) || p.avgPrice < 0)),
      )
    )
      throw new Error("Invalid account edit");
    const acct = this.ensureAccount(userId);
    if (cash !== undefined) acct.cash = cash;
    for (const p of rows) {
      const cur = acct.positions.get(p.symbol) ?? { qty: 0, avgCost: 0 };
      const sameSign =
        cur.qty !== 0 && Math.sign(cur.qty) === Math.sign(p.quantity);
      const avgCost =
        p.quantity === 0
          ? 0
          : (p.avgPrice ??
            (sameSign ? cur.avgCost : (this.prices.get(p.symbol) ?? 0)));
      // Zero rows stay in the map so persistence overwrites the stored quantity.
      acct.positions.set(p.symbol, { qty: p.quantity, avgCost });
    }
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
    if (!Number.isFinite(deltaQty) || !Number.isFinite(price) || price < 0)
      throw new Error("Invalid settlement");
    if (deltaQty === 0) {
      this.ensureAccount(userId);
      return;
    }
    this.applyFill(userId, symbol, deltaQty, price);
  }

  /** Reserve accepted deal terms without moving cash or positions. */
  reserveSettlement(
    id: string,
    userId: string,
    legs: SettlementLeg[],
  ): boolean {
    if (
      typeof id !== "string" ||
      !id ||
      typeof userId !== "string" ||
      !userId ||
      legs.some(
        (leg) =>
          typeof leg.symbol !== "string" ||
          !leg.symbol ||
          !Number.isSafeInteger(leg.quantity) ||
          !Number.isFinite(leg.price) ||
          leg.price < 0 ||
          !Number.isFinite(leg.quantity * leg.price),
      )
    )
      return false;
    const existing = this.reservations.get(id);
    if (existing) {
      return (
        existing.userId === userId &&
        existing.legs.length === legs.length &&
        existing.legs.every((leg, index) => {
          const other = legs[index]!;
          return (
            leg.symbol === other.symbol &&
            leg.quantity === other.quantity &&
            leg.price === other.price
          );
        })
      );
    }
    const quantities = new Map<string, { buy: number; sell: number }>();
    for (const leg of legs) {
      if (!this.isSymbolOpen(leg.symbol)) return false;
      const quantity = quantities.get(leg.symbol) ?? { buy: 0, sell: 0 };
      if (leg.quantity > 0) quantity.buy += leg.quantity;
      else quantity.sell -= leg.quantity;
      if (
        !Number.isSafeInteger(quantity.buy) ||
        !Number.isSafeInteger(quantity.sell)
      )
        return false;
      quantities.set(leg.symbol, quantity);
    }
    // Non-Eden challenges retain their shipped working-cap semantics.
    if (this.cfg.positionCap !== undefined) {
      const cap = userId.startsWith("bot:") ? undefined : this.cfg.positionCap;
      for (const [symbol, quantity] of quantities) {
        const position =
          this.accounts.get(userId)?.positions.get(symbol)?.qty ?? 0;
        const buys =
          quantity.buy + this.reservedQuantity(userId, symbol, "buy");
        const sells =
          quantity.sell + this.reservedQuantity(userId, symbol, "sell");
        if (
          quantity.buy > 0 &&
          (!Number.isSafeInteger(buys) ||
            position + buys + this.openOrderQuantity(userId, symbol, "buy") >
              (cap ?? this.cfg.maxPosition))
        )
          return false;
        if (
          quantity.sell > 0 &&
          (!Number.isSafeInteger(sells) ||
            position - sells - this.openOrderQuantity(userId, symbol, "sell") <
              (cap === undefined ? this.cfg.minPosition : -cap))
        )
          return false;
      }
    }
    this.reservations.set(id, {
      userId,
      legs: legs.map((leg) => ({ ...leg })),
    });
    return true;
  }

  releaseSettlement(id: string): void {
    this.reservations.delete(id);
  }

  /** Validate legs against working orders and reservations; release this deal first. */
  canSettleOffBook(userId: string, legs: SettlementLeg[]): boolean {
    const changes = new Map<string, number>();
    for (const leg of legs) {
      if (
        !this.isSymbolOpen(leg.symbol) ||
        !Number.isFinite(leg.quantity) ||
        !Number.isFinite(leg.price) ||
        leg.price < 0
      )
        return false;
      changes.set(leg.symbol, (changes.get(leg.symbol) ?? 0) + leg.quantity);
    }
    for (const [symbol, delta] of changes) {
      if (delta === 0) continue;
      const side = delta > 0 ? "buy" : "sell";
      if (
        Math.abs(delta) + this.openOrderQuantity(userId, symbol, side) >
        this.capacity(userId, symbol, side)
      )
        return false;
    }
    return true;
  }

  settleOffBook(userId: string, legs: SettlementLeg[]): boolean {
    if (!this.canSettleOffBook(userId, legs)) return false;
    for (const leg of legs)
      this.settleFill(userId, leg.symbol, leg.quantity, leg.price);
    return true;
  }

  /** Physical, cash-neutral creation/redemption. No naked basket creation. */
  exchangeBasket(
    userId: string,
    symbol: string,
    basket: Array<{ symbol: string; weight: number }>,
    action: "create" | "redeem",
    quantity: number,
  ): boolean {
    if (
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      basket.length === 0 ||
      (action !== "create" && action !== "redeem")
    )
      return false;
    const weights = new Map<string, number>();
    for (const leg of basket) {
      if (
        leg.symbol === symbol ||
        !Number.isFinite(leg.weight) ||
        leg.weight <= 0
      )
        return false;
      weights.set(leg.symbol, (weights.get(leg.symbol) ?? 0) + leg.weight);
    }
    const direction = action === "create" ? 1 : -1;
    const legs: SettlementLeg[] = [];
    let nav = 0;
    for (const [underlying, weight] of weights) {
      const price = this.getPrice(underlying);
      if (
        price === undefined ||
        (action === "create" &&
          this.positionOf(userId, underlying) < weight * quantity)
      )
        return false;
      nav += price * weight;
      legs.push({
        symbol: underlying,
        quantity: -direction * weight * quantity,
        price,
      });
    }
    if (action === "redeem" && this.positionOf(userId, symbol) < quantity)
      return false;
    legs.push({ symbol, quantity: direction * quantity, price: nav });
    const cash = this.cashOf(userId);
    if (!this.settleOffBook(userId, legs)) return false;
    this.ensureAccount(userId).cash = cash;
    return true;
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
    if (
      !meta ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0 ||
      ts < meta.expiresAt ||
      ts >= meta.expiresAt + 15_000 ||
      this.optionIntrinsic(optionSymbol) <= 0
    ) {
      return { events, holderId, assigned: [], exercised: 0 };
    }
    const held = this.positionOf(holderId, optionSymbol);
    const shorts = this.shortHoldersOf(optionSymbol);
    const qty = Math.min(
      quantity,
      Math.max(0, held),
      shorts.reduce((sum, short) => sum + short.qty, 0),
    );
    if (qty <= 0) return { events, holderId, assigned: [], exercised: 0 };

    const { underlying, optionType, strike } = meta;
    // Only worth exercising when in-the-money; closes the option at zero so the
    // premium already paid is realized as the option's cost.
    const assigned = proRataAssign(shorts, qty);
    if (assigned.reduce((sum, a) => sum + a.qty, 0) !== qty)
      return { events, holderId, assigned: [], exercised: 0 };

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

  /** Resting working orders for a trader across every book. */
  openOrderCount(userId: string): number {
    let n = 0;
    for (const book of this.books.values()) n += book.countForUser(userId);
    return n;
  }

  /** Remaining working size for a trader, optionally scoped to a symbol/side. */
  openOrderQuantity(userId: string, symbol?: string, side?: OrderSide): number {
    if (symbol) {
      return this.books.get(symbol)?.remainingForUser(userId, side) ?? 0;
    }
    let qty = 0;
    for (const book of this.books.values()) {
      qty += book.remainingForUser(userId, side);
    }
    return qty;
  }

  getAccount(userId: string): {
    cash: number;
    positions: Array<PositionState & { symbol: string }>;
  } {
    const acct = this.ensureAccount(userId);
    return {
      cash: acct.cash,
      positions: [...acct.positions.entries()]
        .filter(([, p]) => p.qty !== 0 || p.avgCost !== 0)
        .map(([symbol, p]) => ({ symbol, ...p })),
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
    // Profit vs starting cash; borrowed money is not wealth (comp_desc S1).
    const pnl = profitPnl(
      acct.cash,
      marketValue,
      this.cfg.startingCash,
      acct.loanDebt,
    );
    return {
      cash: acct.cash,
      positions,
      marketValue,
      pnl,
      loanDebt: acct.loanDebt,
      freeCash: freeCash({
        cash: acct.cash,
        marketValue,
        loanDebt: acct.loanDebt,
      }),
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
   * Apply a loan repayment even if it makes cash negative, capped at debt.
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
  /** All legs fill their original requested size or no state/events escape. */
  placeAtomicOrders(commands: PlaceOrderCommand[]): EngineEvent[] {
    if (
      commands.length === 0 ||
      new Set(commands.map((cmd) => cmd.orderId)).size !== commands.length
    )
      return [];
    const before = this.exportState();
    const checkpointRestored = this.checkpointRestored;
    let committed = false;
    try {
      const events: EngineEvent[] = [];
      for (const cmd of commands) {
        const leg = this.placeOrder({ ...cmd, timeInForce: "IOC" });
        const filled = leg.some(
          (event) =>
            event.type === "order_update" &&
            event.orderId === cmd.orderId &&
            event.userId === cmd.userId &&
            event.symbol === cmd.symbol &&
            event.status === "filled" &&
            event.quantity === cmd.quantity &&
            event.remainingQuantity === 0,
        );
        if (!filled) return [];
        events.push(...leg);
      }
      committed = true;
      return events;
    } catch {
      return [];
    } finally {
      if (!committed) {
        this.restoreState(before);
        // A failed trade is not a restart; preserve the manager hydration flag.
        this.checkpointRestored = checkpointRestored;
      }
    }
  }

  placeOrder(cmd: PlaceOrderCommand): EngineEvent[] {
    const events: EngineEvent[] = [];
    const book = this.books.get(cmd.symbol);
    if (!book || !this.isSymbolOpen(cmd.symbol, cmd.ts)) {
      return [this.rejected(cmd, "unknown symbol")];
    }
    if (!Number.isSafeInteger(cmd.quantity) || cmd.quantity <= 0) {
      return [this.rejected(cmd, "invalid quantity")];
    }
    if (this.frozen && !cmd.force) {
      return [this.rejected(cmd, "market frozen")];
    }
    const maxOpen = this.cfg.maxOpenOrders ?? 25;
    const human = !cmd.force && !cmd.userId.startsWith("bot:");
    if (human && this.openOrderCount(cmd.userId) >= maxOpen) {
      return [this.rejected(cmd, "too many open orders")];
    }
    if (
      cmd.orderType === "limit" &&
      (cmd.price == null || !Number.isFinite(cmd.price) || cmd.price <= 0)
    ) {
      return [this.rejected(cmd, "limit order requires price")];
    }
    if (this.cancelledIds.has(cmd.orderId))
      return [this.offBookCancelUpdate(cmd)];
    if ([...this.books.values()].some((b) => b.has(cmd.orderId))) return [];

    let quantity = cmd.quantity;
    if (human && (!cmd.admin || this.cfg.positionCap !== undefined)) {
      quantity = clampOrderQuantity({
        side: cmd.side,
        requested:
          this.cfg.positionCap === undefined || cmd.admin
            ? cmd.quantity
            : Math.min(cmd.quantity, this.cfg.maxOrderQuantity),
        position: this.positionOf(cmd.userId, cmd.symbol),
        openBuyQty:
          book.remainingForUser(cmd.userId, "buy") +
          this.reservedQuantity(cmd.userId, cmd.symbol, "buy"),
        openSellQty:
          book.remainingForUser(cmd.userId, "sell") +
          this.reservedQuantity(cmd.userId, cmd.symbol, "sell"),
        maxOrderQuantity: this.cfg.positionCap ?? this.cfg.maxOrderQuantity,
      });
      if (quantity <= 0) {
        return [this.rejected(cmd, "no capacity")];
      }
    }

    let remaining = quantity;
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

      const takerCap = Math.min(
        this.capacity(cmd.userId, symbol, cmd.side),
        cmd.force ? Infinity : this.fundable(cmd.userId, cmd.side, best.price),
      );
      if (takerCap <= 0) break; // taker at position or cash limit
      const makerCap = Math.min(
        this.capacity(best.userId, symbol, best.side),
        this.fundable(best.userId, best.side, best.price),
      );
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
      this.recordSpreadCapture(
        best.userId,
        best.side,
        midBefore,
        tradePrice,
        fill,
      );

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
      events.push(
        this.orderUpdate(
          best,
          symbol,
          best.remaining <= 0 ? "filled" : "partially_filled",
          cmd.ts,
        ),
      );
      touched.add(symbol);
    }

    // Rest remainder for limit orders.
    let status: OrderStatus;
    if (
      remaining > 0 &&
      cmd.orderType === "limit" &&
      cmd.price != null &&
      cmd.timeInForce !== "IOC"
    ) {
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
        status = remaining === quantity ? "open" : "partially_filled";
        touched.add(symbol);
      }
    } else if (remaining > 0) {
      // Market remainder (or limit at-limit) is cancelled.
      status = "cancelled";
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
      quantity,
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

  cancelUserOrders(userId: string, ts: number): EngineEvent[] {
    const events: EngineEvent[] = [];
    for (const [symbol, book] of this.books) {
      const orders = book.orders().filter((o) => o.userId === userId);
      for (const order of orders) {
        book.remove(order.id);
        events.push(this.orderUpdate(order, symbol, "cancelled", ts));
      }
      if (orders.length) events.push(this.bookUpdate(symbol, ts));
    }
    return events;
  }

  cancelSymbolOrders(symbol: string, ts: number): EngineEvent[] {
    const book = this.books.get(symbol);
    if (!book) return [];
    const events = book.orders().map((order) => {
      book.remove(order.id);
      return this.orderUpdate(order, symbol, "cancelled", ts);
    });
    events.push(this.bookUpdate(symbol, ts));
    return events;
  }

  /** Autonomous random-walk price movement for one symbol. */
  tickPrice(symbol: string, ts: number, rng = Math.random): EngineEvent | null {
    const cfg = this.symbolCfg.get(symbol);
    const cur = this.prices.get(symbol);
    if (!cfg || cur === undefined) return null;
    const delta = (rng() * 2 - 1) * cfg.volatility * this.volatilityMultiplier;
    const next = this.roundTick(
      Math.max(cfg.tickSize, cur + delta),
      cfg.tickSize,
    );
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
    const noise =
      (rng() * 2 - 1) * cfg.volatility * this.volatilityMultiplier * 0.3;
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
  private reservedQuantity(
    userId: string,
    symbol: string,
    side: OrderSide,
  ): number {
    if (this.cfg.positionCap === undefined) return 0;
    let quantity = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.userId !== userId) continue;
      for (const leg of reservation.legs) {
        if (leg.symbol === symbol)
          quantity += Math.max(
            0,
            side === "buy" ? leg.quantity : -leg.quantity,
          );
      }
    }
    return quantity;
  }

  private capacity(userId: string, symbol: string, side: OrderSide): number {
    const pos = this.ensureAccount(userId).positions.get(symbol)?.qty ?? 0;
    const cap = userId.startsWith("bot:") ? undefined : this.cfg.positionCap;
    const capacity =
      side === "buy"
        ? (cap ?? this.cfg.maxPosition) - pos
        : pos - (cap === undefined ? this.cfg.minPosition : -cap);
    return capacity - this.reservedQuantity(userId, symbol, side);
  }

  /** Units a human buyer can pay for in cash when margin is disabled. */
  private fundable(userId: string, side: OrderSide, price: number): number {
    if (this.cfg.allowMargin || side !== "buy" || userId.startsWith("bot:"))
      return Infinity;
    if (!(price > 0)) return Infinity;
    return Math.max(0, Math.floor(this.cashOf(userId) / price + 1e-9));
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
    const next = this.roundTick(
      Math.max(cfg.tickSize, cur + delta),
      cfg.tickSize,
    );
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
