import { describe, expect, it } from "vitest";
import { resolveAuction } from "./auction.js";
import { grantWinner, tallyVote, wealthTaxTransfers } from "./policy.js";

describe("resolveAuction", () => {
  it("returns no winners when nobody bids", () => {
    expect(resolveAuction([], 0.3)).toEqual({ winners: [], cutoff: null });
  });

  it("ignores non-positive bids", () => {
    const r = resolveAuction(
      [
        { userId: "a", amount: 0 },
        { userId: "b", amount: -5 },
        { userId: "c", amount: NaN },
        { userId: "d", amount: Infinity },
      ],
      0.3,
    );
    expect(r).toEqual({ winners: [], cutoff: null });
  });

  it("selects the top fraction and publishes the cutoff", () => {
    const r = resolveAuction(
      [
        { userId: "a", amount: 100 },
        { userId: "b", amount: 80 },
        { userId: "c", amount: 60 },
        { userId: "d", amount: 40 },
        { userId: "e", amount: 20 },
      ],
      0.4,
    );
    // round(5 * 0.4) = 2 winners; cutoff = 80.
    expect(r.winners.sort()).toEqual(["a", "b"]);
    expect(r.cutoff).toBe(80);
  });

  it("always grants at least one winner when bids exist", () => {
    const r = resolveAuction([{ userId: "a", amount: 10 }], 0.0001);
    expect(r.winners).toEqual(["a"]);
    expect(r.cutoff).toBe(10);
  });

  it("breaks cutoff ties by user id without enlarging the cohort", () => {
    const r = resolveAuction(
      [
        { userId: "c", amount: 50 },
        { userId: "b", amount: 50 },
        { userId: "a", amount: 50 },
        { userId: "d", amount: 10 },
      ],
      0.25,
    );
    expect(r.winners).toEqual(["a"]);
    expect(r.cutoff).toBe(50);
  });

  it("awards exactly the rounded top thirty percent independent of input order", () => {
    for (let n = 1; n <= 20; n++) {
      const bids = Array.from({ length: n }, (_, i) => ({
        userId: String(i).padStart(2, "0"),
        amount: 100,
      }));
      const result = resolveAuction(bids, 0.3);
      expect(result.winners).toHaveLength(Math.round(Math.max(1, n * 0.3)));
      expect(resolveAuction([...bids].reverse(), 0.3)).toEqual(result);
    }
  });
});

describe("tallyVote", () => {
  it("passes on a strict majority", () => {
    expect(tallyVote(["yes", "yes", "no"])).toEqual({
      yes: 2,
      no: 1,
      passed: true,
    });
  });
  it("fails on a tie", () => {
    expect(tallyVote(["yes", "no"])).toEqual({ yes: 1, no: 1, passed: false });
  });
  it("fails with no votes", () => {
    expect(tallyVote([])).toEqual({ yes: 0, no: 0, passed: false });
  });
});

describe("wealthTaxTransfers", () => {
  it("applies the event's fifteen percent tax to the top decile", () => {
    const accounts = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      cash: (i + 1) * 100,
    }));
    const result = wealthTaxTransfers(accounts, 0.15, 0.1, 0.2);
    expect(result.redistributed).toBeCloseTo(150);
    expect(result.deltas.find((d) => d.id === "9")?.delta).toBeCloseTo(-150);
    expect(result.deltas.find((d) => d.id === "0")?.delta).toBeCloseTo(75);
    expect(result.deltas.find((d) => d.id === "1")?.delta).toBeCloseTo(75);
    expect(result.deltas.reduce((sum, d) => sum + d.delta, 0)).toBeCloseTo(0);
  });

  it("moves cash from top to bottom and conserves total", () => {
    const accounts = [
      { id: "rich1", cash: 1000 },
      { id: "rich2", cash: 800 },
      { id: "mid", cash: 500 },
      { id: "poor1", cash: 200 },
      { id: "poor2", cash: 100 },
    ];
    const r = wealthTaxTransfers(accounts, 0.1, 0.2, 0.4);
    // top 20% of 5 = 1 → rich1 taxed 100. bottom 40% = 2 → poor1/poor2 split 50/50.
    expect(r.redistributed).toBeCloseTo(100);
    const sum = r.deltas.reduce((s, d) => s + d.delta, 0);
    expect(sum).toBeCloseTo(0);
    expect(r.deltas.find((d) => d.id === "rich1")!.delta).toBeCloseTo(-100);
    expect(r.deltas.find((d) => d.id === "poor1")!.delta).toBeCloseTo(50);
  });

  it("does nothing at zero rate", () => {
    const r = wealthTaxTransfers([{ id: "a", cash: 100 }], 0, 0.5, 0.5);
    expect(r).toEqual({ deltas: [], redistributed: 0 });
  });

  it("skips non-positive cash in the top bracket", () => {
    const r = wealthTaxTransfers(
      [
        { id: "a", cash: -50 },
        { id: "b", cash: -100 },
      ],
      0.1,
      0.5,
      0.5,
    );
    expect(r.redistributed).toBe(0);
  });
});

describe("grantWinner", () => {
  it("picks the largest holder", () => {
    expect(
      grantWinner([
        { id: "a", qty: 5 },
        { id: "b", qty: 12 },
        { id: "c", qty: 3 },
      ]),
    ).toBe("b");
  });
  it("returns null when nobody holds a positive position", () => {
    expect(
      grantWinner([
        { id: "a", qty: 0 },
        { id: "b", qty: -2 },
      ]),
    ).toBeNull();
  });
});
