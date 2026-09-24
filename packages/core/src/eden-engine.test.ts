import { describe, expect, it, vi } from "vitest";
import {
  ChallengeEngine,
  type EngineState,
  type PlaceOrderCommand,
} from "./engine.js";
import { optionSymbol, parseOptionSymbol } from "./options.js";

function engine() {
  return new ChallengeEngine({
    challengeId: "eden",
    symbols: [
      { symbol: "A", initialPrice: 100, tickSize: 1, volatility: 2 },
      { symbol: "N", initialPrice: 50, tickSize: 1, volatility: 1 },
      { symbol: "ETF", initialPrice: 250, tickSize: 1, volatility: 0 },
    ],
    startingCash: 10000,
    minPosition: -1000,
    maxPosition: 1000,
    positionCap: 100,
    maxOrderQuantity: 20,
    allowMargin: true,
  });
}

function order(overrides: Partial<PlaceOrderCommand> = {}): PlaceOrderCommand {
  return {
    orderId: "o",
    userId: "alice",
    symbol: "A",
    side: "buy",
    orderType: "limit",
    quantity: 20,
    price: 99,
    ts: 1,
    ...overrides,
  };
}

describe("version 1 engine checkpoints", () => {
  it("round-trips all accounts, controls, symbols, marks, orders and counters through JSON", () => {
    const source = engine();
    source.addSymbol({
      symbol: "DYNAMIC",
      name: "Dynamic",
      initialPrice: 25,
      volatility: 3,
      tickSize: 0.5,
    });
    const symbol = optionSymbol("A", "call", 100, "cycle-one");
    source.addSymbol({ symbol, initialPrice: 8, volatility: 0, tickSize: 0.1 });
    source.registerOption({
      symbol,
      underlying: "A",
      optionType: "call",
      strike: 100,
      cycleId: "cycle-one",
      openedAt: 1,
      expiresAt: 300001,
    });
    source.restoreAccount("bot:writer", {
      cash: 12345,
      loanDebt: 77,
      positions: [
        { symbol, quantity: -2, avgPrice: 7 },
        { symbol: "DELISTED", quantity: 0, avgPrice: 11 },
      ],
      metrics: {
        realizedPnl: -17,
        volume: 19,
        trades: 3,
        spreadCapture: 5,
        quoteUptimeMs: 1234,
      },
    });
    source.restoreAccount("alice", {
      cash: -42,
      loanDebt: 1000,
      positions: [{ symbol, quantity: 2, avgPrice: 7 }],
    });
    source.placeOrder(
      order({
        userId: "bot:writer",
        symbol,
        side: "sell",
        price: 11,
        quantity: 7,
      }),
    );
    source.placeOrder(
      order({ orderId: "spot", userId: "bot:spot", quantity: 5 }),
    );
    source.cancelOrder({
      orderId: "cancel-before-place",
      userId: "alice",
      symbol: "A",
      side: "buy",
      ts: 2,
    });
    source.setPrice(symbol, 12.5);
    source.setFairValue(symbol, 13.2);
    source.setFairValue("UNLISTED", 88);
    source.closeSymbol("N", 3);
    source.setFrozen(true);
    source.setVolatilityMultiplier(3);
    const saved: EngineState = JSON.parse(JSON.stringify(source.exportState()));
    const target = new ChallengeEngine({
      ...saved.config,
      startingCash: 1,
      symbols: [],
    });
    target.restoreAccount("discard-me", { cash: 5, positions: [] });
    target.restoreState(saved);
    expect(target.exportState()).toEqual(saved);
    expect(target.restoredFromCheckpoint).toBe(true);
    expect(target.accountIds()).toContain("bot:writer");
    expect(target.accountIds()).not.toContain("discard-me");
    expect(target.autonomousSymbols()).toEqual(source.autonomousSymbols());
    expect(target.placeOrder(order({ orderId: "frozen" }))[0]).toMatchObject({
      status: "rejected",
    });
    target.setFrozen(false);
    expect(
      target.placeOrder(order({ orderId: "cancel-before-place" }))[0],
    ).toMatchObject({ status: "cancelled" });
    expect(target.isSymbolOpen("N", 4)).toBe(false);
    expect(target.cashOf("new-human")).toBe(10000);
    expect(target.tickPrice("A", 4, () => 1)).toEqual(
      source.tickPrice("A", 4, () => 1),
    );
  });

  it("continues FIFO fills identically and conserves cash/inventory after restart", () => {
    const source = engine();
    source.placeOrder(
      order({
        orderId: "first",
        userId: "bot:maker",
        side: "sell",
        price: 100,
        quantity: 10,
      }),
    );
    source.placeOrder(
      order({
        orderId: "second",
        userId: "human-maker",
        side: "sell",
        price: 100,
        quantity: 10,
      }),
    );
    source.placeOrder(order({ orderId: "partial", price: 100, quantity: 3 }));
    const target = engine();
    target.restoreState(JSON.parse(JSON.stringify(source.exportState())));
    const beforeCash = target
      .accountIds()
      .reduce((sum, id) => sum + target.cashOf(id), 0);
    const cmd = order({
      orderId: "after-restart",
      price: 100,
      quantity: 12,
      ts: 2,
    });
    const events = target.placeOrder(cmd);
    expect(events).toEqual(source.placeOrder(cmd));
    expect(
      events
        .filter((e) => e.type === "trade")
        .map((e) => [e.sellOrderId, e.quantity]),
    ).toEqual([
      ["first", 7],
      ["second", 5],
    ]);
    expect(
      target.accountIds().reduce((sum, id) => sum + target.cashOf(id), 0),
    ).toBe(beforeCash);
    expect(
      target
        .accountIds()
        .reduce((sum, id) => sum + target.positionOf(id, "A"), 0),
    ).toBe(0);
    expect(target.exportState()).toEqual(source.exportState());
  });

  it("rejects malformed or unsupported checkpoints without changing existing state", () => {
    const target = engine();
    target.placeOrder(order());
    const before = target.exportState();
    const invalid: unknown[] = [
      null,
      {},
      { ...before, version: 2 },
      { ...before, seq: -1 },
      { ...before, config: { ...before.config, challengeId: "other" } },
      { ...before, prices: {} },
      {
        ...before,
        accounts: [
          {
            userId: "bad",
            cash: null,
            positions: [],
            loanDebt: 0,
            metrics: {},
          },
        ],
      },
    ];
    const duplicate = structuredClone(before);
    duplicate.symbols[0]!.orders.push({ ...duplicate.symbols[0]!.orders[0]! });
    invalid.push(duplicate);
    for (const state of invalid) {
      expect(() => target.restoreState(state)).toThrow(
        /Invalid engine checkpoint/,
      );
      expect(target.exportState()).toEqual(before);
      expect(target.restoredFromCheckpoint).toBe(false);
    }
  });

  it("does not share references with exported or restored snapshots", () => {
    const source = engine();
    source.placeOrder(order());
    const saved = source.exportState();
    const target = engine();
    target.restoreState(saved);
    saved.symbols[0]!.orders[0]!.remaining = 1;
    saved.config.startingCash = 2;
    saved.symbols[0]!.config.volatility = 999;
    expect(source.snapshot("A").bids[0]!.quantity).toBe(20);
    expect(target.snapshot("A").bids[0]!.quantity).toBe(20);
    expect(target.cashOf("new")).toBe(10000);
    const output = target.exportState();
    output.accounts[0]!.cash = 1;
    expect(target.cashOf(output.accounts[0]!.userId)).toBe(10000);
  });
});

