import {
  theoreticalOption,
  type ChallengeEngine,
  type CancelOrderCommand,
  type PlaceOrderCommand,
} from "@qtp/core";
import type {
  EdenBotConfig,
  EtfConfig,
  MomentumEffect,
  OrderSide,
  SymbolConfig,
} from "@qtp/shared";

interface BotQuote {
  bidId?: string;
  askId?: string;
}

interface MomentumState {
  effects: MomentumEffect[];
  ticksLeft: number;
}

interface VegaState {
  /** underlyings to straddle while accumulating volatility. */
  underlyings: string[];
  phase: "accumulate" | "dump";
  releaseAt: number;
  /** option symbols the bot bought, to flatten on the crush. */
  held: Set<string>;
}

/**
 * The New Eden bot ecosystem (comp_desc Section 4). Four archetypes share one
 * driver so they all act on the same engine tick:
 *
 *  1. HFT Market Maker  — two-sided quotes around FAIR VALUE (not last price)
 *     for every spot and option, skewed and widened by its own inventory to
 *     defend against adverse selection.
 *  2. Retail / Momentum — chases the latest news pulse (signal OR noise),
 *     crossing the spread so smart humans can fade NOISE-driven spikes.
 *  3. Vega Sniper       — buys ATM straddles one beat before a flagged vol
 *     event, then violently dumps them on the volatility crush.
 *  4. Parity Arb        — enforces put–call parity, executing 3-leg trades to
 *     drain humans who misprice option spreads.
 *
 * Bots use synthetic (non-UUID) ids so persistence and the leaderboard ignore
 * them automatically.
 */
export class EdenBotEngine {
  private seq = Date.now();
  private readonly mmQuotes = new Map<string, BotQuote>();
  private readonly symbolCfg = new Map<string, SymbolConfig>();
  private momentum: MomentumState = { effects: [], ticksLeft: 0 };
  private readonly vega = new Map<string, VegaState>();
  private volatilityMultiplier = 1;
  private etfs: EtfConfig[] = [];

  constructor(
    private readonly engine: ChallengeEngine,
    private cfg: EdenBotConfig,
    symbols: SymbolConfig[],
  ) {
    for (const s of symbols) this.symbolCfg.set(s.symbol, s);
  }

  get enabled(): boolean {
    return (
      this.cfg.hftMarketMakers > 0 ||
      this.cfg.momentumTraders > 0 ||
      this.cfg.vegaSnipers > 0 ||
      this.cfg.parityArbers > 0 ||
      this.vega.size > 0
    );
  }

  setConfig(cfg: EdenBotConfig, now = Date.now()): CancelOrderCommand[] {
    this.cfg = cfg;
    const cancels: CancelOrderCommand[] = [];
    for (const [key, prev] of [...this.mmQuotes]) {
      const rank = Number(key.split(":")[2]);
      if (!Number.isInteger(rank) || rank < cfg.hftMarketMakers) continue;
      const botId = `bot:hft:${rank}`;
      const symbol = key.slice(botId.length + 1);
      if (prev.bidId)
        cancels.push({
          orderId: prev.bidId,
          userId: botId,
          symbol,
          side: "buy",
          ts: now,
        });
      if (prev.askId)
        cancels.push({
          orderId: prev.askId,
          userId: botId,
          symbol,
          side: "sell",
          ts: now,
        });
      this.mmQuotes.delete(key);
    }
    return cancels;
  }

