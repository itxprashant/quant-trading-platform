import type {
  CancelOrderCommand,
  ChallengeEngine,
  PlaceOrderCommand,
} from "@qtp/core";
import type { BotConfig, OrderSide, SymbolConfig } from "@qtp/shared";

interface BotQuote {
  bidId?: string;
  askId?: string;
}

/**
 * Autonomous agents that trade alongside humans through the same matching
 * engine. They use synthetic (non-UUID) user ids so persistence and the
 * leaderboard automatically ignore them.
 *
 *  - Market-maker bots rest two-sided quotes around mid to provide liquidity.
 *  - Noise-trader bots send occasional market orders to take liquidity, which
 *    creates realistic flow and lets human market makers capture spread.
 */
export class BotEngine {
  private seq = 0;
  private readonly mmQuotes = new Map<string, BotQuote>();
  private readonly symbolCfg = new Map<string, SymbolConfig>();

  constructor(
    private readonly engine: ChallengeEngine,
    private readonly cfg: BotConfig,
    symbols: SymbolConfig[],
  ) {
    for (const s of symbols) this.symbolCfg.set(s.symbol, s);
  }

  get enabled(): boolean {
    return this.cfg.marketMakers > 0 || this.cfg.noiseTraders > 0;
  }

  /** Generate the commands for one bot tick. Pure w.r.t. external state. */
  act(
    now: number,
    rng: () => number = Math.random,
  ): { places: PlaceOrderCommand[]; cancels: CancelOrderCommand[] } {
    const places: PlaceOrderCommand[] = [];
    const cancels: CancelOrderCommand[] = [];
    const symbols = this.engine.symbols();

    // Market makers: cancel & replace two-sided quotes each tick so liquidity
    // continuously follows the price and refills after being hit.
    for (let i = 0; i < this.cfg.marketMakers; i++) {
      const botId = `bot:mm:${i}`;
      for (const symbol of symbols) {
        const cfg = this.symbolCfg.get(symbol);
        const mid = this.engine.getPrice(symbol);
        if (!cfg || mid === undefined) continue;

        const tick = cfg.tickSize;
        const offset = this.cfg.spread + i * tick; // stagger bots for depth
        const bidPrice = round(Math.max(tick, mid - offset), tick);
        const askPrice = round(mid + offset, tick);

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

        const bidId = `bot:mm:${i}:${symbol}:b:${++this.seq}`;
        const askId = `bot:mm:${i}:${symbol}:a:${++this.seq}`;
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
    }

    // Noise traders: probabilistic market orders gated by intensity.
    for (let i = 0; i < this.cfg.noiseTraders; i++) {
      if (rng() > this.cfg.intensity) continue;
      const symbol = symbols[Math.floor(rng() * symbols.length)];
      if (!symbol) continue;
      const side: OrderSide = rng() > 0.5 ? "buy" : "sell";
      const size = 1 + Math.floor(rng() * Math.max(1, this.cfg.quoteSize));
      places.push({
        orderId: `bot:noise:${i}:${++this.seq}`,
        userId: `bot:noise:${i}`,
        symbol,
        side,
        orderType: "market",
        quantity: size,
        price: null,
        ts: now,
      });
    }

    return { places, cancels };
  }
}

function round(price: number, tick: number): number {
  return Math.round(price / tick) * tick;
}
