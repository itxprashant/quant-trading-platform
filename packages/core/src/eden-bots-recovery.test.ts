import { afterEach, describe, expect, it, vi } from "vitest";
import { ChallengeEngine } from "./engine.js";
import { EdenBotEngine } from "../../../apps/engine/src/eden-bots.js";
import type { EdenBotConfig } from "@qtp/shared";

const NOW = 1_800_000_000_000;
const RELEASE = NOW + 60_000;
const symbols = [{ symbol: "A", initialPrice: 100, volatility: 2, tickSize: 1 }];

function fixture(config: Partial<EdenBotConfig> = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const engine = new ChallengeEngine({
    challengeId: "recovery",
    symbols,
    startingCash: 10000,
    minPosition: -100,
    maxPosition: 100,
    maxOrderQuantity: 50,
    allowMargin: true,
  });
  for (const optionType of ["call", "put"] as const) {
    const symbol = optionType.toUpperCase();
    engine.addSymbol({ symbol, initialPrice: 10, volatility: 0, tickSize: 0.1 });
    engine.registerOption({
      symbol, underlying: "A", optionType, strike: 100, cycleId: "cycle",
      openedAt: NOW, expiresAt: RELEASE + 300_000, autoRoll: false,
    });
  }
  const makeBots = () => new EdenBotEngine(engine, {
    hftMarketMakers: 0, momentumTraders: 0, vegaSnipers: 0, parityArbers: 0,
    spread: 1, quoteSize: 10, intensity: 1, ...config,
  }, symbols);
  const hold = (id: string, positions: Array<[string, number]>) => {
    engine.restoreAccount(id, {
      cash: 10000,
      positions: positions.map(([symbol, quantity]) => ({ symbol, quantity, avgPrice: 10 })),
    });
  };
  let seq = 0;
  const quote = (symbol: string, side: "buy" | "sell", price: number, quantity = 10) => {
    engine.placeOrder({
      orderId: `quote:${++seq}`, userId: `bot:maker:${seq}`, symbol, side,
      orderType: "limit", price, quantity, ts: Date.now(),
    });
  };
  return { engine, makeBots, hold, quote };
}

afterEach(() => vi.useRealTimers());

