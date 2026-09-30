import assert from "node:assert/strict";
import { test } from "vitest";
import type { Auction, OptionContract } from "@qtp/shared";
import {
  EDEN_EVENT_DURATION_MINUTES,
  EDEN_EVENT_ETF_WINDOW_MINUTES,
  EDEN_EVENT_HALFTIME_END_MINUTE,
  EDEN_EVENT_NEWS_MINUTES,
  EDEN_EVENT_OPTIONS_OPEN_MINUTE,
} from "@qtp/shared";
import {
  edenSecondMs,
  eventProgress,
  eventTimers,
  loanPayment,
  optionPhase,
  otcBargainCounterFromUnitPrice,
  otcChoiceLeg,
  otcNetCash,
  type EventTimerInput,
} from "./eden";

const START = 1_000_000;

/** Scripted event where one game minute takes `minuteMs` wall ms. */
function scriptedAt(
  minute: number,
  minuteMs = 60_000,
  overrides: Partial<EventTimerInput> = {},
): EventTimerInput {
  return {
    now: START + minute * minuteMs,
    status:
      minute < 0
        ? "scheduled"
        : minute >= EDEN_EVENT_DURATION_MINUTES
          ? "ended"
          : "live",
    startsAt: new Date(START).toISOString(),
    endsAt: new Date(START + EDEN_EVENT_DURATION_MINUTES * minuteMs).toISOString(),
    scripted: true,
    auction: null,
    contracts: [],
    exerciseWindowSec: 15,
    premium: false,
    ...overrides,
  };
}

function timer(input: EventTimerInput, id: string) {
  return eventTimers(input).find((t) => t.id === id);
}

test("game clock scale is derived from the scripted start and end", () => {
  const startsAt = new Date(START).toISOString();
  const end = (minuteMs: number) =>
    new Date(START + EDEN_EVENT_DURATION_MINUTES * minuteMs).toISOString();
  assert.equal(edenSecondMs(startsAt, end(60_000), true), 1000);
  assert.equal(edenSecondMs(startsAt, end(6000), true), 100);
  assert.equal(edenSecondMs(startsAt, end(6000), false), 1000);
  assert.equal(edenSecondMs(null, end(6000), true), 1000);
  assert.equal(edenSecondMs(startsAt, startsAt, true), 1000);
  assert.equal(eventProgress(startsAt, START + 90 * 6000, 100)?.phase, "halftime");
  assert.equal(
    eventProgress(
      startsAt,
      START + EDEN_EVENT_HALFTIME_END_MINUTE * 6000,
      100,
    )?.phase,
    "session_two",
  );
});

test("scripted timers follow the schedule at real and accelerated clocks", () => {
  for (const minuteMs of [60_000, 6000]) {
    const at = (minute: number) => START + minute * minuteMs;
    const pending = scriptedAt(-1, minuteMs);
    assert.deepEqual(
      eventTimers(pending).map((t) => [t.id, t.label, t.target]),
      [
        ["event", "Opens in", at(0)],
        ["auction", "Next auction", at(13)],
        ["options", "Options open", at(EDEN_EVENT_OPTIONS_OPEN_MINUTE)],
        ["etf", "Next ETF window", at(67)],
        ["news", "Next news", at(1)],
      ],
    );

    const session = scriptedAt(13.25, minuteMs);
    assert.equal(timer(session, "event")?.label, "Session 1");
    assert.equal(
      timer(session, "event")?.target,
      at(EDEN_EVENT_DURATION_MINUTES),
    );
    assert.equal(timer(session, "auction")?.label, "Auction");
    assert.equal(timer(session, "auction")?.target, at(13.5));
    assert.equal(timer(session, "auction")?.tone, "warning");

    const halftime = scriptedAt(95, minuteMs);
    assert.equal(timer(halftime, "event")?.label, "Halftime");
    assert.equal(
      timer(halftime, "event")?.target,
      at(EDEN_EVENT_HALFTIME_END_MINUTE),
    );
    assert.equal(timer(halftime, "event")?.tone, "warning");
    assert.equal(
      timer(halftime, "news")?.target,
      at(EDEN_EVENT_OPTIONS_OPEN_MINUTE),
    );
    const early = timer({ ...halftime, premium: true }, "news");
    assert.equal(
      early?.target,
      at(EDEN_EVENT_OPTIONS_OPEN_MINUTE - 10 / 60),
    );
    assert.equal(early?.hint, "Early");

    const etf = scriptedAt(67 + 25 / 60, minuteMs);
    assert.equal(timer(etf, "etf")?.label, "ETF window");
    assert.equal(timer(etf, "etf")?.target, at(67.5));
    assert.equal(timer(etf, "etf")?.tone, "active");

    const lastNews = EDEN_EVENT_NEWS_MINUTES.at(-1)!;
    const lastEtf = EDEN_EVENT_ETF_WINDOW_MINUTES.at(-1)!;
    assert.equal(
      timer(scriptedAt(lastNews - 1, minuteMs), "news")?.target,
      at(lastNews),
    );
    assert.equal(
      timer(scriptedAt(lastEtf - 0.4, minuteMs), "etf")?.target,
      at(lastEtf),
    );
    assert.equal(timer(scriptedAt(lastNews, minuteMs), "news"), undefined);
    assert.equal(
      timer(scriptedAt(lastEtf, minuteMs), "etf")?.target,
      at(lastEtf + 0.5),
    );
    assert.equal(timer(scriptedAt(lastEtf + 1, minuteMs), "etf"), undefined);
  }
});