describe("New Eden account and order invariants", () => {
  it("separates per-order quantity from position and working limits", () => {
    const e = engine();
    e.restoreAccount("alice", {
      cash: 8000,
      positions: [{ symbol: "A", quantity: 60, avgPrice: 100 }],
    });
    e.placeOrder(order({ quantity: 99 }));
    e.placeOrder(order({ orderId: "o2", quantity: 99 }));
    expect(e.openOrderQuantity("alice")).toBe(40);
    expect(e.placeOrder(order({ orderId: "o3" }))[0]).toMatchObject({
      status: "rejected",
    });
    expect(e.cashOf("alice")).toBe(8000);
  });

  it("hydrates account metrics and FIFO without executing trades", () => {
    const e = engine();
    const snapshot = {
      cash: 17,
      loanDebt: 13,
      positions: [{ symbol: "A", quantity: -3, avgPrice: 102 }],
      metrics: { realizedPnl: 9, volume: 12, quoteUptimeMs: 2000 },
    };
    e.restoreAccount("alice", snapshot);
    e.restoreAccount("alice", snapshot);
    expect(e.portfolioOf("alice")).toMatchObject({
      cash: 17,
      loanDebt: 13,
      freeCash: 17,
    });
    expect(e.metricsOf("alice")).toMatchObject({
      realizedPnl: 9,
      volume: 12,
      quoteUptime: 2,
    });
    for (const seq of [5, 2])
      expect(
        e.restoreRestingOrder("A", {
          id: `r${seq}`,
          userId: `maker${seq}`,
          side: "sell",
          price: 100,
          remaining: 2,
          seq,
        }),
      ).toBe(true);
    expect(
      e.restoreRestingOrder("A", {
        id: "r2",
        userId: "maker",
        side: "sell",
        price: 100,
        remaining: 2,
        seq: 1,
      }),
    ).toBe(false);
    expect(
      e
        .placeOrder(order({ orderType: "market", price: null, quantity: 1 }))
        .find((ev) => ev.type === "trade"),
    ).toMatchObject({ sellOrderId: "r2" });
  });

  it("matches a trader against their own resting order", () => {
    const e = engine();
    e.placeOrder(order({ side: "buy", price: 900, quantity: 1 }));
    const events = e.placeOrder(
      order({
        orderId: "take",
        side: "sell",
        price: 900,
        quantity: 1,
      }),
    );
    expect(events.filter((ev) => ev.type === "trade")).toEqual([
      expect.objectContaining({
        buyerId: "alice",
        sellerId: "alice",
        price: 900,
        quantity: 1,
      }),
    ]);
    expect(e.openOrderCount("alice")).toBe(0);
    expect(e.positionOf("alice", "A")).toBe(0);
    expect(e.metricsOf("alice").volume).toBe(2);
  });

  it("partially filled IOC is terminal cancelled and never rests", () => {
    const e = engine();
    e.placeOrder(
      order({ userId: "maker", side: "sell", price: 100, quantity: 3 }),
    );
    const events = e.placeOrder(
      order({ orderId: "ioc", quantity: 10, price: 100, timeInForce: "IOC" }),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          orderId: "ioc",
          status: "cancelled",
          remainingQuantity: 7,
        }),
      ]),
    );
    expect(e.openOrderCount("alice")).toBe(0);
  });

  it("cancels user and symbol orders and blocks closed symbols", () => {
    const e = engine();
    e.placeOrder(order());
    e.placeOrder(order({ orderId: "other", userId: "bob", symbol: "N" }));
    expect(
      e.cancelUserOrders("alice", 2).filter((ev) => ev.type === "order_update"),
    ).toHaveLength(1);
    expect(e.openOrderCount("bob")).toBe(1);
    e.closeSymbol("N", 3);
    expect(e.openOrderCount("bob")).toBe(0);
    expect(
      e.placeOrder(order({ orderId: "closed", symbol: "N" }))[0],
    ).toMatchObject({ status: "rejected" });
  });

  it("cancel-before-place prevents fills as well as resting", () => {
    const e = engine();
    e.placeOrder(order({ userId: "maker", side: "sell", price: 100 }));
    e.cancelOrder({
      orderId: "cancelled",
      userId: "alice",
      symbol: "A",
      side: "buy",
      ts: 1,
    });
    const events = e.placeOrder(order({ orderId: "cancelled", price: 101 }));
    expect(events.some((ev) => ev.type === "trade")).toBe(false);
  });

  it("scales autonomous volatility without compounding repeated updates", () => {
    const e = engine();
    e.setVolatilityMultiplier(3);
    e.setVolatilityMultiplier(3);
    e.tickPrice("A", 1, () => 1);
    expect(e.getPrice("A")).toBe(106);
  });
});