  /** Call after manager restoration and cancellation of saved bot quotes. */
  restore(now: number): void {
    if (!Number.isFinite(now)) throw new Error("Invalid bot restore timestamp");
    const state = this.engine.exportState();
    this.seq = Math.max(this.seq, state.seq, Math.ceil(now));
    // Tombstones can outlive the quote that allocated an ID, even after clock rollback.
    for (const id of [
      ...state.cancelledIds,
      ...state.symbols.flatMap((s) => s.orders.map((order) => order.id)),
    ]) {
      if (!id.startsWith("bot:")) continue;
      const sequence = Number(id.slice(id.lastIndexOf(":") + 1));
      if (Number.isSafeInteger(sequence))
        this.seq = Math.max(this.seq, sequence);
    }
    this.mmQuotes.clear();
    this.momentum = { effects: [], ticksLeft: 0 };
    this.symbolCfg.clear();
    for (const symbol of state.symbols)
      this.symbolCfg.set(symbol.config.symbol, symbol.config);
    this.vega.clear();
    for (const id of this.engine.accountIds()) {
      const match = /^bot:vega:\d+:(\d+(?:\.\d+)?)$/.exec(id);
      if (!match) continue;
      const releaseAt = Number(match[1]);
      if (!Number.isFinite(releaseAt)) continue;
      const held = new Set<string>();
      const underlyings = new Set<string>();
      for (const position of this.engine.allPositions(id)) {
        const meta = this.engine.getOption(position.symbol);
        if (position.quantity <= 0 || !meta) continue;
        held.add(position.symbol);
        underlyings.add(meta.underlying);
      }
      if (held.size > 0)
        this.vega.set(id, {
          releaseAt,
          phase: now >= releaseAt ? "dump" : "accumulate",
          held,
          underlyings: [...underlyings],
        });
    }
  }

  /** Register a symbol introduced after startup so HFT MMs quote it too. */
  addSymbol(cfg: SymbolConfig): void {
    this.symbolCfg.set(cfg.symbol, cfg);
  }

  /** Replace the live ETF universe; merge repeated components before sizing. */
  setEtfs(etfs: EtfConfig[]): void {
    const seen = new Set<string>();
    const next = etfs.map((etf) => {
      if (!etf.symbol || seen.has(etf.symbol) || etf.basket.length === 0)
        throw new Error("Invalid ETF configuration");
      seen.add(etf.symbol);
      const weights = new Map<string, number>();
      for (const component of etf.basket) {
        const weight = (weights.get(component.symbol) ?? 0) + component.weight;
        if (
          !component.symbol ||
          component.symbol === etf.symbol ||
          !Number.isSafeInteger(component.weight) ||
          component.weight <= 0 ||
          !Number.isSafeInteger(weight)
        )
          throw new Error("Invalid ETF basket");
        weights.set(component.symbol, weight);
      }
      return {
        ...etf,
        basket: [...weights].map(([symbol, weight]) => ({ symbol, weight })),
      };
    });
    this.etfs = structuredClone(next);
  }

  setVolatilityMultiplier(multiplier: number): void {
    if (!Number.isFinite(multiplier) || multiplier <= 0)
      throw new Error("Invalid volatility multiplier");
    this.volatilityMultiplier = multiplier;
  }

  /** Parent passes its game-minute duration; repeated calls are idempotent. */
  prepareVolEvent(
    symbol: string,
    releaseAt: number,
    now: number,
    leadMs = 60_000,
  ): void {
    if (
      !Number.isFinite(releaseAt) ||
      !Number.isFinite(now) ||
      !Number.isFinite(leadMs) ||
      leadMs <= 0 ||
      now < releaseAt - leadMs ||
      now >= releaseAt
    )
      return;
    for (let i = 0; i < this.cfg.vegaSnipers; i++) {
      const id = `bot:vega:${i}:${releaseAt}`;
      const state = this.vega.get(id) ?? {
        underlyings: [],
        phase: "accumulate",
        releaseAt,
        held: new Set<string>(),
      };
      if (!state.underlyings.includes(symbol)) state.underlyings.push(symbol);
      this.vega.set(id, state);
    }
  }

  resolveVolEvent(symbol: string, now: number): void {
    for (const state of this.vega.values()) {
      if (state.underlyings.includes(symbol) && now >= state.releaseAt)
        state.phase = "dump";
    }
  }

  /** Feed a news pulse so momentum + vega bots react over the next few ticks. */
  onNewsPulse(effects: MomentumEffect[], volEvent: boolean): void {
    if (effects.length > 0) {
      this.momentum = { effects, ticksLeft: 4 };
    }
    if (volEvent) {
      for (const state of this.vega.values()) {
        if (Date.now() >= state.releaseAt) state.phase = "dump";
      }
    }
  }

