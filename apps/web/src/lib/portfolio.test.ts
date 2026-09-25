import { describe, expect, it } from "vitest";
import type { Portfolio } from "@qtp/shared";
import { applyPortfolioUpdate } from "./portfolio";

const base: Pick<
  Portfolio,
  "challengeId" | "cash" | "positions" | "pnl" | "score"
> = {
  challengeId: "00000000-0000-4000-a000-000000000001",
  cash: 1000,
  positions: [],
  pnl: 0,
  score: 0,
};

const bond = {
  bondId: "standard",
  name: "Standard Bond",
  quantity: 1,
  price: 10000,
  faceValue: 20000,
  couponsPaid: 0,
};

describe("applyPortfolioUpdate", () => {
  it("keeps bonds and their mark when a live snapshot omits them", () => {
    const prev: Portfolio = {
      ...base,
      marketValue: 10124,
      bonds: [bond],
    };
    const next: Portfolio = {
      ...base,
      marketValue: -1124,
    };
    const merged = applyPortfolioUpdate(prev, next);
    expect(merged.bonds).toEqual([bond]);
    expect(merged.marketValue).toBe(-1124 + 10000);
  });

  it("does not double-count when the snapshot already includes bonds", () => {
    const prev: Portfolio = {
      ...base,
      marketValue: 10124,
      bonds: [bond],
    };
    const next: Portfolio = {
      ...base,
      marketValue: 10124,
      bonds: [{ ...bond, couponsPaid: 2000 }],
    };
    const merged = applyPortfolioUpdate(prev, next);
    expect(merged.bonds?.[0]?.couponsPaid).toBe(2000);
    expect(merged.marketValue).toBe(10124);
  });
});
