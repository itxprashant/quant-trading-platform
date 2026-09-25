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
/** New bank loans are refused in the last this many game minutes. */
export const EDEN_LOAN_LOCKOUT_MINUTES = 10;
export const EDEN_EVENT_ETF_LIST_MINUTE = 45;
export const EDEN_EVENT_ETF_WINDOW_SEC = 30;
/** Create/redeem windows every 10 game minutes from the ETF listing, skipping halftime. */
export const EDEN_EVENT_ETF_WINDOW_INTERVAL_MINUTES = 10;
/** Create/redeem windows every 10 minutes from the ETF listing, skipping halftime. */
export const EDEN_EVENT_ETF_WINDOW_MINUTES: readonly number[] = Array.from(
  {
    length: Math.ceil(
      (EDEN_EVENT_DURATION_MINUTES - EDEN_EVENT_ETF_LIST_MINUTE) /
        EDEN_EVENT_ETF_WINDOW_INTERVAL_MINUTES,
    ),
  },
  (_, i) =>
    EDEN_EVENT_ETF_LIST_MINUTE + i * EDEN_EVENT_ETF_WINDOW_INTERVAL_MINUTES,
).filter(
  (minute) =>
    minute < EDEN_EVENT_HALFTIME_START_MINUTE ||
    minute >= EDEN_EVENT_HALFTIME_END_MINUTE,
);

/** Wall ms a create/redeem window stays open (scales with the game minute). */
export function edenEtfWindowMs(minuteMs: number): number {
  return (EDEN_EVENT_ETF_WINDOW_SEC * minuteMs) / 60;
}

/** Wall ms between create/redeem windows (10 game minutes). */
export function edenEtfWindowIntervalMs(minuteMs: number): number {
  return minuteMs * EDEN_EVENT_ETF_WINDOW_INTERVAL_MINUTES;
}

/** Live window clock the engine publishes for cue/host navbar timers. */
export type EtfWindowClock = {
  open: boolean;
  closesAt: string | null;
  nextOpensAt: string | null;
};

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

function epochMs(value: Date | string | number | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

/**
 * Wall milliseconds of remaining session that still allow a new loan.
 * Scripted / cue events scale from `startsAt`→`endsAt` so accelerated dry
 * runs lock out the last 10 game minutes, not 10 wall minutes.
 */
export function edenLoanLockoutMs(
  startsAt: Date | string | number | null | undefined,
  endsAt: Date | string | number | null | undefined,
  scheduledClock: boolean,
): number {
  const start = epochMs(startsAt);
  const end = epochMs(endsAt);
  if (
    scheduledClock &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start
  ) {
    return (
      EDEN_LOAN_LOCKOUT_MINUTES *
      ((end - start) / EDEN_EVENT_DURATION_MINUTES)
    );
  }
  return EDEN_LOAN_LOCKOUT_MINUTES * 60_000;
}

/** True when a live session is inside the last-10-minute loan lockout. */
export function edenLoansClosed(
  now: number,
  endsAt: Date | string | number | null | undefined,
  startsAt?: Date | string | number | null,
  scheduledClock = false,
): boolean {
  const end = epochMs(endsAt);
  if (!Number.isFinite(end) || end <= now) return false;
  return end - now <= edenLoanLockoutMs(startsAt, endsAt, scheduledClock);
}