  act(
    now: number,
    rng: () => number = Math.random,
  ): {
    places: PlaceOrderCommand[];
    cancels: CancelOrderCommand[];
    batches?: PlaceOrderCommand[][];
  } {
    const places: PlaceOrderCommand[] = [];
    const cancels: CancelOrderCommand[] = [];
    const batches: PlaceOrderCommand[][] = [];

    this.quoteMarketMakers(now, places, cancels);
    this.runMomentum(now, rng, places);
    this.runVega(now, places);
    this.runParity(now, rng, batches);
    this.runEtfArbitrage(now, rng, batches);

    if (this.momentum.ticksLeft > 0) this.momentum.ticksLeft -= 1;
    return { places, cancels, batches };
  }

  /* ---- 1. HFT market makers ---- */
  private quoteMarketMakers(
    now: number,
    places: PlaceOrderCommand[],
    cancels: CancelOrderCommand[],
  ): void {
    const spot = this.engine
      .symbols()
      .filter(
        (s) => !this.engine.getOption(s) && this.engine.isSymbolOpen(s, now),
      );
    const optionSyms = this.engine.optionSymbols();
    for (let i = 0; i < this.cfg.hftMarketMakers; i++) {
      const botId = `bot:hft:${i}`;
      for (const symbol of spot)
        this.quoteSpot(botId, i, symbol, now, places, cancels);
      for (const symbol of optionSyms)
        this.quoteOption(botId, i, symbol, now, places, cancels);
    }
  }

  private quoteSpot(
    botId: string,
    rank: number,
    symbol: string,
    now: number,
    places: PlaceOrderCommand[],
    cancels: CancelOrderCommand[],
  ): void {
    const cfg = this.symbolCfg.get(symbol) ?? { tickSize: 0.1 };
    const theo =
      this.engine.getFairValue(symbol) ?? this.engine.getPrice(symbol);
    if (theo === undefined) return;
    this.placeTwoSided(
      botId,
      rank,
      symbol,
      theo,
      cfg.tickSize,
      now,
      places,
      cancels,
    );
  }

  private quoteOption(
    botId: string,
    rank: number,
    symbol: string,
    now: number,
    places: PlaceOrderCommand[],
    cancels: CancelOrderCommand[],
  ): void {
    const meta = this.engine.getOption(symbol);
    if (!meta || !this.engine.isSymbolOpen(symbol, now)) return;
    const underFv =
      this.engine.getFairValue(meta.underlying) ??
      this.engine.getPrice(meta.underlying) ??
      0;
    const vol = this.symbolCfg.get(meta.underlying)?.volatility ?? 1;
    const span = Math.max(1, meta.expiresAt - meta.openedAt);
    const fractionLeft = Math.max(
      0,
      Math.min(1, (meta.expiresAt - now) / span),
    );
    const theo = theoreticalOption(
      meta.optionType,
      underFv,
      meta.strike,
      vol * this.volatilityMultiplier,
      fractionLeft,
    );
    this.placeTwoSided(
      botId,
      rank,
      symbol,
      Math.max(0.1, theo),
      0.1,
      now,
      places,
      cancels,
    );
  }