describe("Eden bot recovery", () => {
  it("reconstructs accumulation from real Vega accounts and only positive option holdings", () => {
    const f = fixture();
    const id = `bot:vega:7:${RELEASE}`;
    f.hold(id, [["CALL", 3], ["PUT", 0], ["A", 10], ["DELISTED", 2]]);
    f.hold("bot:vega:invalid", [["CALL", 5]]);
    f.hold(`bot:vega:0:${RELEASE + 1}`, [["PUT", -2]]);
    f.engine.restoreState(f.engine.exportState());
    const before = f.engine.exportState();
    const bots = f.makeBots();
    bots.restore(NOW);
    bots.restore(NOW);
    expect(f.engine.exportState()).toEqual(before);
    expect(bots.enabled).toBe(true);
    const buys = bots.act(NOW).places;
    expect(buys.map((p) => [p.userId, p.symbol, p.side])).toEqual([
      [id, "CALL", "buy"], [id, "PUT", "buy"],
    ]);
  });

  it("restores a post-release dump and retries partial IOC fills until flat", () => {
    const f = fixture();
    const id = `bot:vega:3:${RELEASE}`;
    f.hold(id, [["CALL", 5], ["PUT", 2]]);
    f.engine.restoreState(f.engine.exportState());
    vi.setSystemTime(RELEASE);
    const bots = f.makeBots();
    bots.restore(RELEASE);
    f.quote("CALL", "buy", 10, 2);
    const first = bots.act(RELEASE).places;
    expect(first.map((p) => [p.symbol, p.side, p.quantity])).toEqual([
      ["CALL", "sell", 5], ["PUT", "sell", 2],
    ]);
    for (const command of first) f.engine.placeOrder(command);
    expect(f.engine.positionOf(id, "CALL")).toBe(3);
    expect(f.engine.openOrderCount(id)).toBe(0);
    f.quote("CALL", "buy", 10, 3);
    f.quote("PUT", "buy", 10, 2);
    const retry = bots.act(RELEASE + 1).places;
    expect(retry.map((p) => [p.symbol, p.quantity])).toEqual([["CALL", 3], ["PUT", 2]]);
    expect(new Set([...first, ...retry].map((p) => p.orderId)).size).toBe(4);
    for (const command of retry) f.engine.placeOrder(command);
    expect(bots.act(RELEASE + 2).places).toEqual([]);
    expect(bots.enabled).toBe(false);
  });

  it("does not trade expired or delisted restored holdings", () => {
    const f = fixture();
    f.hold(`bot:vega:0:${RELEASE}`, [["CALL", 2], ["PUT", 3]]);
    f.engine.removeSymbol("PUT");
    const now = RELEASE + 300_000;
    vi.setSystemTime(now);
    const bots = f.makeBots();
    bots.restore(now);
    expect(bots.act(now).places).toEqual([]);
    expect(bots.enabled).toBe(false);
  });

  it("starts beyond checkpoint sequences and tombstones despite a clock rollback", () => {
    const f = fixture({ hftMarketMakers: 1 });
    const state = f.engine.exportState();
    state.seq = NOW + 100;
    state.cancelledIds = [`bot:hft:0:A:b:${NOW + 200}`];
    f.engine.restoreState(state);
    const bots = f.makeBots();
    bots.restore(NOW - 1000);
    const places = bots.act(NOW).places;
    expect(places.length).toBeGreaterThan(0);
    expect(places.every((p) => Number(p.orderId.split(":").at(-1)) > NOW + 200)).toBe(true);
    for (const command of places) f.engine.placeOrder(command);
    expect(f.engine.openOrderCount("bot:hft:0")).toBe(places.length);
  });

  it("re-quotes once after the parent cancels saved quotes and then replaces them", () => {
    const f = fixture({ hftMarketMakers: 1 });
    const initial = f.makeBots();
    for (let i = 0; i < 3; i++) {
      const act = initial.act(NOW + i);
      for (const cancel of act.cancels) f.engine.cancelOrder(cancel);
      for (const place of act.places) f.engine.placeOrder(place);
    }
    f.engine.restoreState(f.engine.exportState());
    f.engine.cancelUserOrders("bot:hft:0", NOW + 100);
    const bots = f.makeBots();
    bots.restore(NOW + 100);
    const first = bots.act(NOW + 100);
    expect(first.cancels).toEqual([]);
    for (const place of first.places) f.engine.placeOrder(place);
    expect(f.engine.openOrderCount("bot:hft:0")).toBe(6);
    const second = bots.act(NOW + 101);
    for (const cancel of second.cancels) f.engine.cancelOrder(cancel);
    for (const place of second.places) f.engine.placeOrder(place);
    expect(f.engine.openOrderCount("bot:hft:0")).toBe(6);
  });

  it.each([1000, 120_000])("uses a %i ms game-minute preparation window", (leadMs) => {
    const f = fixture({ vegaSnipers: 1 });
    const bots = f.makeBots();
    bots.prepareVolEvent("A", RELEASE, RELEASE - leadMs - 1, leadMs);
    expect(bots.act(RELEASE - leadMs - 1).places).toEqual([]);
    bots.prepareVolEvent("A", RELEASE, RELEASE - leadMs, leadMs);
    expect(bots.act(RELEASE - leadMs).places.map((p) => p.side)).toEqual(["buy", "buy"]);
  });

  it("keeps the default 60-second preparation window and rejects invalid clocks", () => {
    const f = fixture({ vegaSnipers: 1 });
    const bots = f.makeBots();
    bots.prepareVolEvent("A", RELEASE, NOW - 1);
    bots.prepareVolEvent("A", RELEASE, NaN);
    bots.prepareVolEvent("A", RELEASE, NOW, 0);
    expect(bots.act(NOW).places).toEqual([]);
    expect(() => bots.restore(NaN)).toThrow("Invalid bot restore timestamp");
    bots.prepareVolEvent("A", RELEASE, NOW);
    expect(bots.act(NOW).places).toHaveLength(2);
  });
});

