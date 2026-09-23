import type {
  Auction,
  ChallengeStatus,
  OptionContract,
  OtcLeg,
} from "@qtp/shared";
import {
  EDEN_EVENT_AUCTION_CLOSE_LEAD_SEC,
  EDEN_EVENT_AUCTION_MINUTES,
  EDEN_EVENT_AUCTION_OPEN_LEAD_SEC,
  EDEN_EVENT_DURATION_MINUTES,
  EDEN_EVENT_ETF_WINDOW_MINUTES,
  EDEN_EVENT_ETF_WINDOW_SEC,
  EDEN_EVENT_HALFTIME_END_MINUTE,
  EDEN_EVENT_NEWS_MINUTES,
  EDEN_EVENT_OPTIONS_OPEN_MINUTE,
  EDEN_EVENT_PREMIUM_LEAD_SEC,
  edenEventStateAt,
} from "@qtp/shared";

/**
 * Wall milliseconds per game second. The engine pins a scripted event's
 * `endsAt` to `startsAt` + 130 game minutes, so the span encodes
 * `ENGINE_MINUTE_MS` (accelerated dry runs included).
 */
export function edenSecondMs(
  startsAt: string | null,
  endsAt: string | null,
  scripted: boolean,
): number {
  if (!scripted || !startsAt || !endsAt) return 1000;
  const span = Date.parse(endsAt) - Date.parse(startsAt);
  return Number.isFinite(span) && span > 0
    ? span / (EDEN_EVENT_DURATION_MINUTES * 60)
    : 1000;
}

export function eventProgress(
  startsAt: string | null,
  now: number,
  secondMs = 1000,
) {
  if (!startsAt || !Number.isFinite(Date.parse(startsAt))) return null;
  const elapsed = (now - Date.parse(startsAt)) / secondMs;
  return {
    phase: edenEventStateAt(elapsed).phase,
    elapsedSeconds: Math.max(
      0,
      Math.min(EDEN_EVENT_DURATION_MINUTES * 60, elapsed),
    ),
  };
}

export type EventTimerId = "event" | "auction" | "options" | "etf" | "news";

export interface EventTimer {
  id: EventTimerId;
  label: string;
  /** Epoch ms the countdown runs to; absent for static states. */
  target?: number;
  /** Shown instead of a countdown when there is no target. */
  text?: string;
  /** Trailing word after the countdown, e.g. "left". */
  suffix?: string;
  /** Small tag after the value, e.g. "Early" for premium lead time. */
  hint?: string;
  tone: "neutral" | "active" | "warning";
}

export interface EventTimerInput {
  now: number;
  status: ChallengeStatus;
  startsAt: string | null;
  endsAt: string | null;
  /** Scripted New Eden timeline (`config.eden.eventScript`). */
  scripted: boolean;
  auction: Auction | null;
  contracts: OptionContract[];
  exerciseWindowSec: number;
  premium: boolean;
}

const URGENT_MS = 10_000;

/** Navbar countdowns. Schedule-derived chips only appear for scripted events. */
export function eventTimers(input: EventTimerInput): EventTimer[] {
  const start = input.startsAt ? Date.parse(input.startsAt) : NaN;
  const scripted = input.scripted && Number.isFinite(start);
  const secondMs = edenSecondMs(input.startsAt, input.endsAt, scripted);
  const at = (second: number) => start + second * secondMs;
  const timers = [
    eventTimer(input, scripted, start, secondMs, at),
    auctionTimer(input, scripted, at),
    optionsTimer(input, scripted, at),
    scripted ? etfTimer(input.now, at) : null,
    scripted ? newsTimer(input.now, input.premium, at) : null,
  ].filter((t): t is EventTimer => t !== null);
  if (input.status === "ended") {
    return timers.filter((t) => t.id === "event");
  }
  return timers.map((t) =>
    t.target != null && t.target - input.now <= URGENT_MS && t.tone !== "active"
      ? { ...t, tone: "warning" }
      : t,
  );
}

function eventTimer(
  input: EventTimerInput,
  scripted: boolean,
  start: number,
  secondMs: number,
  at: (second: number) => number,
): EventTimer | null {
  const ended: EventTimer = {
    id: "event",
    label: "Event",
    text: "Ended",
    tone: "neutral",
  };
  if (input.status === "ended") return ended;
  const end = input.endsAt ? Date.parse(input.endsAt) : NaN;
  if (scripted) {
    switch (edenEventStateAt((input.now - start) / secondMs).phase) {
      case "pending":
        return { id: "event", label: "Opens in", target: start, tone: "neutral" };
      case "session_one":
        return {
          id: "event",
          label: "Session 1",
          target: at(EDEN_EVENT_DURATION_MINUTES * 60),
          suffix: "left",
          tone: "neutral",
        };
      case "halftime":
        return {
          id: "event",
          label: "Halftime",
          target: at(EDEN_EVENT_HALFTIME_END_MINUTE * 60),
          suffix: "to resume",
          tone: "warning",
        };
      case "session_two":
        return {
          id: "event",
          label: "Session 2",
          target: at(EDEN_EVENT_DURATION_MINUTES * 60),
          suffix: "left",
          tone: "neutral",
        };
      default:
        return ended;
    }
  }
  if (
    (input.status === "draft" || input.status === "scheduled") &&
    Number.isFinite(start) &&
    input.now < start
  ) {
    return { id: "event", label: "Opens in", target: start, tone: "neutral" };
  }
  if (Number.isFinite(end)) {
    return input.now < end
      ? { id: "event", label: "Ends in", target: end, tone: "neutral" }
      : ended;
  }
  if (input.status === "live" || input.status === "paused") {
    return {
      id: "event",
      label: "Event",
      text: input.status === "live" ? "Live" : "Paused",
      tone: "neutral",
    };
  }
  return null;
}