  /** Cancel & replace a bot's two-sided quote, skewed/widened by inventory. */
  private placeTwoSided(
    botId: string,
    rank: number,
    symbol: string,
    theo: number,
    tick: number,
    now: number,
    places: PlaceOrderCommand[],
    cancels: CancelOrderCommand[],
  ): void {
    const inv = this.engine.positionOf(botId, symbol);
    const base = Math.max(
      tick,
      this.cfg.spread * this.volatilityMultiplier + rank * tick,
    );
    // Widen proportionally to absolute inventory; skew the mid against it.
    const widening = (base * Math.abs(inv)) / Math.max(1, this.cfg.quoteSize);
    const half = base + widening;
    // Shift more than the widening so BOTH prices rise when short.
    const skew = -Math.sign(inv) * (widening + Math.abs(inv) * tick * 0.5);
    const center = Math.max(tick, theo + skew);
    const bidPrice = round(Math.max(tick, center - half), tick);
    const askPrice = Math.max(bidPrice + tick, round(center + half, tick));

    const key = `${botId}:${symbol}`;
    const prev = this.mmQuotes.get(key);
    if (prev?.bidId)
      cancels.push({
        orderId: prev.bidId,
        userId: botId,
        symbol,
        side: "buy",
        ts: now,
      });
    if (prev?.askId)
      cancels.push({
        orderId: prev.askId,
        userId: botId,
        symbol,
        side: "sell",
        ts: now,
      });

    const bidId = `${botId}:${symbol}:b:${++this.seq}`;
    const askId = `${botId}:${symbol}:a:${++this.seq}`;
    places.push({
      orderId: bidId,
      userId: botId,
      symbol,
      side: "buy",
      orderType: "limit",
      quantity: this.cfg.quoteSize,
      price: bidPrice,
      ts: now,
    });
    places.push({
      orderId: askId,
      userId: botId,
      symbol,
      side: "sell",
      orderType: "limit",
      quantity: this.cfg.quoteSize,
      price: askPrice,
      ts: now,
    });
    this.mmQuotes.set(key, { bidId, askId });
  }

  /* ---- 2. Retail / momentum ---- */
  private runMomentum(
    now: number,
    rng: () => number,
    places: PlaceOrderCommand[],
  ): void {
    if (this.momentum.ticksLeft <= 0 || this.momentum.effects.length === 0)
      return;
    for (let i = 0; i < this.cfg.momentumTraders; i++) {
      if (rng() > this.cfg.intensity) continue;
      const eff =
        this.momentum.effects[Math.floor(rng() * this.momentum.effects.length)];
      if (!eff || eff.sentiment === 0) continue;
      const side: OrderSide = eff.sentiment > 0 ? "buy" : "sell";
      const size = Math.max(
        1,
        Math.round(
          this.cfg.quoteSize * Math.abs(eff.sentiment) * (0.5 + rng()),
        ),
      );
      places.push({
        orderId: `bot:mom:${i}:${++this.seq}`,
        userId: `bot:mom:${i}`,
        symbol: eff.symbol,
        side,
        orderType: "market",
        quantity: size,
        price: null,
        ts: now,
      });
      if (eff.sentiment > 0) {
        const call = this.nearestStraddle(
          eff.symbol,
          this.engine.getPrice(eff.symbol) ?? 0,
          now,
        )[0];
        if (call)
          places.push({
            orderId: `bot:mom:${i}:${++this.seq}`,
            userId: `bot:mom:${i}`,
            symbol: call,
            side: "buy",
            orderType: "market",
            quantity: size,
            price: null,
            ts: now,
          });
      }
    }
  }

  /* ---- 3. Vega snipers ---- */
  private runVega(now: number, places: PlaceOrderCommand[]): void {
    for (const [botId, state] of this.vega) {
      if (now >= state.releaseAt) state.phase = "dump";
      if (state.phase === "accumulate") {
        for (const under of state.underlyings) {
          const spot =
            this.engine.getFairValue(under) ?? this.engine.getPrice(under) ?? 0;
          const straddle = this.nearestStraddle(
            under,
            spot,
            now,
            state.releaseAt,
          );
          for (const sym of straddle) {
            state.held.add(sym);
            places.push({
              orderId: `${botId}:${++this.seq}`,
              userId: botId,
              symbol: sym,
              side: "buy",
              orderType: "market",
              quantity: Math.max(1, Math.round(this.cfg.quoteSize / 2)),
              price: null,
              ts: now,
            });
          }
        }
      } else {
        // Volatility crush: dump everything we picked up.
        let pending = false;
        for (const sym of state.held) {
          const pos = this.engine.positionOf(botId, sym);
          if (pos > 0 && this.engine.isSymbolOpen(sym, now)) {
            pending = true;
            places.push({
              orderId: `${botId}:${++this.seq}`,
              userId: botId,
              symbol: sym,
              side: "sell",
              orderType: "market",
              quantity: pos,
              price: null,
              ts: now,
            });
          }
        }
        if (!pending) this.vega.delete(botId);
      }
    }
  }

