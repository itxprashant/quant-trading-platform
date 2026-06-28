import { describe, expect, it } from "vitest";
import {
  bargainRejectProbability,
  etfNav,
  intrinsicValue,
  optionSymbol,
  parityResidual,
  parseOptionSymbol,
  peggedCoupon,
  proRataAssign,
  theoreticalOption,
} from "./options.js";

describe("option symbols", () => {
  it("round-trips integer strikes", () => {
    const sym = optionSymbol("AERIUM", "call", 1050);
    expect(sym).toBe("AERIUM-C-1050");
    expect(parseOptionSymbol(sym)).toEqual({
      underlying: "AERIUM",
      type: "call",
      strike: 1050,
    });
  });

  it("round-trips fractional strikes", () => {
    const sym = optionSymbol("ORB", "put", 12.5);
    expect(sym).toBe("ORB-P-12_5");
    expect(parseOptionSymbol(sym)).toEqual({
      underlying: "ORB",
      type: "put",
      strike: 12.5,
    });
  });

  it("rejects non-option symbols", () => {
    expect(parseOptionSymbol("AERIUM")).toBeNull();
  });
});

describe("intrinsic value", () => {
  it("calls pay when spot above strike", () => {
    expect(intrinsicValue("call", 110, 100)).toBe(10);
    expect(intrinsicValue("call", 90, 100)).toBe(0);
  });
  it("puts pay when spot below strike", () => {
    expect(intrinsicValue("put", 90, 100)).toBe(10);
    expect(intrinsicValue("put", 110, 100)).toBe(0);
  });
});

describe("theoretical mark", () => {
  it("adds decaying time value above intrinsic", () => {
    const early = theoreticalOption("call", 100, 100, 1, 1);
    const late = theoreticalOption("call", 100, 100, 1, 0.1);
    expect(early).toBeGreaterThan(late);
    expect(late).toBeGreaterThanOrEqual(0);
  });
});

describe("put-call parity residual", () => {
  it("is zero when arbitrage-free", () => {
    // call - put = spot - strike → 6 - 1 = 105 - 100
    expect(parityResidual(6, 1, 105, 100)).toBe(0);
  });
  it("is positive when the call is rich", () => {
    expect(parityResidual(8, 1, 105, 100)).toBe(2);
  });
});

describe("pro-rata assignment", () => {
  it("sums exactly to total via largest remainder", () => {
    const out = proRataAssign(
      [
        { id: "a", qty: 2 },
        { id: "b", qty: 1 },
        { id: "c", qty: 1 },
      ],
      3,
    );
    expect(out.reduce((s, r) => s + r.qty, 0)).toBe(3);
    // Largest holder gets the rounding remainder.
    expect(out.find((r) => r.id === "a")!.qty).toBeGreaterThanOrEqual(1);
  });

  it("caps at the available short pool", () => {
    const out = proRataAssign([{ id: "a", qty: 3 }], 10);
    expect(out.reduce((s, r) => s + r.qty, 0)).toBe(3);
  });

  it("returns nothing when there are no shorts", () => {
    expect(proRataAssign([], 5)).toEqual([]);
  });
});

describe("bargain reject probability", () => {
  it("never rejects at or above fair value", () => {
    expect(bargainRejectProbability(0)).toBe(0);
    expect(bargainRejectProbability(-0.1)).toBe(0);
  });
  it("scales with underpayment and clamps to 1", () => {
    expect(bargainRejectProbability(0.05)).toBeCloseTo(0.2);
    expect(bargainRejectProbability(0.5)).toBe(1);
  });
});

describe("etf nav", () => {
  it("weights basket spot prices", () => {
    expect(
      etfNav([
        { symbol: "A", weight: 2 },
        { symbol: "B", weight: 1 },
      ], { A: 10, B: 5 }),
    ).toBe(25);
  });
  it("treats missing prices as zero", () => {
    expect(etfNav([{ symbol: "A", weight: 1 }], {})).toBe(0);
  });
});

describe("pegged coupon", () => {
  it("pays more as price falls below base", () => {
    expect(peggedCoupon(100, 80, 10)).toBe(2);
  });
  it("guards against zero divisor", () => {
    expect(peggedCoupon(100, 80, 0)).toBe(0);
  });
});