function auctionTimer(
  input: EventTimerInput,
  scripted: boolean,
  at: (second: number) => number,
): EventTimer | null {
  const { auction, now } = input;
  if (auction?.status === "open") {
    const closes = Date.parse(auction.expiresAt);
    return Number.isFinite(closes) && now < closes
      ? {
          id: "auction",
          label: "Auction",
          target: closes,
          suffix: "to close",
          tone: "warning",
        }
      : { id: "auction", label: "Auction", text: "Allocating", tone: "neutral" };
  }
  if (!scripted) return null;
  for (const minute of EDEN_EVENT_AUCTION_MINUTES) {
    const opensAt = at(minute * 60 - EDEN_EVENT_AUCTION_OPEN_LEAD_SEC);
    const closesAt = at(minute * 60 - EDEN_EVENT_AUCTION_CLOSE_LEAD_SEC);
    if (now < opensAt) {
      return {
        id: "auction",
        label: "Next auction",
        target: opensAt,
        tone: "neutral",
      };
    }
    if (now < closesAt) {
      return {
        id: "auction",
        label: "Auction",
        target: closesAt,
        suffix: "to close",
        tone: "warning",
      };
    }
  }
  return null;
}

function optionsTimer(
  input: EventTimerInput,
  scripted: boolean,
  at: (second: number) => number,
): EventTimer | null {
  const { contracts, now, exerciseWindowSec } = input;
  const deadlines = contracts
    .map((c) => optionPhase(c, exerciseWindowSec, now))
    .filter((p, i) => contracts[i]!.status !== "expired" && now >= p.expiry)
    .map((p) => p.deadline)
    .filter((deadline) => now < deadline);
  if (deadlines.length > 0) {
    return {
      id: "options",
      label: "Exercise",
      target: Math.min(...deadlines),
      suffix: "left",
      tone: "warning",
    };
  }
  const expiries = contracts
    .map((c) => optionPhase(c, exerciseWindowSec, now))
    .filter((p) => p.tradable)
    .map((p) => p.expiry);
  if (expiries.length > 0) {
    return {
      id: "options",
      label: "Options expiry",
      target: Math.min(...expiries),
      tone: "neutral",
    };
  }
  const opensAt = at(EDEN_EVENT_OPTIONS_OPEN_MINUTE * 60);
  if (scripted && now < opensAt) {
    return {
      id: "options",
      label: "Options open",
      target: opensAt,
      tone: "neutral",
    };
  }
  return null;
}

function etfTimer(
  now: number,
  at: (second: number) => number,
): EventTimer | null {
  for (const minute of EDEN_EVENT_ETF_WINDOW_MINUTES) {
    const opensAt = at(minute * 60);
    const closesAt = at(minute * 60 + EDEN_EVENT_ETF_WINDOW_SEC);
    if (now < opensAt) {
      return {
        id: "etf",
        label: "Next ETF window",
        target: opensAt,
        tone: "neutral",
      };
    }
    if (now < closesAt) {
      return {
        id: "etf",
        label: "ETF window",
        target: closesAt,
        suffix: "to close",
        tone: "active",
      };
    }
  }
  return null;
}

function newsTimer(
  now: number,
  premium: boolean,
  at: (second: number) => number,
): EventTimer | null {
  const lead = premium ? EDEN_EVENT_PREMIUM_LEAD_SEC : 0;
  for (const minute of EDEN_EVENT_NEWS_MINUTES) {
    const releaseAt = at(minute * 60 - lead);
    if (now < releaseAt) {
      return {
        id: "news",
        label: "Next news",
        target: releaseAt,
        hint: premium ? "Early" : undefined,
        tone: "neutral",
      };
    }
  }
  return null;
}

export function otcChoiceLeg(
  choices: OtcLeg[],
  symbol: string,
  quantity: number,
): OtcLeg | null {
  const choice = choices.find((leg) => leg.symbol === symbol);
  if (
    !choice ||
    !Number.isInteger(choice.quantity) ||
    choice.quantity >= 0 ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > -choice.quantity ||
    !Number.isFinite(choice.price) ||
    choice.price < 0
  )
    return null;
  return { symbol: choice.symbol, quantity: -quantity, price: choice.price };
}

export function otcNetCash(cashAdjustment: number, legs: OtcLeg[]): number {
  return (
    cashAdjustment -
    legs.reduce((sum, leg) => sum + leg.price * leg.quantity, 0)
  );
}

export function optionPhase(
  contract: OptionContract,
  windowSec: number,
  now: number,
) {
  const expiry = Date.parse(contract.expiresAt);
  const deadline = expiry + windowSec * 1000;
  return {
    tradable: contract.status === "open" && now < expiry,
    exercisable:
      contract.status === "exercise_window" && now >= expiry && now < deadline,
    expiry,
    deadline,
  };
}

export function loanPayment(
  principal: number,
  multiplier: number,
  endsAt: string | null | undefined,
  now: number,
): number | null {
  if (!endsAt || Date.parse(endsAt) <= now) return null;
  const minutes = Math.max(1, Math.ceil((Date.parse(endsAt) - now) / 60000));
  return Number.isFinite(minutes) ? (principal * multiplier) / minutes : null;
}
