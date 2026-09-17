import type { OrderSide } from "@qtp/shared";

export interface RestingOrder {
  id: string;
  userId: string;
  side: OrderSide;
  price: number;
  remaining: number;
  /** Monotonic sequence for price-time priority tie-breaking. */
  seq: number;
}

export interface BookLevel {
  price: number;
  quantity: number;
  orders: number;
}

/**
 * A single-symbol limit order book with strict price-time priority.
 *
 * Bids are kept best (highest) first; asks best (lowest) first. Each price
 * level holds a FIFO queue. All mutation happens on the engine's single
 * writer thread, so no locking is required.
 */
export class OrderBook {
  /** price -> FIFO queue of resting orders. */
  private readonly bidLevels = new Map<number, RestingOrder[]>();
  private readonly askLevels = new Map<number, RestingOrder[]>();
  /** Sorted price arrays kept in priority order. */
  private bidPrices: number[] = []; // descending
  private askPrices: number[] = []; // ascending
  private readonly index = new Map<string, RestingOrder>();

  bestBid(): number | undefined {
    return this.bidPrices[0];
  }

  bestAsk(): number | undefined {
    return this.askPrices[0];
  }

  has(orderId: string): boolean {
    return this.index.has(orderId);
  }

  getOwner(orderId: string): string | undefined {
    return this.index.get(orderId)?.userId;
  }

  /** Insert an order as resting liquidity. */
  add(order: RestingOrder): void {
    const levels = order.side === "buy" ? this.bidLevels : this.askLevels;
    const queue = levels.get(order.price);
    if (queue) {
      queue.push(order);
    } else {
      levels.set(order.price, [order]);
      this.insertPrice(order.side, order.price);
    }
    this.index.set(order.id, order);
  }

  /** Remove an order by id. Returns the removed order if present. */
  remove(orderId: string): RestingOrder | undefined {
    const order = this.index.get(orderId);
    if (!order) return undefined;
    const levels = order.side === "buy" ? this.bidLevels : this.askLevels;
    const queue = levels.get(order.price);
    if (queue) {
      const idx = queue.findIndex((o) => o.id === orderId);
      if (idx >= 0) queue.splice(idx, 1);
      if (queue.length === 0) {
        levels.delete(order.price);
        this.removePrice(order.side, order.price);
      }
    }
    this.index.delete(orderId);
    return order;
  }

  /** Peek at the best resting order on a side without removing it. */
  peekBest(side: OrderSide): RestingOrder | undefined {
    const price =
      side === "buy" ? this.bidPrices[0] : this.askPrices[0];
    if (price === undefined) return undefined;
    const levels = side === "buy" ? this.bidLevels : this.askLevels;
    return levels.get(price)?.[0];
  }

  /** Reduce the best resting order's quantity; remove it if fully consumed. */
  reduceBest(side: OrderSide, qty: number): void {
    const best = this.peekBest(side);
    if (!best) return;
    best.remaining -= qty;
    if (best.remaining <= 0) {
      this.remove(best.id);
    }
  }

  /** Best resting bid/ask price and total size per user (for MM uptime). */
  quotesByUser(): Map<
    string,
    { bid?: number; bidQty: number; ask?: number; askQty: number }
  > {
    const out = new Map<
      string,
      { bid?: number; bidQty: number; ask?: number; askQty: number }
    >();
    for (const o of this.index.values()) {
      const e = out.get(o.userId) ?? { bidQty: 0, askQty: 0 };
      if (o.side === "buy") {
        if (e.bid === undefined || o.price > e.bid) e.bid = o.price;
        e.bidQty += o.remaining;
      } else {
        if (e.ask === undefined || o.price < e.ask) e.ask = o.price;
        e.askQty += o.remaining;
      }
      out.set(o.userId, e);
    }
    return out;
  }

  snapshot(depth = 10): { bids: BookLevel[]; asks: BookLevel[] } {
    return {
      bids: this.aggregate("buy", depth),
      asks: this.aggregate("sell", depth),
    };
  }

  private aggregate(side: OrderSide, depth: number): BookLevel[] {
    const prices = side === "buy" ? this.bidPrices : this.askPrices;
    const levels = side === "buy" ? this.bidLevels : this.askLevels;
    const out: BookLevel[] = [];
    for (let i = 0; i < prices.length && out.length < depth; i++) {
      const price = prices[i]!;
      const queue = levels.get(price);
      if (!queue || queue.length === 0) continue;
      let quantity = 0;
      for (const o of queue) quantity += o.remaining;
      out.push({ price, quantity, orders: queue.length });
    }
    return out;
  }

  private insertPrice(side: OrderSide, price: number): void {
    if (side === "buy") {
      const i = lowerBound(this.bidPrices, price, (a, b) => b - a);
      this.bidPrices.splice(i, 0, price);
    } else {
      const i = lowerBound(this.askPrices, price, (a, b) => a - b);
      this.askPrices.splice(i, 0, price);
    }
  }

  private removePrice(side: OrderSide, price: number): void {
    const arr = side === "buy" ? this.bidPrices : this.askPrices;
    const i = arr.indexOf(price);
    if (i >= 0) arr.splice(i, 1);
  }
}

/** First index where cmp(arr[i], value) >= 0, for a sorted array. */
function lowerBound(
  arr: number[],
  value: number,
  cmp: (a: number, b: number) => number,
): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmp(arr[mid]!, value) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