describe("parity IOC capacity", () => {
  it("returns a batch instead of independent orders and aborts it if a quote disappears", () => {
    const f = fixture({ parityArbers: 1 });
    f.quote("CALL", "buy", 20);
    f.quote("PUT", "sell", 10);
    f.quote("A", "sell", 101);
    const action = f.makeBots().act(NOW, () => 0);
    expect(action.places).toEqual([]);
    expect(action.batches).toHaveLength(1);
    f.engine.cancelSymbolOrders("A", NOW);
    const before = f.engine.exportState();
    expect(f.engine.placeAtomicOrders(action.batches![0]!)).toEqual([]);
    expect(f.engine.exportState()).toEqual(before);
  });
  it("does not spend the same underlying capacity on two pending batches", () => {
    const f = fixture({ parityArbers: 1 });
    f.hold("bot:parity:0", [["A", 98]]);
    for (const symbol of ["CALL", "PUT"]) {
      f.engine.addSymbol({ symbol: `${symbol}2`, initialPrice: 10, volatility: 0, tickSize: 0.1 });
      f.engine.registerOption({
        ...f.engine.getOption(symbol)!, symbol: `${symbol}2`, cycleId: "second",
      });
    }
    for (const suffix of ["", "2"]) {
      f.quote(`CALL${suffix}`, "buy", 20);
      f.quote(`PUT${suffix}`, "sell", 10);
    }
    f.quote("A", "sell", 101);
    const batches = f.makeBots().act(NOW, () => 0).batches!;
    expect(batches).toHaveLength(1);
    const legs = batches[0]!;
    expect(legs).toHaveLength(3);
    expect(legs.every((p) => p.quantity === 2)).toBe(true);
  });

  it("bounds every leg by the most constrained position and working-order capacity", () => {
    const f = fixture({ parityArbers: 1 });
    f.hold("bot:parity:0", [["A", 98]]);
    f.engine.placeOrder({
      orderId: "working", userId: "bot:parity:0", symbol: "A", side: "buy",
      orderType: "limit", price: 1, quantity: 1, ts: NOW,
    });
    f.quote("CALL", "buy", 20);
    f.quote("PUT", "sell", 10);
    f.quote("A", "sell", 101);
    const batches = f.makeBots().act(NOW, () => 0).batches!;
    expect(batches).toHaveLength(1);
    const legs = batches[0]!;
    expect(legs).toHaveLength(3);
    expect(legs.every((p) => p.quantity === 1 && p.orderType === "limit" && p.timeInForce === "IOC")).toBe(true);
    expect(f.engine.placeAtomicOrders(legs).length).toBeGreaterThan(0);
    expect(f.engine.positionOf("bot:parity:0", "CALL")).toBe(-1);
    expect(f.engine.positionOf("bot:parity:0", "PUT")).toBe(1);
    expect(f.engine.positionOf("bot:parity:0", "A")).toBe(99);
  });

  it.each(["capacity", "closed"])("submits no legs when the stock has no %s", (reason) => {
    const f = fixture({ parityArbers: 1 });
    f.quote("CALL", "buy", 20);
    f.quote("PUT", "sell", 10);
    f.quote("A", "sell", 101);
    if (reason === "capacity") f.hold("bot:parity:0", [["A", 100]]);
    else f.engine.closeSymbol("A", NOW);
    expect(f.makeBots().act(NOW, () => 0).batches).toEqual([]);
  });
});

function etfFixture() {
  const f = fixture({ parityArbers: 1 });
  f.engine.addSymbol({ symbol: "N", initialPrice: 50, volatility: 0, tickSize: 1 });
  f.engine.addSymbol({ symbol: "ETF", initialPrice: 250, volatility: 0, tickSize: 1 });
  const etf = { symbol: "ETF", basket: [{ symbol: "A", weight: 2 }, { symbol: "N", weight: 1 }] };
  const bots = f.makeBots();
  bots.setEtfs([etf]);
  return { ...f, bots, etf };
}