test("timers turn warning inside ten seconds and collapse once ended", () => {
  const nearNews = scriptedAt(2 - 8 / 60);
  assert.equal(timer(nearNews, "news")?.tone, "warning");
  assert.equal(timer(scriptedAt(1), "news")?.tone, "neutral");
  assert.deepEqual(
    eventTimers(scriptedAt(EDEN_EVENT_DURATION_MINUTES + 1)).map((t) => [
      t.id,
      t.text,
    ]),
    [["event", "Ended"]],
  );
});

test("live auctions and option cycles override schedule-derived timers", () => {
  const now = START + 20 * 60_000;
  const auction: Auction = {
    id: "a",
    challengeId: "c",
    status: "open",
    expiresAt: new Date(now + 25_000).toISOString(),
    cutoff: null,
    createdAt: new Date(now - 5000).toISOString(),
  };
  const live = scriptedAt(20, 60_000, { auction });
  assert.equal(timer(live, "auction")?.target, now + 25_000);
  assert.equal(timer(live, "auction")?.suffix, "to close");
  assert.equal(
    timer(
      scriptedAt(20, 60_000, {
        auction: { ...auction, expiresAt: new Date(now).toISOString() },
      }),
      "auction",
    )?.text,
    "Allocating",
  );

  const contract: OptionContract = {
    symbol: "AERIUM-C-1000",
    underlying: "AERIUM",
    optionType: "call",
    strike: 1000,
    cycleId: "cycle",
    expiresAt: new Date(now + 60_000).toISOString(),
    status: "open",
  };
  const trading = scriptedAt(20, 60_000, { contracts: [contract] });
  assert.equal(timer(trading, "options")?.label, "Options expiry");
  assert.equal(timer(trading, "options")?.target, now + 60_000);
  const window = scriptedAt(20, 60_000, {
    contracts: [
      {
        ...contract,
        status: "exercise_window",
        expiresAt: new Date(now - 5000).toISOString(),
      },
    ],
  });
  assert.equal(timer(window, "options")?.label, "Exercise");
  assert.equal(timer(window, "options")?.target, now + 10_000);
  assert.equal(timer(window, "options")?.tone, "warning");
});

test("unscripted challenges only show the session clock", () => {
  const base = scriptedAt(10, 60_000, { scripted: false });
  assert.deepEqual(
    eventTimers(base).map((t) => [t.id, t.label]),
    [["event", "Ends in"]],
  );
  const openAt = START + 10 * 60_000;
  const live = eventTimers({
    ...base,
    etfWindow: {
      open: true,
      closesAt: new Date(openAt + 30_000).toISOString(),
      nextOpensAt: new Date(openAt + 600_000).toISOString(),
    },
  }).find((t) => t.id === "etf");
  assert.equal(live?.label, "ETF window");
  assert.equal(live?.target, openAt + 30_000);
  assert.equal(live?.tone, "active");
  const next = eventTimers({
    ...base,
    now: openAt + 40_000,
    etfWindow: {
      open: false,
      closesAt: null,
      nextOpensAt: new Date(openAt + 600_000).toISOString(),
    },
  }).find((t) => t.id === "etf");
  assert.equal(next?.label, "Next ETF window");
  assert.equal(next?.target, openAt + 600_000);
  assert.deepEqual(
    eventTimers({ ...base, endsAt: null }).map((t) => [t.id, t.text]),
    [["event", "Live"]],
  );
  assert.deepEqual(
    eventTimers({
      ...base,
      status: "draft",
      startsAt: null,
      endsAt: null,
    }),
    [],
  );
});

test("event phases follow real minutes from the persisted start and end at 210", () => {
  const startsAt = new Date(1_000_000).toISOString();
  const at = (minutes: number) =>
    eventProgress(startsAt, 1_000_000 + minutes * 60000);
  assert.equal(at(-1)?.phase, "pending");
  assert.equal(at(-1)?.elapsedSeconds, 0);
  assert.equal(at(0)?.phase, "session_one");
  assert.equal(at(89.999)?.phase, "session_one");
  assert.equal(at(90)?.phase, "halftime");
  assert.equal(at(EDEN_EVENT_HALFTIME_END_MINUTE)?.phase, "session_two");
  assert.equal(at(EDEN_EVENT_DURATION_MINUTES - 0.001)?.phase, "session_two");
  assert.equal(at(EDEN_EVENT_DURATION_MINUTES)?.phase, "ended");
  assert.equal(
    at(EDEN_EVENT_DURATION_MINUTES + 10)?.elapsedSeconds,
    EDEN_EVENT_DURATION_MINUTES * 60,
  );
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

test("bargain unit price converts to the cash counter the API expects", () => {
  assert.equal(
    otcBargainCounterFromUnitPrice(
      { symbol: "AERIUM", quantity: 50, price: 988 },
      968,
    ),
    1000,
  );
  assert.equal(
    otcBargainCounterFromUnitPrice(
      { symbol: "AERIUM", quantity: -40, price: 1046.4 },
      1096.4,
    ),
    2000,
  );
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
