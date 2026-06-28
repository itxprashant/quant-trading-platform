import {
  parityResidual,
  theoreticalOption,
  type ChallengeEngine,
  type CancelOrderCommand,
  type PlaceOrderCommand,
} from "@qtp/core";
import type {
  EdenBotConfig,
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
  ticksLeft: number;
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
  private seq = 0;
  private readonly mmQuotes = new Map<string, BotQuote>();
  private readonly symbolCfg = new Map<string, SymbolConfig>();
  private momentum: MomentumState = { effects: [], ticksLeft: 0 };
  private readonly vega = new Map<string, VegaState>();

  constructor(
    private readonly engine: ChallengeEngine,
    private readonly cfg: EdenBotConfig,
    symbols: SymbolConfig[],
  ) {
    for (const s of symbols) this.symbolCfg.set(s.symbol, s);
  }

  get enabled(): boolean {
    return (
      this.cfg.hftMarketMakers > 0 ||
      this.cfg.momentumTraders > 0 ||
      this.cfg.vegaSnipers > 0 ||
      this.cfg.parityArbers > 0
    );
  }

  /** Feed a news pulse so momentum + vega bots react over the next few ticks. */
  onNewsPulse(effects: MomentumEffect[], volEvent: boolean): void {
    if (effects.length > 0) {
      this.momentum = { effects, ticksLeft: 4 };
    }
    if (volEvent && this.cfg.vegaSnipers > 0) {
      const underlyings = effects.length
        ? effects.map((e) => e.symbol)
        : this.engine.autonomousSymbols();
      for (let i = 0; i < this.cfg.vegaSnipers; i++) {
        this.vega.set(`bot:vega:${i}`, {
          underlyings,
          phase: "accumulate",
          ticksLeft: 2,
          held: new Set(),
        });
      }
    }
  }

  act(
    now: number,
    rng: () => number = Math.random,
  ): { places: PlaceOrderCommand[]; cancels: CancelOrderCommand[] } {
    const places: PlaceOrderCommand[] = [];
    const cancels: CancelOrderCommand[] = [];

    this.quoteMarketMakers(now, places, cancels);
    this.runMomentum(now, rng, places);
    this.runVega(now, places);
    this.runParity(now, rng, places);

    if (this.momentum.ticksLeft > 0) this.momentum.ticksLeft -= 1;
    return { places, cancels };
  }

  /* ---- 1. HFT market makers ---- */
  private quoteMarketMakers(
    now: number,
    places: PlaceOrderCommand[],
    cancels: CancelOrderCommand[],
  ): void {
    const spot = this.engine.autonomousSymbols();
    const optionSyms = this.engine.optionSymbols();
    for (let i = 0; i < this.cfg.hftMarketMakers; i++) {
      const botId = `bot:hft:${i}`;
      for (const symbol of spot) this.quoteSpot(botId, i, symbol, now, places, cancels);
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
    const cfg = this.symbolCfg.get(symbol);
    if (!cfg) return;
    const theo = this.engine.getFairValue(symbol) ?? this.engine.getPrice(symbol);
    if (theo === undefined) return;
    this.placeTwoSided(botId, rank, symbol, theo, cfg.tickSize, now, places, cancels);
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
    if (!meta) return;
    const underFv =
      this.engine.getFairValue(meta.underlying) ??
      this.engine.getPrice(meta.underlying) ??
      0;
    const vol = this.symbolCfg.get(meta.underlying)?.volatility ?? 1;
    const span = Math.max(1, meta.expiresAt - meta.openedAt);
    const fractionLeft = Math.max(0, Math.min(1, (meta.expiresAt - now) / span));
    const theo = theoreticalOption(
      meta.optionType,
      underFv,
      meta.strike,
      vol,
      fractionLeft,
    );
    this.placeTwoSided(botId, rank, symbol, Math.max(0.1, theo), 0.1, now, places, cancels);
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
    const base = this.cfg.spread + rank * tick;
    // Widen proportionally to absolute inventory; skew the mid against it.
    const half = base * (1 + Math.abs(inv) / Math.max(1, this.cfg.quoteSize));
    const skew = -inv * tick * 0.5;
    const center = Math.max(tick, theo + skew);
    const bidPrice = round(Math.max(tick, center - half), tick);
    const askPrice = round(center + half, tick);

    const key = `${botId}:${symbol}`;
    const prev = this.mmQuotes.get(key);
    if (prev?.bidId)
      cancels.push({ orderId: prev.bidId, userId: botId, symbol, side: "buy", ts: now });
    if (prev?.askId)
      cancels.push({ orderId: prev.askId, userId: botId, symbol, side: "sell", ts: now });

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
    if (this.momentum.ticksLeft <= 0 || this.momentum.effects.length === 0) return;
    for (let i = 0; i < this.cfg.momentumTraders; i++) {
      if (rng() > this.cfg.intensity) continue;
      const eff =
        this.momentum.effects[Math.floor(rng() * this.momentum.effects.length)];
      if (!eff || eff.sentiment === 0) continue;
      const side: OrderSide = eff.sentiment > 0 ? "buy" : "sell";
      const size = Math.max(
        1,
        Math.round(this.cfg.quoteSize * Math.abs(eff.sentiment) * (0.5 + rng())),
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
    }
  }

  /* ---- 3. Vega snipers ---- */
  private runVega(now: number, places: PlaceOrderCommand[]): void {
    for (const [botId, state] of this.vega) {
      if (state.phase === "accumulate") {
        for (const under of state.underlyings) {
          const spot =
            this.engine.getFairValue(under) ?? this.engine.getPrice(under) ?? 0;
          const straddle = this.nearestStraddle(under, spot);
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
        state.ticksLeft -= 1;
        if (state.ticksLeft <= 0) {
          state.phase = "dump";
          state.ticksLeft = 1;
        }
      } else {
        // Volatility crush: dump everything we picked up.
        for (const sym of state.held) {
          const pos = this.engine.positionOf(botId, sym);
          if (pos > 0) {
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
        this.vega.delete(botId);
      }
    }
  }

  /** The nearest call+put option symbols to spot for an underlying. */
  private nearestStraddle(underlying: string, spot: number): string[] {
    let bestCall: { sym: string; d: number } | undefined;
    let bestPut: { sym: string; d: number } | undefined;
    for (const m of this.engine.optionMetas()) {
      if (m.underlying !== underlying) continue;
      const d = Math.abs(m.strike - spot);
      if (m.optionType === "call" && (!bestCall || d < bestCall.d))
        bestCall = { sym: m.symbol, d };
      if (m.optionType === "put" && (!bestPut || d < bestPut.d))
        bestPut = { sym: m.symbol, d };
    }
    const out: string[] = [];
    if (bestCall) out.push(bestCall.sym);
    if (bestPut) out.push(bestPut.sym);
    return out;
  }

  /* ---- 4. Parity arbitrage ---- */
  private runParity(
    now: number,
    rng: () => number,
    places: PlaceOrderCommand[],
  ): void {
    if (this.cfg.parityArbers <= 0) return;
    // Group option metas by underlying+strike to find call/put pairs.
    const pairs = new Map<string, { call?: string; put?: string; strike: number; underlying: string }>();
    for (const m of this.engine.optionMetas()) {
      const key = `${m.underlying}:${m.strike}`;
      const e = pairs.get(key) ?? { strike: m.strike, underlying: m.underlying };
      if (m.optionType === "call") e.call = m.symbol;
      else e.put = m.symbol;
      pairs.set(key, e);
    }
    for (let i = 0; i < this.cfg.parityArbers; i++) {
      if (rng() > this.cfg.intensity) continue;
      const botId = `bot:parity:${i}`;
      for (const p of pairs.values()) {
        if (!p.call || !p.put) continue;
        const callMid = this.midOf(p.call);
        const putMid = this.midOf(p.put);
        const spot =
          this.engine.getFairValue(p.underlying) ??
          this.engine.getPrice(p.underlying);
        if (callMid === undefined || putMid === undefined || spot === undefined)
          continue;
        const residual = parityResidual(callMid, putMid, spot, p.strike);
        if (Math.abs(residual) < 2) continue;
        const qty = Math.max(1, Math.round(this.cfg.quoteSize / 3));
        // residual > 0 ⇒ call rich: sell call, buy put, buy stock.
        const callSide: OrderSide = residual > 0 ? "sell" : "buy";
        const putSide: OrderSide = residual > 0 ? "buy" : "sell";
        const stockSide: OrderSide = residual > 0 ? "buy" : "sell";
        for (const [sym, side] of [
          [p.call, callSide],
          [p.put, putSide],
          [p.underlying, stockSide],
        ] as Array<[string, OrderSide]>) {
          places.push({
            orderId: `${botId}:${++this.seq}`,
            userId: botId,
            symbol: sym,
            side,
            orderType: "market",
            quantity: qty,
            price: null,
            ts: now,
          });
        }
      }
    }
  }

  private midOf(symbol: string): number | undefined {
    const { bid, ask } = this.engine.bestBidAsk(symbol);
    if (bid !== undefined && ask !== undefined) return (bid + ask) / 2;
    return this.engine.getPrice(symbol);
  }
}

function round(price: number, tick: number): number {
  return Math.round(price / tick) * tick;
}