describe("atomic IOC batches", () => {
  it("rolls back partial legs, self-order cancellations, prices, accounts, metrics and sequence counters", () => {
    const e = engine();
    e.placeOrder(
      order({ orderId: "own", side: "sell", price: 99, quantity: 2 }),
    );
    e.placeOrder(
      order({
        orderId: "maker-a",
        userId: "maker-a",
        side: "sell",
        price: 100,
        quantity: 5,
      }),
    );
    e.placeOrder(
      order({
        orderId: "maker-n",
        userId: "maker-n",
        symbol: "N",
        side: "sell",
        price: 51,
        quantity: 1,
      }),
    );
    e.setFairValue("A", 105);
    e.setVolatilityMultiplier(3);
    const before = e.exportState();
    const commands = [
      order({ orderId: "take-a", price: 100, quantity: 3 }),
      order({ orderId: "take-n", symbol: "N", price: 51, quantity: 2 }),
    ];
    const untouched = structuredClone(commands);
    expect(e.placeAtomicOrders(commands)).toEqual([]);
    expect(e.exportState()).toEqual(before);
    expect(e.restoredFromCheckpoint).toBe(false);
    expect(commands).toEqual(untouched);
    // The canceled own quote is restored, as is the sequence for future trades.
    const control = engine();
    control.restoreState(before);
    expect(
      e.placeOrder(
        order({
          orderId: "after-abort",
          userId: "new",
          price: 100,
          quantity: 2,
        }),
      ),
    ).toEqual(
      control.placeOrder(
        order({
          orderId: "after-abort",
          userId: "new",
          price: 100,
          quantity: 2,
        }),
      ),
    );
  });

  it("commits all requested fills, conserves counterparty cash/inventory and never rests", () => {
    const e = engine();
    e.placeOrder(
      order({
        orderId: "ask",
        userId: "maker-a",
        side: "sell",
        price: 100,
        quantity: 6,
      }),
    );
    e.placeOrder(
      order({
        orderId: "bid",
        userId: "maker-n",
        symbol: "N",
        side: "buy",
        price: 50,
        quantity: 4,
      }),
    );
    e.cashOf("alice");
    const cash = e.accountIds().reduce((sum, id) => sum + e.cashOf(id), 0);
    const events = e.placeAtomicOrders([
      order({ orderId: "a", price: 100, quantity: 6 }),
      order({
        orderId: "n",
        symbol: "N",
        side: "sell",
        price: 50,
        quantity: 4,
      }),
    ]);
    expect(events.filter((event) => event.type === "trade")).toHaveLength(2);
    expect(
      events.filter(
        (event) => event.type === "order_update" && event.userId === "alice",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          orderId: "a",
          status: "filled",
          quantity: 6,
        }),
        expect.objectContaining({
          orderId: "n",
          status: "filled",
          quantity: 4,
        }),
      ]),
    );
    expect(e.openOrderCount("alice")).toBe(0);
    expect(e.accountIds().reduce((sum, id) => sum + e.cashOf(id), 0)).toBe(
      cash,
    );
    for (const symbol of ["A", "N"])
      expect(
        e.accountIds().reduce((sum, id) => sum + e.positionOf(id, symbol), 0),
      ).toBe(0);
    expect(e.restoredFromCheckpoint).toBe(false);
  });

  it("rejects an apparently filled leg if its requested quantity was clipped", () => {
    const e = engine();
    e.placeOrder(
      order({
        orderId: "ask",
        userId: "bot:maker",
        side: "sell",
        price: 100,
        quantity: 50,
      }),
    );
    e.restoreState(e.exportState());
    const before = e.exportState();
    expect(e.placeAtomicOrders([order({ quantity: 21, price: 100 })])).toEqual(
      [],
    );
    expect(e.exportState()).toEqual(before);
    expect(e.restoredFromCheckpoint).toBe(true);
  });

  it.each(["unknown", "frozen", "duplicate", "no liquidity", "cap"])(
    "aborts cleanly on %s",
    (reason) => {
      const e = engine();
      e.placeOrder(
        order({
          orderId: "ask",
          userId: "maker",
          side: "sell",
          price: 100,
          quantity: 5,
        }),
      );
      const commands = [
        order({ orderId: "first", quantity: 1, price: 100 }),
        order({ orderId: "second", quantity: 1, symbol: "N", price: 50 }),
      ];
      if (reason === "unknown") commands[1]!.symbol = "UNKNOWN";
      if (reason === "frozen") e.setFrozen(true);
      if (reason === "duplicate") commands[1]!.orderId = "first";
      if (reason === "cap")
        e.restoreAccount("alice", {
          cash: 10000,
          positions: [{ symbol: "A", quantity: 100, avgPrice: 100 }],
        });
      const before = e.exportState();
      expect(e.placeAtomicOrders(commands)).toEqual([]);
      expect(e.exportState()).toEqual(before);
    },
  );

  it("also rolls back when matching throws after an earlier successful leg", () => {
    const e = engine();
    e.placeOrder(
      order({
        orderId: "ask",
        userId: "maker",
        side: "sell",
        price: 100,
        quantity: 5,
      }),
    );
    const before = e.exportState();
    const place = e.placeOrder.bind(e);
    vi.spyOn(e, "placeOrder")
      .mockImplementationOnce(place)
      .mockImplementationOnce(() => {
        throw new Error("matching failed");
      });
    expect(
      e.placeAtomicOrders([
        order({ orderId: "first", quantity: 1, price: 100 }),
        order({ orderId: "second", quantity: 1, price: 100 }),
      ]),
    ).toEqual([]);
    expect(e.exportState()).toEqual(before);
  });
});

