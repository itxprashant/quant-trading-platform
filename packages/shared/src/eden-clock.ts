/**
 * Timing of the scripted New Eden event, in game seconds from `startsAt`.
 * Browsers import this module, so it must never reference headlines, fair-value
 * effects, or OTC terms (those live in `eden-event.ts`).
 */
export const EDEN_EVENT_DURATION_MINUTES = 130;
export const EDEN_EVENT_AUCTION_MINUTES = [
  15, 30, 45, 75, 90, 105, 120,
] as const;
/** Bidding opens this many seconds before the round minute. */
export const EDEN_EVENT_AUCTION_OPEN_LEAD_SEC = 40;
/** Bidding closes (and the round resolves) this many seconds before the round minute. */
export const EDEN_EVENT_AUCTION_CLOSE_LEAD_SEC = 10;
/** Premium subscribers receive each scripted headline this many seconds early. */
export const EDEN_EVENT_PREMIUM_LEAD_SEC = 10;
/** Premium access lasts until this many minutes after the round minute. */
export const EDEN_EVENT_PREMIUM_ACCESS_MINUTES = 15;
export const EDEN_EVENT_NEWS_MINUTES = [
  5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 75, 80, 85, 90, 95, 100,
  105, 110, 115, 120, 125,
] as const;
export const EDEN_EVENT_HALFTIME_START_MINUTE = 60;
export const EDEN_EVENT_HALFTIME_END_MINUTE = 70;
export const EDEN_EVENT_OPTIONS_OPEN_MINUTE = 70;
export const EDEN_EVENT_ETF_LIST_MINUTE = 45;
export const EDEN_EVENT_ETF_WINDOW_SEC = 30;
/** Create/redeem windows every 10 minutes from the ETF listing, skipping halftime. */
export const EDEN_EVENT_ETF_WINDOW_MINUTES: readonly number[] = Array.from(
  {
    length: Math.ceil(
      (EDEN_EVENT_DURATION_MINUTES - EDEN_EVENT_ETF_LIST_MINUTE) / 10,
    ),
  },
  (_, i) => EDEN_EVENT_ETF_LIST_MINUTE + i * 10,
).filter(
  (minute) =>
    minute < EDEN_EVENT_HALFTIME_START_MINUTE ||
    minute >= EDEN_EVENT_HALFTIME_END_MINUTE,
);

/** Rehydrate structural state without replaying already-receipted financial effects. */
export function edenEventStateAt(elapsedSeconds: number) {
  if (!Number.isFinite(elapsedSeconds))
    throw new RangeError("elapsedSeconds must be finite");
  const minute = elapsedSeconds / 60;
  const phase =
    minute < 0
      ? "pending"
      : minute < EDEN_EVENT_HALFTIME_START_MINUTE
        ? "session_one"
        : minute < EDEN_EVENT_HALFTIME_END_MINUTE
          ? "halftime"
          : minute < EDEN_EVENT_DURATION_MINUTES
            ? "session_two"
            : "ended";
  return {
    phase,
    frozen: phase === "pending" || phase === "halftime" || phase === "ended",
    symbols:
      minute < 0
        ? []
        : minute < 30
          ? ["AERIUM"]
          : minute < EDEN_EVENT_ETF_LIST_MINUTE
            ? ["AERIUM", "NEURO"]
            : ["AERIUM", "NEURO", "ORBITAL"],
    bondIds:
      minute < 10
        ? []
        : minute < 18
          ? ["standard"]
          : ["standard", "aerium_pegged"],
    optionsEnabled:
      minute >= EDEN_EVENT_OPTIONS_OPEN_MINUTE &&
      minute < EDEN_EVENT_DURATION_MINUTES,
    etfWindowOpen:
      minute >= EDEN_EVENT_ETF_LIST_MINUTE &&
      minute < EDEN_EVENT_DURATION_MINUTES &&
      phase !== "halftime" &&
      (elapsedSeconds - EDEN_EVENT_ETF_LIST_MINUTE * 60) % 600 <
        EDEN_EVENT_ETF_WINDOW_SEC,
    botVolatilityMultiplier: minute >= 120 ? 3 : 1,
  } as const;
}
