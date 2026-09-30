import { describe, expect, it } from "vitest";
import {
  EDEN_LOAN_LIMIT,
  edenLoanOutstanding,
  edenLoanRepayMultiplier,
  edenLoanTotalRepay,
} from "../../shared/src/eden-clock.js";

describe("loan repay multiplier", () => {
  it("reads config and defaults to 2×", () => {
    expect(edenLoanRepayMultiplier(undefined)).toBe(2);
    expect(edenLoanRepayMultiplier({ rules: { loanRepayMultiplier: 1.5 } })).toBe(
      1.5,
    );
    expect(edenLoanTotalRepay(10_000, { rules: { loanRepayMultiplier: 1.5 } })).toBe(
      15_000,
    );
  });
});

describe("loan limit", () => {
  it("caps each trader at 500,000 of outstanding principal", () => {
    expect(EDEN_LOAN_LIMIT).toBe(500_000);
    expect(
      edenLoanOutstanding([
        { principal: 400_000, totalRepay: 800_000, remaining: 800_000 },
        { principal: 100_000, totalRepay: 200_000, remaining: 100_000 },
      ]),
    ).toBe(450_000);
    expect(
      edenLoanOutstanding([
        { principal: 500_000, totalRepay: 1_000_000, remaining: 0 },
      ]),
    ).toBe(0);
  });
});