describe("physical settlement", () => {
  it("exchanges an actual basket with no cash movement", () => {
    const e = engine();
    e.restoreAccount("alice", {
      cash: 1000,
      positions: [
        { symbol: "A", quantity: 20, avgPrice: 90 },
        { symbol: "N", quantity: 10, avgPrice: 40 },
      ],
    });
    const basket = [
      { symbol: "A", weight: 2 },
      { symbol: "N", weight: 1 },
    ];
    const wealth = e.portfolioOf("alice").pnl;
    expect(e.exchangeBasket("alice", "ETF", basket, "create", 10)).toBe(true);
    expect(e.cashOf("alice")).toBe(1000);
    expect(e.positionOf("alice", "A")).toBe(0);
    expect(e.positionOf("alice", "N")).toBe(0);
    expect(e.positionOf("alice", "ETF")).toBe(10);
    expect(e.portfolioOf("alice").pnl).toBe(wealth);
    expect(e.exchangeBasket("alice", "ETF", basket, "redeem", 10)).toBe(true);
    expect(e.positionOf("alice", "A")).toBe(20);
    expect(e.cashOf("alice")).toBe(1000);
  });

  it("rejects a basket atomically when any leg exceeds cap or lacks inventory", () => {
    const e = engine();
    const basket = [
      { symbol: "A", weight: 2 },
      { symbol: "N", weight: 1 },
    ];
    expect(e.exchangeBasket("alice", "ETF", basket, "create", 1)).toBe(false);
    e.restoreAccount("alice", {
      cash: 1000,
      positions: [
        { symbol: "A", quantity: 99, avgPrice: 100 },
        { symbol: "ETF", quantity: 1, avgPrice: 250 },
      ],
    });
    const before = e.portfolioOf("alice");
    expect(e.exchangeBasket("alice", "ETF", basket, "redeem", 1)).toBe(false);
    expect(e.portfolioOf("alice")).toEqual(before);
  });

  it("checked OTC batch accounts for working orders and aggregates repeated symbols", () => {
    const e = engine();
    e.restoreAccount("alice", {
      cash: 10,
      positions: [{ symbol: "A", quantity: 70, avgPrice: 100 }],
    });
    e.placeOrder(order());
    expect(
      e.settleOffBook("alice", [
        { symbol: "N", quantity: 5, price: 50 },
        { symbol: "A", quantity: 6, price: 100 },
        { symbol: "A", quantity: 5, price: 100 },
      ]),
    ).toBe(false);
    expect(e.positionOf("alice", "N")).toBe(0);
    expect(
      e.settleOffBook("alice", [{ symbol: "A", quantity: 10, price: 100 }]),
    ).toBe(true);
    expect(e.freeCashOf("alice")).toBe(-990);
  });

  it.each(["call", "put"] as const)(
    "conserves cash and underlying for %s exercise even with missing shorts",
    (type) => {
      const e = engine();
      const symbol = optionSymbol("A", type, 100, "cycle");
      e.addSymbol({ symbol, initialPrice: 10, tickSize: 1, volatility: 0 });
      e.registerOption({
        symbol,
        underlying: "A",
        optionType: type,
        strike: 100,
        cycleId: "cycle",
        openedAt: 0,
        expiresAt: 100,
      });
      e.setPrice("A", type === "call" ? 110 : 90);
      e.restoreAccount("long", {
        cash: 10000,
        positions: [{ symbol, quantity: 10, avgPrice: 10 }],
      });
      e.restoreAccount("short", {
        cash: 10000,
        positions: [{ symbol, quantity: -4, avgPrice: 10 }],
      });
      const result = e.exerciseOption("long", symbol, 10, 100);
      expect(result.exercised).toBe(4);
      expect(e.positionOf("long", symbol)).toBe(6);
      expect(e.positionOf("short", symbol)).toBe(0);
      expect(e.cashOf("long") + e.cashOf("short")).toBe(20000);
      expect(e.positionOf("long", "A") + e.positionOf("short", "A")).toBe(0);
      expect(e.exerciseOption("long", symbol, 1, 101).exercised).toBe(0);
    },
  );

  it("uses unique round-trippable cycles and a half-open 15 second exercise window", () => {
    const a = optionSymbol("A", "call", 100, "first");
    expect(a).not.toBe(optionSymbol("A", "call", 100, "second"));
    expect(parseOptionSymbol(a)).toEqual({
      underlying: "A",
      type: "call",
      strike: 100,
      cycleId: "first",
    });
    const e = engine();
    e.addSymbol({ symbol: a, initialPrice: 10, tickSize: 1, volatility: 0 });
    e.registerOption({
      symbol: a,
      underlying: "A",
      optionType: "call",
      strike: 90,
      cycleId: "first",
      openedAt: 0,
      expiresAt: 100,
    });
    e.restoreAccount("long", {
      cash: 1000,
      positions: [{ symbol: a, quantity: 2, avgPrice: 10 }],
    });
    e.restoreAccount("short", {
      cash: 1000,
      positions: [{ symbol: a, quantity: -2, avgPrice: 10 }],
    });
    expect(e.exerciseOption("long", a, 1, 99).exercised).toBe(0);
    expect(e.exerciseOption("long", a, 1, 15099).exercised).toBe(1);
    expect(e.exerciseOption("long", a, 1, 15100).exercised).toBe(0);
    expect(e.placeOrder(order({ symbol: a, ts: 100 }))[0]).toMatchObject({
      status: "rejected",
    });
  });
});
