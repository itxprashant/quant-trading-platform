import { describe, expect, it } from "vitest";
import { formatBackupCsv, parseBackupCsv } from "@qtp/shared";

describe("backup CSV", () => {
  const sample = {
    version: 1,
    challengeId: "11111111-1111-4111-8111-111111111111",
    challengeSlug: "new-eden-exchange",
    exportedAt: "2026-09-25T00:00:00.000Z",
    accounts: [
      {
        username: "trader, one",
        userId: "00000000-0000-4000-a000-000000000001",
        cash: 12_500.5,
        loanDebt: 80,
        positions: [
          { symbol: "AERIUM", quantity: 3, avgPrice: 1000.25 },
          { symbol: "NEURO", quantity: -2, avgPrice: 500 },
        ],
        bonds: [
          {
            bondId: "standard",
            name: "Standard Bond",
            quantity: 1,
            price: 4000,
            faceValue: 8000,
            couponsPaid: 200,
          },
        ],
      },
    ],
  };

  it("round-trips cash, inventory, loan debt, and bonds", () => {
    const parsed = parseBackupCsv(formatBackupCsv(sample));
    expect(parsed).toMatchObject({
      version: 1,
      challengeId: sample.challengeId,
      challengeSlug: sample.challengeSlug,
      accounts: [
        {
          username: "trader, one",
          userId: sample.accounts[0]!.userId,
          cash: 12_500.5,
          loanDebt: 80,
          positions: sample.accounts[0]!.positions,
          bonds: sample.accounts[0]!.bonds,
        },
      ],
    });
  });

  it("rejects a file without a type column", () => {
    expect(() => parseBackupCsv("username,cash\ntrader1,10\n")).toThrow(
      "missing_type_column",
    );
  });
});
