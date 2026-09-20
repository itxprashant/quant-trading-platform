import { describe, expect, it } from "vitest";
import {
  ChallengeEngine,
  clampOrderQuantity,
  type EngineConfig,
} from "./engine.js";
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

describe("clampOrderQuantity", () => {
  const base = {
    requested: 80,
    position: 0,
    openBuyQty: 0,
    openSellQty: 0,
    maxOrderQuantity: 50,
  };

  it("clamps a flat buy or sell to the limit", () => {
    expect(clampOrderQuantity({ ...base, side: "buy" })).toBe(50);
    expect(clampOrderQuantity({ ...base, side: "sell" })).toBe(50);
  });

  it("lets a long unwind sell and blocks a further buy", () => {
    expect(
      clampOrderQuantity({ ...base, side: "sell", position: 80, requested: 40 }),
    ).toBe(40);
    expect(
      clampOrderQuantity({ ...base, side: "buy", position: 80, requested: 10 }),
    ).toBe(0);
  });

  it("clamps a buy against inventory plus working buys", () => {
    expect(
      clampOrderQuantity({
        ...base,
        side: "buy",
        position: 30,
        openBuyQty: 10,
        requested: 20,
      }),
    ).toBe(10);
    expect(
      clampOrderQuantity({
        ...base,
        side: "buy",
        position: 30,
        openBuyQty: 20,
        requested: 20,
      }),
    ).toBe(0);
  });

  it("lets a short cover buy and blocks a further sell", () => {
    expect(
      clampOrderQuantity({ ...base, side: "buy", position: -80, requested: 40 }),
    ).toBe(40);
    expect(
      clampOrderQuantity({ ...base, side: "sell", position: -80, requested: 10 }),
    ).toBe(0);
  });
});

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
    const evts = e.cancelOrder({
      orderId: "o1",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      ts: 2,
    });
    expect(evts.some((x) => x.type === "order_update" && x.status === "cancelled")).toBe(true);
    expect(e.snapshot("X1").bids).toHaveLength(0);
  });

  it("ignores cancel from a non-owner", () => {
    const e = makeEngine();
    e.placeOrder({ orderId: "o1", userId: "alice", symbol: "X1", side: "buy", orderType: "limit", quantity: 10, price: 99, ts: 1 });
    const evts = e.cancelOrder({
      orderId: "o1",
      userId: "mallory",
      symbol: "X1",
      side: "buy",
      ts: 2,
    });
    expect(evts).toHaveLength(0);
    expect(e.snapshot("X1").bids[0]).toMatchObject({ quantity: 10 });
  });

  it("cancel before rest prevents the order from landing on the book", () => {
    const e = makeEngine();
    const cancelEvts = e.cancelOrder({
      orderId: "o1",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      ts: 1,
    });
    expect(cancelEvts).toHaveLength(1);
    expect(cancelEvts[0]).toMatchObject({
      type: "order_update",
      status: "cancelled",
      symbol: "X1",
    });

    const placeEvts = e.placeOrder({
      orderId: "o1",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 10,
      price: 99,
      ts: 2,
    });
    expect(trades(placeEvts)).toHaveLength(0);
    expect(e.snapshot("X1").bids).toHaveLength(0);
    expect(placeEvts.some((x) => x.type === "order_update" && x.status === "cancelled")).toBe(
      true,
    );
  });

  it("second off-book cancel is a no-op", () => {
    const e = makeEngine();
    const cmd = {
      orderId: "o1",
      userId: "alice",
      symbol: "X1",
      side: "buy" as const,
      ts: 1,
    };
    expect(e.cancelOrder(cmd)).toHaveLength(1);
    expect(e.cancelOrder(cmd)).toHaveLength(0);
  });

  it("rejects a new resting order once maxOpenOrders is reached", () => {
    const e = makeEngine({ maxOpenOrders: 2 });
    e.placeOrder({
      orderId: "o1",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 1,
      price: 99,
      ts: 1,
    });
    e.placeOrder({
      orderId: "o2",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 1,
      price: 98,
      ts: 2,
    });
    const evts = e.placeOrder({
      orderId: "o3",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 1,
      price: 97,
      ts: 3,
    });
    expect(evts).toMatchObject([{ type: "order_update", status: "rejected" }]);
    expect(e.openOrderCount("alice")).toBe(2);
    expect(e.snapshot("X1").bids).toHaveLength(2);
  });

  it("clamps a second buy so working size stays at maxOrderQuantity", () => {
    const e = makeEngine({ maxOrderQuantity: 50, maxOpenOrders: 10 });
    e.placeOrder({
      orderId: "o1",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 30,
      price: 99,
      ts: 1,
    });
    const evts = e.placeOrder({
      orderId: "o2",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 30,
      price: 98,
      ts: 2,
    });
    expect(evts.some((evt) => evt.type === "order_update" && evt.status === "rejected")).toBe(false);
    expect(evts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "order_update",
          orderId: "o2",
          status: "open",
          quantity: 20,
          remainingQuantity: 20,
        }),
      ]),
    );
    expect(e.openOrderQuantity("alice", "X1", "buy")).toBe(50);
  });

  it("lets an admin rest more than maxOrderQuantity", () => {
    const e = makeEngine({ maxOrderQuantity: 50, maxOpenOrders: 10 });
    const evts = e.placeOrder({
      orderId: "o1",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 80,
      price: 99,
      ts: 1,
      admin: true,
    });
    expect(evts.some((evt) => evt.type === "order_update" && evt.status === "rejected")).toBe(false);
    expect(e.openOrderQuantity("alice")).toBe(80);
  });

  it("clamps a trader buy above maxOrderQuantity to the room", () => {
    const e = makeEngine({ maxOrderQuantity: 50 });
    const evts = e.placeOrder({
      orderId: "o1",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 80,
      price: 99,
      ts: 1,
    });
    expect(evts.some((evt) => evt.type === "order_update" && evt.status === "rejected")).toBe(false);
    expect(e.openOrderQuantity("alice", "X1", "buy")).toBe(50);
    expect(e.snapshot("X1").bids[0]).toMatchObject({ quantity: 50 });
  });

  it("lets a long unwind sell and rejects a further buy past the cap", () => {
    const e = makeEngine({
      maxOrderQuantity: 50,
      maxPosition: 200,
      minPosition: -200,
      maxOpenOrders: 10,
    });
    e.placeOrder({
      orderId: "s",
      userId: "mm",
      symbol: "X1",
      side: "sell",
      orderType: "limit",
      quantity: 80,
      price: 100,
      ts: 1,
      admin: true,
    });
    e.placeOrder({
      orderId: "b",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 80,
      price: 100,
      ts: 2,
      admin: true,
    });
    expect(e.positionOf("alice", "X1")).toBe(80);

    const buy = e.placeOrder({
      orderId: "o-buy",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 10,
      price: 99,
      ts: 3,
    });
    expect(buy).toMatchObject([{ type: "order_update", status: "rejected" }]);

    const sell = e.placeOrder({
      orderId: "o-sell",
      userId: "alice",
      symbol: "X1",
      side: "sell",
      orderType: "limit",
      quantity: 40,
      price: 101,
      ts: 4,
    });
    expect(sell.some((evt) => evt.type === "order_update" && evt.status === "rejected")).toBe(false);
    expect(e.openOrderQuantity("alice", "X1", "sell")).toBe(40);
  });

  it("rejects a buy when open buys already fill to the cap, but still allows a sell", () => {
    const e = makeEngine({ maxOrderQuantity: 50, maxOpenOrders: 10 });
    e.placeOrder({
      orderId: "o1",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 50,
      price: 99,
      ts: 1,
    });
    const buy = e.placeOrder({
      orderId: "o2",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 10,
      price: 98,
      ts: 2,
    });
    expect(buy).toMatchObject([{ type: "order_update", status: "rejected" }]);
    const sell = e.placeOrder({
      orderId: "o3",
      userId: "alice",
      symbol: "X1",
      side: "sell",
      orderType: "limit",
      quantity: 10,
      price: 101,
      ts: 3,
    });
    expect(sell.some((evt) => evt.type === "order_update" && evt.status === "rejected")).toBe(false);
    expect(e.openOrderQuantity("alice", "X1", "sell")).toBe(10);
  });

  it("rejects new orders while frozen and still allows cancel", () => {
    const e = makeEngine();
    e.placeOrder({
      orderId: "o1",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 10,
      price: 99,
      ts: 1,
    });
    e.setFrozen(true);
    const evts = e.placeOrder({
      orderId: "o2",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 1,
      price: 98,
      ts: 2,
    });
    expect(evts).toMatchObject([{ type: "order_update", status: "rejected" }]);
    const cancel = e.cancelOrder({
      orderId: "o1",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      ts: 3,
    });
    expect(cancel[0]).toMatchObject({ type: "order_update", status: "cancelled" });
    e.setFrozen(false);
    const after = e.placeOrder({
      orderId: "o3",
      userId: "alice",
      symbol: "X1",
      side: "buy",
      orderType: "limit",
      quantity: 1,
      price: 97,
      ts: 4,
    });
    expect(after.some((evt) => evt.type === "order_update" && evt.status === "rejected")).toBe(false);
  });

  it("PnL subtracts starting cash so a funded book starts at zero", () => {
    const e = makeEngine({ startingCash: 10_000 });
    expect(e.portfolioOf("alice").cash).toBe(10_000);
    expect(e.portfolioOf("alice").pnl).toBe(0);
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
