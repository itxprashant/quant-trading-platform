import assert from "node:assert/strict";
import { test } from "vitest";
import type { OptionContract } from "@qtp/shared";
import {
  eventProgress,
  loanPayment,
  optionPhase,
  otcChoiceLeg,
  otcNetCash,
} from "./eden";

test("event phases follow real minutes from the persisted start and end at 130", () => {
  const startsAt = new Date(1_000_000).toISOString();
  const at = (minutes: number) =>
    eventProgress(startsAt, 1_000_000 + minutes * 60000);
  assert.equal(at(-1)?.phase, "pending");
  assert.equal(at(-1)?.elapsedSeconds, 0);
  assert.equal(at(0)?.phase, "session_one");
  assert.equal(at(59.999)?.phase, "session_one");
  assert.equal(at(60)?.phase, "halftime");
  assert.equal(at(70)?.phase, "session_two");
  assert.equal(at(129.999)?.phase, "session_two");
  assert.equal(at(130)?.phase, "ended");
  assert.equal(at(140)?.elapsedSeconds, 130 * 60);
  assert.equal(eventProgress(null, 0), null);
  assert.equal(eventProgress("invalid", 0), null);
});

test("bailout choices preserve the host price and enforce signed quantity limits", () => {
  const choices = [
    { symbol: "AERIUM", quantity: -50, price: 900 },
    { symbol: "NEURO", quantity: -3, price: 450 },
  ];
  const leg = otcChoiceLeg(choices, "AERIUM", 20);
  assert.deepEqual(leg, { symbol: "AERIUM", quantity: -20, price: 900 });
  assert.equal(otcNetCash(0, [leg!]), 18000);
  assert.equal(otcChoiceLeg(choices, "NEURO", 3)?.quantity, -3);
  for (const quantity of [0, -1, 1.5, 4, NaN, Infinity]) {
    assert.equal(otcChoiceLeg(choices, "NEURO", quantity), null);
  }
  assert.equal(otcChoiceLeg(choices, "UNKNOWN", 1), null);
  assert.equal(otcChoiceLeg([], "AERIUM", 1), null);
  assert.equal(choices[0]?.quantity, -50);
});

test("OTC cash includes signed leg notional and a cash adjustment", () => {
  assert.equal(
    otcNetCash(0, [{ symbol: "AERIUM", quantity: 50, price: 950 }]),
    -47500,
  );
  assert.equal(
    otcNetCash(100, [
      { symbol: "AERIUM", quantity: -20, price: 1000 },
      { symbol: "NEURO", quantity: 20, price: 500 },
    ]),
    10100,
  );
  assert.equal(
    otcNetCash(0, [
      { symbol: "AERIUM", quantity: -20, price: 0 },
      { symbol: "NEURO", quantity: 20, price: 0 },
    ]),
    0,
  );
});

test("option trading closes at expiry even with stale open status", () => {
  const contract: OptionContract = {
    symbol: "AERIUM-C-1000",
    underlying: "AERIUM",
    optionType: "call",
    strike: 1000,
    cycleId: "cycle",
    expiresAt: new Date(100000).toISOString(),
    status: "open",
  };
  assert.equal(optionPhase(contract, 15, 99999).tradable, true);
  assert.equal(optionPhase(contract, 15, 100000).tradable, false);
  assert.equal(optionPhase(contract, 15, 100000).exercisable, false);
  contract.status = "exercise_window";
  assert.equal(optionPhase(contract, 15, 99999).exercisable, false);
  assert.equal(optionPhase(contract, 15, 100000).exercisable, true);
  assert.equal(optionPhase(contract, 15, 114999).exercisable, true);
  assert.equal(optionPhase(contract, 15, 115000).exercisable, false);
  contract.status = "expired";
  assert.equal(optionPhase(contract, 15, 110000).exercisable, false);
});

test("loan estimate divides total repayment by fixed remaining minute count", () => {
  assert.equal(
    loanPayment(20000, 2, new Date(3600000).toISOString(), 0),
    40000 / 60,
  );
  assert.equal(loanPayment(100, 2, new Date(60001).toISOString(), 0), 100);
  assert.equal(loanPayment(100, 2, new Date(1).toISOString(), 0), 200);
  assert.equal(loanPayment(100, 2, null, 0), null);
  assert.equal(loanPayment(100, 2, "invalid", 0), null);
  assert.equal(loanPayment(100, 2, new Date(0).toISOString(), 0), null);
});
