import type { OptionContract, OtcLeg } from "@qtp/shared";
import { EDEN_EVENT_DURATION_MINUTES, edenEventStateAt } from "@qtp/shared";

export function eventProgress(startsAt: string | null, now: number) {
  if (!startsAt || !Number.isFinite(Date.parse(startsAt))) return null;
  const elapsed = (now - Date.parse(startsAt)) / 1000;
  return {
    phase: edenEventStateAt(elapsed).phase,
    elapsedSeconds: Math.max(
      0,
      Math.min(EDEN_EVENT_DURATION_MINUTES * 60, elapsed),
    ),
  };
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