describe("ETF atomic arbitrage", () => {
  it("sells a rich ETF and buys the weighted basket within executable depth", () => {
    const f = etfFixture();
    f.quote("ETF", "buy", 260, 10);
    f.quote("A", "sell", 100, 7);
    f.quote("N", "sell", 50, 6);
    const action = f.bots.act(NOW, () => 0);
    expect(action.places).toEqual([]);
    expect(action.batches).toHaveLength(1);
    const batch = action.batches![0]!;
    expect(batch.map((p) => [p.symbol, p.side, p.quantity, p.price])).toEqual([
      ["ETF", "sell", 3, 260], ["A", "buy", 6, 100], ["N", "buy", 3, 50],
    ]);
    expect(batch.every((p) => p.orderType === "limit" && p.timeInForce === "IOC")).toBe(true);
    expect(f.engine.placeAtomicOrders(batch).filter((e) => e.type === "trade")).toHaveLength(3);
    expect(f.engine.cashOf("bot:etf:0")).toBe(10030);
    expect(f.engine.positionOf("bot:etf:0", "ETF")).toBe(-3);
    expect(f.engine.positionOf("bot:etf:0", "A")).toBe(6);
    expect(f.engine.positionOf("bot:etf:0", "N")).toBe(3);
  });

  it("buys a cheap ETF and sells its basket", () => {
    const f = etfFixture();
    f.quote("ETF", "sell", 240, 8);
    f.quote("A", "buy", 100, 9);
    f.quote("N", "buy", 50, 3);
    const batch = f.bots.act(NOW, () => 0).batches![0]!;
    expect(batch.map((p) => [p.symbol, p.side, p.quantity, p.price])).toEqual([
      ["ETF", "buy", 3, 240], ["A", "sell", 6, 100], ["N", "sell", 3, 50],
    ]);
    expect(f.engine.placeAtomicOrders(batch).filter((e) => e.type === "trade")).toHaveLength(3);
    expect(f.engine.cashOf("bot:etf:0")).toBe(10030);
    expect(f.engine.positionOf("bot:etf:0", "ETF")).toBe(3);
    expect(f.engine.positionOf("bot:etf:0", "A")).toBe(-6);
  });

  it("reserves weighted position capacity across ETFs and existing working orders", () => {
    const f = etfFixture();
    f.hold("bot:etf:0", [["A", 95]]);
    f.engine.placeOrder({ orderId: "working", userId: "bot:etf:0", symbol: "A", side: "buy", orderType: "limit", price: 1, quantity: 1, ts: NOW });
    f.engine.addSymbol({ symbol: "ETF2", initialPrice: 250, volatility: 0, tickSize: 1 });
    f.bots.setEtfs([f.etf, { ...f.etf, symbol: "ETF2" }]);
    f.quote("ETF", "buy", 270, 10);
    f.quote("ETF2", "buy", 270, 10);
    f.quote("A", "sell", 100, 20);
    f.quote("N", "sell", 50, 20);
    const batches = f.bots.act(NOW, () => 0).batches!;
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((p) => p.quantity)).toEqual([2, 4, 2]);
    expect(f.engine.placeAtomicOrders(batches[0]!).length).toBeGreaterThan(0);
    expect(f.engine.positionOf("bot:etf:0", "A")).toBe(99);
  });

  it.each(["one tick", "missing", "closed", "capacity", "no edge"])("skips an ETF with %s", (reason) => {
    const f = etfFixture();
    f.quote("ETF", "buy", reason === "one tick" ? 251 : reason === "no edge" ? 249 : 260);
    f.quote("A", "sell", 100);
    if (reason !== "missing") f.quote("N", "sell", 50);
    if (reason === "closed") f.engine.closeSymbol("N", NOW);
    if (reason === "capacity") f.hold("bot:etf:0", [["A", 100]]);
    f.engine.setFairValue("ETF", 1000);
    expect(f.bots.act(NOW, () => 0).batches).toEqual([]);
  });

  it("rolls back the ETF and first basket fill if later liquidity disappears", () => {
    const f = etfFixture();
    f.quote("ETF", "buy", 260, 10);
    f.quote("A", "sell", 100, 10);
    f.quote("N", "sell", 50, 10);
    const batch = f.bots.act(NOW, () => 0).batches![0]!;
    f.engine.cancelSymbolOrders("N", NOW);
    const before = f.engine.exportState();
    expect(f.engine.placeAtomicOrders(batch)).toEqual([]);
    expect(f.engine.exportState()).toEqual(before);
  });

  it("replaces ETF configs, aggregates duplicate components and keeps a detached validated copy", () => {
    const f = etfFixture();
    const config = { symbol: "ETF", basket: [{ symbol: "A", weight: 1 }, { symbol: "A", weight: 1 }, { symbol: "N", weight: 1 }] };
    f.bots.setEtfs([config]);
    config.basket[0]!.weight = 99;
    expect(() => f.bots.setEtfs([{ symbol: "ETF", basket: [{ symbol: "A", weight: 0 }] }])).toThrow("Invalid ETF basket");
    f.quote("ETF", "buy", 260);
    f.quote("A", "sell", 100, 10);
    f.quote("N", "sell", 50, 10);
    const batch = f.bots.act(NOW, () => 0).batches![0]!;
    expect(batch.map((p) => [p.symbol, p.quantity])).toEqual([["ETF", 5], ["A", 10], ["N", 5]]);
    f.bots.setEtfs([]);
    expect(f.bots.act(NOW, () => 0).batches).toEqual([]);
  });
});