  /** The nearest call+put option symbols to spot for an underlying. */
  private nearestStraddle(
    underlying: string,
    spot: number,
    now: number,
    validThrough = now,
  ): string[] {
    const metas = this.engine
      .optionMetas()
      .filter(
        (m) =>
          m.underlying === underlying &&
          m.expiresAt > validThrough &&
          this.engine.isSymbolOpen(m.symbol, now),
      );
    const calls = metas
      .filter((m) => m.optionType === "call")
      .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
    for (const call of calls) {
      const put = metas.find(
        (m) =>
          m.optionType === "put" &&
          m.cycleId === call.cycleId &&
          m.strike === call.strike,
      );
      if (put) return [call.symbol, put.symbol];
    }
    return [];
  }

  /* ---- 4. Parity arbitrage ---- */
  private runParity(
    now: number,
    rng: () => number,
    batches: PlaceOrderCommand[][],
  ): void {
    if (this.cfg.parityArbers <= 0) return;
    const { config } = this.engine.exportState();
    const planned = new Map<string, number>();
    // Group option metas by underlying+strike to find call/put pairs.
    const pairs = new Map<
      string,
      { call?: string; put?: string; strike: number; underlying: string }
    >();
    for (const m of this.engine.optionMetas()) {
      if (!this.engine.isSymbolOpen(m.symbol, now)) continue;
      const key = `${m.cycleId}:${m.underlying}:${m.strike}`;
      const e = pairs.get(key) ?? {
        strike: m.strike,
        underlying: m.underlying,
      };
      if (m.optionType === "call") e.call = m.symbol;
      else e.put = m.symbol;
      pairs.set(key, e);
    }
    for (let i = 0; i < this.cfg.parityArbers; i++) {
      if (rng() > this.cfg.intensity) continue;
      const botId = `bot:parity:${i}`;
      for (const p of pairs.values()) {
        if (!p.call || !p.put || !this.engine.isSymbolOpen(p.underlying, now))
          continue;
        const call = this.engine.snapshot(p.call, 1);
        const put = this.engine.snapshot(p.put, 1);
        const stock = this.engine.snapshot(p.underlying, 1);
        const rich =
          call.bids[0] &&
          put.asks[0] &&
          stock.asks[0] &&
          call.bids[0].price -
            put.asks[0].price -
            stock.asks[0].price +
            p.strike >
            2;
        const cheap =
          call.asks[0] &&
          put.bids[0] &&
          stock.bids[0] &&
          put.bids[0].price +
            stock.bids[0].price -
            call.asks[0].price -
            p.strike >
            2;
        if (!rich && !cheap) continue;
        const legs = rich
          ? [
              { symbol: p.call, side: "sell" as const, level: call.bids[0]! },
              { symbol: p.put, side: "buy" as const, level: put.asks[0]! },
              {
                symbol: p.underlying,
                side: "buy" as const,
                level: stock.asks[0]!,
              },
            ]
          : [
              { symbol: p.call, side: "buy" as const, level: call.asks[0]! },
              { symbol: p.put, side: "sell" as const, level: put.bids[0]! },
              {
                symbol: p.underlying,
                side: "sell" as const,
                level: stock.bids[0]!,
              },
            ];
        const qty = Math.floor(
          Math.min(
            Math.max(1, Math.round(this.cfg.quoteSize / 3)),
            ...legs.map((leg) => leg.level.quantity),
            ...legs.map((leg) => {
              const position = this.engine.positionOf(botId, leg.symbol);
              const room =
                leg.side === "buy"
                  ? config.maxPosition - position
                  : position - config.minPosition;
              return (
                room -
                this.engine.openOrderQuantity(botId, leg.symbol, leg.side) -
                (planned.get(`${botId}:${leg.symbol}:${leg.side}`) ?? 0)
              );
            }),
          ),
        );
        if (qty <= 0) continue;
        // The runner must submit the whole batch through placeAtomicOrders.
        const batch: PlaceOrderCommand[] = [];
        for (const leg of legs) {
          const key = `${botId}:${leg.symbol}:${leg.side}`;
          planned.set(key, (planned.get(key) ?? 0) + qty);
          batch.push({
            orderId: `${botId}:${++this.seq}`,
            userId: botId,
            symbol: leg.symbol,
            side: leg.side,
            orderType: "limit",
            timeInForce: "IOC",
            quantity: qty,
            price: leg.level.price,
            ts: now,
          });
        }
        batches.push(batch);
      }
    }
  }

