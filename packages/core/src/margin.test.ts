import { describe, expect, it } from "vitest";
import {
  carryCharge,
  freeCash,
  isMarginBreach,
  liquidationLegs,
  loanBleed,
  loanTotalRepay,
} from "./margin.js";
import { ChallengeEngine, type EngineConfig } from "./engine.js";

function makeEngine(overrides: Partial<EngineConfig> = {}) {
  return new ChallengeEngine({
    challengeId: "eden",
    symbols: [
      { symbol: "AERIUM", initialPrice: 1000, volatility: 4, tickSize: 0.5 },
    ],
    startingCash: 10000,
    minPosition: -100,
    maxPosition: 100,
    maxOrderQuantity: 50,
    allowMargin: true,
    ...overrides,
  });
}

describe("free cash", () => {
  it("nets cash + market value − loan debt", () => {
    expect(freeCash({ cash: 100, marketValue: 50, loanDebt: 30 })).toBe(120);
  });

  it("flags a breach at or below threshold", () => {
    expect(isMarginBreach(0)).toBe(true);
    expect(isMarginBreach(-5)).toBe(true);
    expect(isMarginBreach(1)).toBe(false);
    expect(isMarginBreach(-1, -10)).toBe(false);
  });
});

describe("cost of carry", () => {
  it("charges per absolute unit of inventory", () => {
    expect(carryCharge(40, 1)).toBe(40);
    expect(carryCharge(0, 1)).toBe(0);
    expect(carryCharge(10, 0)).toBe(0);
  });
});

describe("predatory loan math", () => {
  it("doubles principal at the default multiplier", () => {
    expect(loanTotalRepay(500, 2)).toBe(1000);
  });

  it("amortises remaining debt over minutes left", () => {
    expect(loanBleed(1000, 10)).toBe(100);
    expect(loanBleed(1000, 1)).toBe(1000);
    expect(loanBleed(0, 10)).toBe(0);
  });
});

describe("liquidation legs", () => {
  it("flattens longs with sells and shorts with buys", () => {
    const legs = liquidationLegs([
      { symbol: "A", quantity: 10 },
      { symbol: "B", quantity: -5 },
      { symbol: "C", quantity: 0 },
    ]);
    expect(legs).toEqual([
      { symbol: "A", side: "sell", quantity: 10 },
      { symbol: "B", side: "buy", quantity: 5 },
    ]);
  });
});

describe("engine bank integration", () => {
  it("issues a loan and tracks debt + free cash", () => {
    const e = makeEngine();
    e.issueLoan("alice", 500, loanTotalRepay(500, 2));
    expect(e.cashOf("alice")).toBe(10500);
    expect(e.loanDebtOf("alice")).toBe(1000);
    // free cash already nets the full repay obligation
    expect(e.freeCashOf("alice")).toBe(10500 - 1000);
  });

  it("repays loans from cash, capped at outstanding balance", () => {
    const e = makeEngine();
    e.issueLoan("alice", 500, 1000);
    const paid = e.repayLoan("alice", 400);
    expect(paid).toBe(400);
    expect(e.loanDebtOf("alice")).toBe(600);
    expect(e.cashOf("alice")).toBe(10500 - 400);
    // cannot overpay
    expect(e.repayLoan("alice", 9999)).toBe(600);
    expect(e.loanDebtOf("alice")).toBe(0);
  });

  it("charges cost of carry against held inventory", () => {
    const e = makeEngine();
    // alice buys 10 from a resting ask
    e.placeOrder({
      orderId: "mk",
      userId: "mm",
      symbol: "AERIUM",
      side: "sell",
      orderType: "limit",
      quantity: 10,
      price: 1000,
      ts: 1,
    });
    e.placeOrder({
      orderId: "tk",
      userId: "alice",
      symbol: "AERIUM",
      side: "buy",
      orderType: "limit",
      quantity: 10,
      price: 1000,
      ts: 2,
    });
    const cashBefore = e.cashOf("alice");
    const charged = e.applyCarry("alice", 1);
    expect(charged).toBe(10);
    expect(e.cashOf("alice")).toBe(cashBefore - 10);
  });

  it("generates forced-liquidation market orders that flatten the book", () => {
    const e = makeEngine();
    // Two resting sells (each within the 50 qty cap) so alice can go long 80.
    for (const [i, qty] of [40, 40].entries()) {
      e.placeOrder({
        orderId: `mk${i}`,
        userId: "mm",
        symbol: "AERIUM",
        side: "sell",
        orderType: "limit",
        quantity: qty,
        price: 1000,
        ts: 1,
      });
      e.placeOrder({
        orderId: `tk${i}`,
        userId: "alice",
        symbol: "AERIUM",
        side: "buy",
        orderType: "limit",
        quantity: qty,
        price: 1000,
        ts: 2,
      });
    }
    expect(e.absInventoryOf("alice")).toBe(80);
    // Liquidation of 80 exceeds the 50 qty cap, so it must be forced.
    const cmds = e.liquidationCommands("alice", 3);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ symbol: "AERIUM", side: "sell", force: true });
    expect(cmds[0]!.quantity).toBe(80);
    // The forced order is accepted (not rejected for exceeding the cap).
    const evts = e.placeOrder(cmds[0]!);
    expect(evts.some((ev) => ev.type === "order_update" && ev.status === "rejected")).toBe(false);
  });
});
