import { describe, expect, it } from "vitest";
import {
  ChallengeEngine,
  type EngineConfig,
  type PlaceOrderCommand,
} from "./engine.js";

function engine(overrides: Partial<EngineConfig> = {}) {
  return new ChallengeEngine({
    challengeId: "reserved",
    symbols: [
      { symbol: "A", initialPrice: 100, volatility: 1, tickSize: 1 },
      { symbol: "N", initialPrice: 50, volatility: 1, tickSize: 1 },
    ],
    startingCash: 10000,
    minPosition: -100,
    maxPosition: 100,
    maxOrderQuantity: 20,
    positionCap: 100,
    allowMargin: true,
    ...overrides,
  });
}

function order(overrides: Partial<PlaceOrderCommand> = {}): PlaceOrderCommand {
  return {
    orderId: "buy",
    userId: "alice",
    symbol: "A",
    side: "buy",
    orderType: "limit",
    quantity: 20,
    price: 100,
    ts: 1,
    ...overrides,
  };
}

const leg = (quantity: number, symbol = "A", price = 100) => ({
  symbol,
  quantity,
  price,
});

describe("accepted settlement reservations", () => {
  it("is idempotent only for the same owner and ordered terms, without moving balances", () => {
    const e = engine();
    const portfolio = e.portfolioOf("alice");
    const metrics = e.metricsOf("alice");
    const terms = [leg(60), leg(-5, "N", 50.5)];
    expect(e.reserveSettlement("one", "alice", terms)).toBe(true);
    const saved = e.exportState();
    expect(e.reserveSettlement("one", "alice", structuredClone(terms))).toBe(
      true,
    );
    expect(e.reserveSettlement("one", "bob", terms)).toBe(false);
    expect(e.reserveSettlement("one", "alice", [leg(61), terms[1]!])).toBe(
      false,
    );
    expect(
      e.reserveSettlement("one", "alice", [leg(60, "A", 101), terms[1]!]),
    ).toBe(false);
    expect(e.reserveSettlement("one", "alice", [...terms].reverse())).toBe(
      false,
    );
    expect(e.exportState()).toEqual(saved);
    terms[0]!.quantity = 1;
    expect(e.exportState().reservations![0]!.legs[0]!.quantity).toBe(60);
    expect(e.portfolioOf("alice")).toEqual(portfolio);
    expect(e.metricsOf("alice")).toEqual(metrics);
  });

  it("counts working buys and every accepted deal without netting reserved buys against sells", () => {
    const e = engine();
    e.placeOrder(order({ price: 99 }));
    expect(e.reserveSettlement("one", "alice", [leg(60)])).toBe(true);
    expect(e.reserveSettlement("two", "alice", [leg(20)])).toBe(true);
    expect(e.reserveSettlement("three", "alice", [leg(1)])).toBe(false);
    expect(e.reserveSettlement("short", "alice", [leg(-100)])).toBe(true);
    expect(e.reserveSettlement("more-short", "alice", [leg(-1)])).toBe(false);
    expect(e.canSettleOffBook("alice", [leg(1)])).toBe(false);
    expect(e.canSettleOffBook("alice", [leg(-1)])).toBe(false);
    expect(e.reserveSettlement("independent", "bob", [leg(100)])).toBe(true);
  });

  it("aggregates repeated symbols separately by sign and rejects all legs if any symbol exceeds capacity", () => {
    const e = engine();
    expect(e.reserveSettlement("one", "alice", [leg(60), leg(-60)])).toBe(true);
    expect(
      e.reserveSettlement("two", "alice", [leg(20), leg(20), leg(-40)]),
    ).toBe(true);
    const before = e.exportState();
    expect(
      e.reserveSettlement("three", "alice", [leg(1, "N"), leg(1), leg(-1)]),
    ).toBe(false);
    expect(e.exportState()).toEqual(before);
    expect(e.reserveSettlement("n", "alice", [leg(100, "N")])).toBe(true);
  });

  it.each([NaN, Infinity, -Infinity, 1.5])(
    "rejects non-whole/nonfinite quantity %s without partial mutation",
    (quantity) => {
      const e = engine();
      const before = e.exportState();
      expect(
        e.reserveSettlement("bad", "alice", [leg(1, "N"), leg(quantity)]),
      ).toBe(false);
      expect(e.exportState()).toEqual(before);
    },
  );

  it("rejects invalid prices and unavailable symbols, but keeps accepted terms idempotent after closure", () => {
    const e = engine();
    expect(e.reserveSettlement("accepted", "alice", [leg(1, "N", 50.5)])).toBe(
      true,
    );
    e.closeSymbol("N", 1);
    const before = e.exportState();
    for (const price of [NaN, Infinity, -1])
      expect(e.reserveSettlement("bad", "alice", [leg(1, "A", price)])).toBe(
        false,
      );
    expect(e.reserveSettlement("bad", "alice", [leg(1, "UNKNOWN")])).toBe(
      false,
    );
    expect(e.reserveSettlement("new", "alice", [leg(1, "N")])).toBe(false);
    expect(e.reserveSettlement("accepted", "alice", [leg(1, "N", 50.5)])).toBe(
      true,
    );
    expect(e.reserveSettlement("", "alice", [leg(1)])).toBe(false);
    expect(e.exportState()).toEqual(before);
    expect(e.placeOrder(order({ symbol: "N" }))[0]).toMatchObject({
      status: "rejected",
    });
  });

  it("caps new working orders independently of the per-order limit", () => {
    const e = engine();
    expect(e.reserveSettlement("deal", "alice", [leg(90)])).toBe(true);
    e.placeOrder(order({ quantity: 99, price: 99 }));
    expect(e.openOrderQuantity("alice", "A", "buy")).toBe(10);
    expect(
      e.placeOrder(order({ orderId: "blocked", quantity: 1, price: 99 }))[0],
    ).toMatchObject({ status: "rejected" });
    e.releaseSettlement("deal");
    e.releaseSettlement("deal");
    e.placeOrder(order({ orderId: "more", quantity: 99, price: 99 }));
    expect(e.openOrderQuantity("alice", "A", "buy")).toBe(30);
  });

  it.each(["buy", "sell"] as const)(
    "protects accepted %s capacity against even forced taker fills, and releases it",
    (side) => {
      const e = engine();
      const sign = side === "buy" ? 1 : -1;
      e.restoreAccount("alice", {
        cash: 10000,
        positions: [{ symbol: "A", quantity: sign * 80, avgPrice: 100 }],
      });
      expect(e.reserveSettlement("deal", "alice", [leg(sign * 20)])).toBe(true);
      e.placeOrder(
        order({
          orderId: "maker",
          userId: "bot:maker",
          side: side === "buy" ? "sell" : "buy",
          quantity: 20,
        }),
      );
      const events = e.placeOrder(
        order({
          orderId: "forced",
          side,
          orderType: "market",
          price: null,
          quantity: 1,
          force: true,
        }),
      );
      expect(events.some((event) => event.type === "trade")).toBe(false);
      expect(e.positionOf("alice", "A")).toBe(sign * 80);
      e.releaseSettlement("deal");
      expect(
        e
          .placeOrder(
            order({
              orderId: "released",
              side,
              orderType: "market",
              price: null,
            }),
          )
          .filter((event) => event.type === "trade"),
      ).toHaveLength(1);
      expect(e.positionOf("alice", "A")).toBe(sign * 100);
    },
  );

  it("allows reducing trades while the increasing side is fully reserved", () => {
    const e = engine();
    e.restoreAccount("alice", {
      cash: 10000,
      positions: [{ symbol: "A", quantity: 80, avgPrice: 100 }],
    });
    expect(e.reserveSettlement("deal", "alice", [leg(20)])).toBe(true);
    e.placeOrder(order({ orderId: "bid", userId: "bot:maker", quantity: 10 }));
    expect(
      e
        .placeOrder(
          order({
            orderId: "reduce",
            side: "sell",
            orderType: "market",
            price: null,
            quantity: 10,
          }),
        )
        .filter((event) => event.type === "trade"),
    ).toHaveLength(1);
    expect(e.positionOf("alice", "A")).toBe(70);
    expect(e.canSettleOffBook("alice", [leg(10)])).toBe(true);
  });

  it("permits assignment over reserved capacity, then prevents a stale maker from filling until release", () => {
    const e = engine();
    e.addSymbol({
      symbol: "PUT",
      initialPrice: 10,
      volatility: 0,
      tickSize: 1,
    });
    e.registerOption({
      symbol: "PUT",
      underlying: "A",
      optionType: "put",
      strike: 110,
      cycleId: "cycle",
      openedAt: 0,
      expiresAt: 100,
    });
    e.restoreAccount("alice", {
      cash: 10000,
      positions: [{ symbol: "PUT", quantity: -20, avgPrice: 10 }],
    });
    e.restoreAccount("holder", {
      cash: 10000,
      positions: [{ symbol: "PUT", quantity: 20, avgPrice: 10 }],
    });
    e.placeOrder(order({ orderId: "maker", quantity: 10, price: 99 }));
    expect(e.reserveSettlement("deal", "alice", [leg(90)])).toBe(true);
    expect(e.exerciseOption("holder", "PUT", 20, 100).exercised).toBe(20);
    expect(e.positionOf("alice", "A")).toBe(20);
    const saved = e.exportState();
    e.restoreState(saved);
    expect(e.exportState()).toEqual(saved);
    const events = e.placeOrder(
      order({
        orderId: "taker",
        userId: "bob",
        side: "sell",
        orderType: "market",
        price: null,
        quantity: 1,
      }),
    );
    expect(events.some((event) => event.type === "trade")).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderId: "maker", status: "cancelled" }),
      ]),
    );
    e.releaseSettlement("deal");
    e.placeOrder(order({ orderId: "new-maker", quantity: 10, price: 99 }));
    expect(
      e
        .placeOrder(
          order({
            orderId: "retry",
            userId: "bob",
            side: "sell",
            orderType: "market",
            price: null,
            quantity: 1,
          }),
        )
        .filter((event) => event.type === "trade"),
    ).toHaveLength(1);
    expect(e.positionOf("alice", "A")).toBe(21);
  });

  it("requires releasing the settling deal while preserving other off-book reservations", () => {
    const e = engine();
    e.restoreAccount("alice", {
      cash: 10000,
      positions: [{ symbol: "A", quantity: 50, avgPrice: 100 }],
    });
    expect(e.reserveSettlement("one", "alice", [leg(40)])).toBe(true);
    expect(e.reserveSettlement("two", "alice", [leg(10)])).toBe(true);
    expect(e.settleOffBook("alice", [leg(40)])).toBe(false);
    e.releaseSettlement("one");
    expect(e.settleOffBook("alice", [leg(40)])).toBe(true);
    expect(e.settleOffBook("alice", [leg(10)])).toBe(false);
    e.releaseSettlement("two");
    expect(e.settleOffBook("alice", [leg(10)])).toBe(true);
    expect(e.positionOf("alice", "A")).toBe(100);
  });

  it("round-trips reservations through JSON and defaults older version-1 checkpoints to empty", () => {
    const e = engine();
    e.reserveSettlement("one", "alice", [leg(80), leg(-30, "N")]);
    const saved = JSON.parse(JSON.stringify(e.exportState()));
    const restored = engine();
    restored.restoreState(saved);
    expect(restored.exportState()).toEqual(saved);
    expect(
      restored.reserveSettlement("one", "alice", [leg(80), leg(-30, "N")]),
    ).toBe(true);
    expect(restored.reserveSettlement("too-much", "alice", [leg(21)])).toBe(
      false,
    );
    delete saved.reservations;
    restored.restoreState(saved);
    expect(restored.exportState().reservations).toEqual([]);
    expect(restored.reserveSettlement("fresh", "alice", [leg(100)])).toBe(true);
  });

  it("rejects malformed checkpoint reservations without changing current state", () => {
    const e = engine();
    e.reserveSettlement("deal", "alice", [leg(10)]);
    const before = e.exportState();
    for (const reservations of [
      null,
      {},
      [{ id: "bad", userId: "alice", legs: [leg(0.5)] }],
      [before.reservations![0], before.reservations![0]],
    ]) {
      expect(() => e.restoreState({ ...before, reservations })).toThrow(
        /reservation/,
      );
      expect(e.exportState()).toEqual(before);
    }
  });

  it("keeps reservations intact when an atomic order batch rolls back", () => {
    const e = engine();
    e.reserveSettlement("deal", "alice", [leg(90)]);
    e.placeOrder(
      order({
        orderId: "maker",
        userId: "bot:maker",
        side: "sell",
        quantity: 10,
      }),
    );
    const before = e.exportState();
    expect(
      e.placeAtomicOrders([
        order({ orderId: "first", quantity: 5 }),
        order({ orderId: "second", symbol: "N", quantity: 1 }),
      ]),
    ).toEqual([]);
    expect(e.exportState()).toEqual(before);
  });

  it("does not impose Eden reservation limits on legacy challenges", () => {
    const e = engine({ positionCap: undefined });
    expect(e.reserveSettlement("deal", "alice", [leg(1000)])).toBe(true);
    e.placeOrder(
      order({ orderId: "maker", userId: "bot:maker", side: "sell" }),
    );
    expect(
      e.placeOrder(order()).filter((event) => event.type === "trade"),
    ).toHaveLength(1);
    expect(e.positionOf("alice", "A")).toBe(20);
  });
});
