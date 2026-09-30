/**
 * Timing of the scripted New Eden event, in game seconds from `startsAt`.
 * Browsers import this module, so it must never reference headlines, fair-value
 * effects, or OTC terms (those live in `eden-event.ts`).
 *
 * The playbook (`eden_v2.md`) numbers two 90-minute halves (TM 0–90, TM 91–180)
 * with a paused 30-minute break. The engine clock is linear, so that break is
 * minutes 90–120 and every playbook minute after 90 is shifted +30. Wall length
 * is therefore 210 game minutes.
 */
export const EDEN_EVENT_DURATION_MINUTES = 210;
export const EDEN_EVENT_HALFTIME_START_MINUTE = 90;
export const EDEN_EVENT_HALFTIME_END_MINUTE = 120;
export const EDEN_EVENT_HALFTIME_DURATION_MINUTES = 30;

/** Map a playbook TM (0–180, clock paused at 90) onto the linear engine clock. */
export function edenPlaybookToGameMinute(playbookMinute: number): number {
  return playbookMinute <= EDEN_EVENT_HALFTIME_START_MINUTE
    ? playbookMinute
    : playbookMinute + EDEN_EVENT_HALFTIME_DURATION_MINUTES;
}

export const EDEN_EVENT_OPTIONS_OPEN_MINUTE = edenPlaybookToGameMinute(91);
export const EDEN_EVENT_NEURO_LIST_MINUTE = 36;
export const EDEN_EVENT_ETF_LIST_MINUTE = 60;
export const EDEN_EVENT_SHOCK_MINUTE = edenPlaybookToGameMinute(137);
export const EDEN_EVENT_VOTE_MINUTE = edenPlaybookToGameMinute(124);
export const EDEN_EVENT_GRANT_OPEN_MINUTE = edenPlaybookToGameMinute(147);
export const EDEN_EVENT_GRANT_AWARD_MINUTE = edenPlaybookToGameMinute(157);
export const EDEN_EVENT_SQUEEZE_MINUTE = edenPlaybookToGameMinute(172);
export const EDEN_EVENT_BOND_MINUTES = [16, 24] as const;
const EDEN_EVENT_AUCTION_PLAYBOOK_MINUTES = [
  13, 28, 43, 58, 70, 82, 99, 114, 129, 144, 159, 174,
] as const;
export const EDEN_EVENT_AUCTION_MINUTES =
  EDEN_EVENT_AUCTION_PLAYBOOK_MINUTES.map(edenPlaybookToGameMinute);
/** Bidding opens on the auction minute. */
export const EDEN_EVENT_AUCTION_OPEN_LEAD_SEC = 0;
/** Sealed bidding lasts this many seconds after the auction minute. */
export const EDEN_EVENT_AUCTION_DURATION_SEC = 30;
/** Premium subscribers receive each scripted headline this many seconds early. */
export const EDEN_EVENT_PREMIUM_LEAD_SEC = 10;
/** Fallback premium-access length when no later auction exists. */
export const EDEN_EVENT_PREMIUM_ACCESS_MINUTES = 15;
const EDEN_EVENT_NEWS_PLAYBOOK_MINUTES = [
  1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 14, 15, 17, 18, 19, 21, 22, 23, 25, 26,
  27, 29, 30, 31, 32, 33, 34, 36, 37, 38, 39, 40, 41, 42, 44, 46, 47, 48, 49, 51,
  52, 53, 54, 55, 56, 57, 59, 60, 61, 62, 63, 64, 66, 68, 69, 71, 72, 73, 74, 75,
  76, 79, 80, 81, 83, 84, 85, 86, 88, 89, 90, 91, 94, 95, 97, 98, 100, 102, 104,
  105, 108, 109, 110, 112, 115, 118, 119, 120, 122, 124, 125, 128, 130, 132, 134,
  135, 137, 138, 140, 142, 145, 147, 148, 149, 150, 154, 155, 157, 158, 160, 162,
  164, 165, 168, 169, 170, 172, 175, 177, 178, 179,
] as const;
export const EDEN_EVENT_NEWS_MINUTES = EDEN_EVENT_NEWS_PLAYBOOK_MINUTES.map(
  edenPlaybookToGameMinute,
);
/** New bank loans are refused in the last this many game minutes. */
export const EDEN_LOAN_LOCKOUT_MINUTES = 10;
/** Most principal one trader may still have outstanding, across every open loan. */
export const EDEN_LOAN_LIMIT = 500_000;

/** Challenge-configured loan repay multiple; matches `zEdenRules` default. */
export function edenLoanRepayMultiplier(
  eden?: { rules?: { loanRepayMultiplier?: number } } | null,
): number {
  const m = eden?.rules?.loanRepayMultiplier;
  return Number.isFinite(m) && m >= 1 ? m : 2;
}

export function edenLoanTotalRepay(
  principal: number,
  eden?: { rules?: { loanRepayMultiplier?: number } } | null,
): number {
  return principal * edenLoanRepayMultiplier(eden);
}

/** Principal still drawn on open loans. Repaid fractions free the limit. */
export function edenLoanOutstanding(
  rows: readonly {
    principal: number;
    totalRepay: number;
    remaining: number;
  }[],
): number {
  return rows.reduce((sum, loan) => {
    if (!(loan.principal > 0) || !(loan.totalRepay > 0) || !(loan.remaining > 0))
      return sum;
    return sum + (loan.principal * loan.remaining) / loan.totalRepay;
  }, 0);
}

export const EDEN_EVENT_ETF_WINDOW_SEC = 30;
/** Create/redeem windows every 10 game minutes from the ETF listing, skipping halftime. */
export const EDEN_EVENT_ETF_WINDOW_INTERVAL_MINUTES = 10;
/**
 * Scripted create/redeem minutes. Half 1 is 67/77/87; after the break the
 * cadence is playbook 93, 103, … 173 → game 123, 133, … 203.
 */
const EDEN_EVENT_ETF_WINDOW_PLAYBOOK_MINUTES = [
  67, 77, 87, 93, 103, 113, 123, 133, 143, 153, 163, 173,
] as const;
export const EDEN_EVENT_ETF_WINDOW_MINUTES =
  EDEN_EVENT_ETF_WINDOW_PLAYBOOK_MINUTES.map(edenPlaybookToGameMinute);

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
        : minute < EDEN_EVENT_NEURO_LIST_MINUTE
          ? ["AERIUM"]
          : minute < EDEN_EVENT_ETF_LIST_MINUTE
            ? ["AERIUM", "NEURO"]
            : ["AERIUM", "NEURO", "ORBITAL"],
    bondIds:
      minute < EDEN_EVENT_BOND_MINUTES[0]
        ? []
        : minute < EDEN_EVENT_BOND_MINUTES[1]
          ? ["standard"]
          : ["standard", "aerium_pegged"],
    optionsEnabled:
      minute >= EDEN_EVENT_OPTIONS_OPEN_MINUTE &&
      minute < EDEN_EVENT_DURATION_MINUTES,
    etfWindowOpen: EDEN_EVENT_ETF_WINDOW_MINUTES.some(
      (openMinute) =>
        elapsedSeconds >= openMinute * 60 &&
        elapsedSeconds < openMinute * 60 + EDEN_EVENT_ETF_WINDOW_SEC,
    ),
    botVolatilityMultiplier: minute >= EDEN_EVENT_SQUEEZE_MINUTE ? 3 : 1,
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
