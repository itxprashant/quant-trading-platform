import { describe, expect, it } from "vitest";
import {
  EDEN_EVENT_ACTIONS,
  EDEN_EVENT_NEWS,
} from "../../shared/src/eden-event.js";
import {
  EDEN_EVENT_AUCTION_CLOSE_LEAD_SEC,
  EDEN_EVENT_AUCTION_MINUTES,
  EDEN_EVENT_AUCTION_OPEN_LEAD_SEC,
  EDEN_EVENT_DURATION_MINUTES,
  EDEN_EVENT_ETF_LIST_MINUTE,
  EDEN_EVENT_ETF_WINDOW_MINUTES,
  EDEN_EVENT_ETF_WINDOW_SEC,
  EDEN_EVENT_HALFTIME_END_MINUTE,
  EDEN_EVENT_HALFTIME_START_MINUTE,
  EDEN_EVENT_NEWS_MINUTES,
  EDEN_EVENT_OPTIONS_OPEN_MINUTE,
  EDEN_EVENT_PREMIUM_ACCESS_MINUTES,
  EDEN_EVENT_PREMIUM_LEAD_SEC,
} from "../../shared/src/eden-clock.js";

// The browser timers read eden-clock (no headlines); the engine runs the
// action list. They must describe the same schedule.
const of = <K extends (typeof EDEN_EVENT_ACTIONS)[number]["kind"]>(kind: K) =>
  EDEN_EVENT_ACTIONS.filter(
    (a): a is Extract<(typeof EDEN_EVENT_ACTIONS)[number], { kind: K }> =>
      a.kind === kind,
  );

describe("eden-clock matches the scripted action list", () => {
  it("auction rounds open, close and grant premium on the clock constants", () => {
    const opens = of("auction_open");
    expect(opens.map((a) => a.roundMinute)).toEqual([
      ...EDEN_EVENT_AUCTION_MINUTES,
    ]);
    for (const a of opens) {
      const minute = a.roundMinute * 60;
      expect(a.atSecond).toBe(minute - EDEN_EVENT_AUCTION_OPEN_LEAD_SEC);
      expect(a.closesAtSecond).toBe(minute - EDEN_EVENT_AUCTION_CLOSE_LEAD_SEC);
      expect(a.premiumUntilSecond).toBe(
        a.closesAtSecond + EDEN_EVENT_PREMIUM_ACCESS_MINUTES * 60,
      );
    }
    expect(of("auction_resolve").map((a) => a.atSecond)).toEqual(
      opens.map((a) => a.closesAtSecond),
    );
  });

  it("news releases land on the clock minutes with the premium lead", () => {
    expect(EDEN_EVENT_NEWS.map((n) => n.minute)).toEqual([
      ...EDEN_EVENT_NEWS_MINUTES,
    ]);
    const publicAt = of("news")
      .filter((a) => a.id.endsWith("/public"))
      .map((a) => a.atSecond);
    const premiumAt = of("news")
      .filter((a) => a.id.endsWith("/premium"))
      .map((a) => a.atSecond);
    expect(publicAt).toEqual(EDEN_EVENT_NEWS_MINUTES.map((m) => m * 60));
    expect(premiumAt).toEqual(
      EDEN_EVENT_NEWS_MINUTES.map((m) => m * 60 - EDEN_EVENT_PREMIUM_LEAD_SEC),
    );
  });

  it("ETF windows, halftime, options and the final halt share the clock", () => {
    const windows = of("etf_window");
    expect(windows.filter((a) => a.open).map((a) => a.atSecond)).toEqual(
      EDEN_EVENT_ETF_WINDOW_MINUTES.map((m) => m * 60),
    );
    expect(windows.filter((a) => !a.open).map((a) => a.atSecond)).toEqual(
      EDEN_EVENT_ETF_WINDOW_MINUTES.map(
        (m) => m * 60 + EDEN_EVENT_ETF_WINDOW_SEC,
      ),
    );
    expect(of("list_etf")[0]?.atSecond).toBe(EDEN_EVENT_ETF_LIST_MINUTE * 60);
    expect(of("freeze")[0]?.atSecond).toBe(
      EDEN_EVENT_HALFTIME_START_MINUTE * 60,
    );
    expect(of("unfreeze")[0]?.atSecond).toBe(
      EDEN_EVENT_HALFTIME_END_MINUTE * 60,
    );
    expect(of("options_open")[0]?.atSecond).toBe(
      EDEN_EVENT_OPTIONS_OPEN_MINUTE * 60,
    );
    expect(of("end")[0]?.atSecond).toBe(EDEN_EVENT_DURATION_MINUTES * 60);
  });
});