  /** Trade ETF/basket dislocations at executable, price-bounded levels. */
  private runEtfArbitrage(
    now: number,
    rng: () => number,
    batches: PlaceOrderCommand[][],
  ): void {
    if (this.cfg.parityArbers <= 0 || this.etfs.length === 0) return;
    const state = this.engine.exportState();
    const ticks = new Map(
      state.symbols.map((s) => [s.config.symbol, s.config.tickSize]),
    );
    const planned = new Map<string, number>();
    for (let i = 0; i < this.cfg.parityArbers; i++) {
      if (rng() > this.cfg.intensity) continue;
      const botId = `bot:etf:${i}`;
      for (const etf of this.etfs) {
        if (
          ![etf.symbol, ...etf.basket.map((c) => c.symbol)].every((symbol) =>
            this.engine.isSymbolOpen(symbol, now),
          )
        )
          continue;
        const book = this.engine.snapshot(etf.symbol, 1);
        const components = etf.basket.map((c) => ({
          ...c,
          book: this.engine.snapshot(c.symbol, 1),
        }));
        const threshold = ticks.get(etf.symbol) ?? 0.1;
        const rich =
          book.bids[0] &&
          components.every((c) => c.book.asks[0]) &&
          book.bids[0].price -
            components.reduce(
              (sum, c) => sum + c.weight * c.book.asks[0]!.price,
              0,
            ) >
            threshold;
        const cheap =
          book.asks[0] &&
          components.every((c) => c.book.bids[0]) &&
          components.reduce(
            (sum, c) => sum + c.weight * c.book.bids[0]!.price,
            0,
          ) -
            book.asks[0].price >
            threshold;
        if (!rich && !cheap) continue;
        const legs = [
          {
            symbol: etf.symbol,
            weight: 1,
            side: rich ? ("sell" as const) : ("buy" as const),
            level: rich ? book.bids[0]! : book.asks[0]!,
          },
          ...components.map((c) => ({
            symbol: c.symbol,
            weight: c.weight,
            side: rich ? ("buy" as const) : ("sell" as const),
            level: rich ? c.book.asks[0]! : c.book.bids[0]!,
          })),
        ];
        const quantity = Math.floor(
          Math.min(
            this.cfg.quoteSize,
            ...legs.map((leg) => {
              const position = this.engine.positionOf(botId, leg.symbol);
              const room =
                leg.side === "buy"
                  ? state.config.maxPosition - position
                  : position - state.config.minPosition;
              const working = this.engine.openOrderQuantity(
                botId,
                leg.symbol,
                leg.side,
              );
              const reserved =
                planned.get(`${botId}:${leg.symbol}:${leg.side}`) ?? 0;
              return (
                Math.min(leg.level.quantity, room - working - reserved) /
                leg.weight
              );
            }),
          ),
        );
        if (quantity <= 0) continue;
        const batch: PlaceOrderCommand[] = [];
        for (const leg of legs) {
          const size = quantity * leg.weight;
          const key = `${botId}:${leg.symbol}:${leg.side}`;
          planned.set(key, (planned.get(key) ?? 0) + size);
          batch.push({
            orderId: `${botId}:${++this.seq}`,
            userId: botId,
            symbol: leg.symbol,
            side: leg.side,
            orderType: "limit",
            timeInForce: "IOC",
            quantity: size,
            price: leg.level.price,
            ts: now,
          });
        }
        batches.push(batch);
      }
    }
  }
}

function round(price: number, tick: number): number {
  return Math.round(price / tick) * tick;
}
