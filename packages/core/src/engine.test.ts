import { describe, expect, it } from "vitest";
import { ChallengeEngine, type EngineConfig } from "./engine.js";
import type { TradeEvent } from "@qtp/shared";

function makeEngine(overrides: Partial<EngineConfig> = {}) {
  return new ChallengeEngine({
    challengeId: "c1",
    symbols: [
      { symbol: "X1", initialPrice: 100, volatility: 0.5, tickSize: 0.01 },
    ],
    startingCash: 0,
    minPosition: -50,
    maxPosition: 50,
    maxOrderQuantity: 50,
    allowMargin: true,
    ...overrides,
  });
}

const trades = (evts: ReturnType<ChallengeEngine["placeOrder"]>) =>
  evts.filter((e): e is TradeEvent => e.type === "trade");

describe("ChallengeEngine matching", () => {
  it("rests a limit order with no opposing liquidity", () => {
    const e = makeEngine();
    const evts = e.placeOrder({
      orderId: "o1",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 10,
      price: 99,
      ts: 1,
    });
    expect(trades(evts)).toHaveLength(0);
    const snap = e.snapshot("X1");
    expect(snap.bids[0]).toMatchObject({ price: 99, quantity: 10, orders: 1 });
  });

  it("matches a crossing order at the maker price (price-time priority)", () => {
    const e = makeEngine();
    e.placeOrder({
      orderId: "o1",
      userId: "alice",
      symbol: "X1",
      side: "sell",
      orderType: "limit",
      quantity: 10,
      price: 101,
      ts: 1,
    });
    const evts = e.placeOrder({
      orderId: "o2",
      userId: "bob",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 6,
      price: 102,
      ts: 2,
    });
    const t = trades(evts);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ price: 101, quantity: 6, buyerId: "bob", sellerId: "alice" });

    // Buyer paid, seller received, at maker price 101.
    expect(e.portfolioOf("bob").cash).toBe(-606);
    expect(e.portfolioOf("alice").cash).toBe(606);
    expect(e.portfolioOf("bob").positions[0]).toMatchObject({ quantity: 6 });
    expect(e.portfolioOf("alice").positions[0]).toMatchObject({ quantity: -6 });
    // 4 left resting on the ask.
    expect(e.snapshot("X1").asks[0]).toMatchObject({ price: 101, quantity: 4 });
  });

  it("respects FIFO across two makers at the same price", () => {
    const e = makeEngine();
    e.placeOrder({ orderId: "a", userId: "m1", symbol: "X1", side: "sell", orderType: "limit", quantity: 5, price: 100, ts: 1 });
    e.placeOrder({ orderId: "b", userId: "m2", symbol: "X1", side: "sell", orderType: "limit", quantity: 5, price: 100, ts: 2 });
    const evts = e.placeOrder({ orderId: "c", userId: "taker", symbol: "X1", side: "buy", orderType: "limit", quantity: 7, price: 100, ts: 3 });
    const t = trades(evts);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ sellOrderId: "a", quantity: 5 });
    expect(t[1]).toMatchObject({ sellOrderId: "b", quantity: 2 });
  });

  it("enforces max position limits, capping fills", () => {
    const e = makeEngine({ maxPosition: 10 });
    // Plenty of liquidity to sell into.
    e.placeOrder({ orderId: "s", userId: "mm", symbol: "X1", side: "sell", orderType: "limit", quantity: 50, price: 100, ts: 1 });
    const evts = e.placeOrder({ orderId: "b", userId: "buyer", symbol: "X1", side: "buy", orderType: "limit", quantity: 50, price: 100, ts: 2 });
    const filled = trades(evts).reduce((s, t) => s + t.quantity, 0);
    expect(filled).toBe(10); // capped at max position
    expect(e.portfolioOf("buyer").positions[0]).toMatchObject({ quantity: 10 });
  });

  it("cancels a resting order and removes it from the book", () => {
    const e = makeEngine();
    e.placeOrder({ orderId: "o1", userId: "alice", symbol: "X1", side: "buy", orderType: "limit", quantity: 10, price: 99, ts: 1 });
    const evts = e.cancelOrder({ orderId: "o1", userId: "alice", ts: 2 });
    expect(evts.some((x) => x.type === "order_update" && x.status === "cancelled")).toBe(true);
    expect(e.snapshot("X1").bids).toHaveLength(0);
  });

  it("ignores cancel from a non-owner", () => {
    const e = makeEngine();
    e.placeOrder({ orderId: "o1", userId: "alice", symbol: "X1", side: "buy", orderType: "limit", quantity: 10, price: 99, ts: 1 });
    const evts = e.cancelOrder({ orderId: "o1", userId: "mallory", ts: 2 });
    expect(evts).toHaveLength(0);
    expect(e.snapshot("X1").bids[0]).toMatchObject({ quantity: 10 });
  });

  it("PnL is conserved between counterparties before price moves", () => {
    const e = makeEngine();
    e.placeOrder({ orderId: "s", userId: "alice", symbol: "X1", side: "sell", orderType: "limit", quantity: 10, price: 100, ts: 1 });
    e.placeOrder({ orderId: "b", userId: "bob", symbol: "X1", side: "buy", orderType: "limit", quantity: 10, price: 100, ts: 2 });
    // Mark both to the same current price; total PnL nets to zero.
    const total = e.portfolioOf("alice").pnl + e.portfolioOf("bob").pnl;
    expect(Math.abs(total)).toBeLessThan(1e-9);
  });
});
