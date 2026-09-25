/**
 * Pure helpers for the New Eden derivative markets: option symbol naming,
 * intrinsic value, put–call parity, pro-rata assignment, OTC bargaining odds,
 * and ETF NAV. Kept free of engine state so they can be unit-tested in
 * isolation and reused by bots, the runner, and the API.
 */

export type OptionType = "call" | "put";

/** Format a strike for use inside a contract symbol (compact, dot→underscore). */
export function formatStrike(strike: number): string {
  return Number.isInteger(strike)
    ? String(strike)
    : String(strike).replace(/\./g, "_");
}

/** Build the synthetic tradeable symbol for an option series. */
export function optionSymbol(
  underlying: string,
  type: OptionType,
  strike: number,
  cycleId?: string,
): string {
  return `${underlying}-${type === "call" ? "C" : "P"}-${formatStrike(strike)}${cycleId === undefined ? "" : `@${encodeURIComponent(cycleId)}`}`;
}

export interface ParsedOption {
  underlying: string;
  type: OptionType;
  strike: number;
  cycleId?: string;
}

/** Parse a contract symbol back into its parts, or null if it is not one. */
export function parseOptionSymbol(symbol: string): ParsedOption | null {
  const m = /^(.+)-([CP])-([0-9]+(?:_[0-9]+)?)(?:@(.+))?$/.exec(symbol);
  if (!m) return null;
  const strike = Number(m[3]!.replace(/_/g, "."));
  if (!Number.isFinite(strike)) return null;
  let cycleId: string | undefined;
  try {
    cycleId = m[4] === undefined ? undefined : decodeURIComponent(m[4]);
  } catch {
    return null;
  }
  return {
    underlying: m[1]!,
    type: m[2] === "C" ? "call" : "put",
    strike,
    ...(cycleId === undefined ? {} : { cycleId }),
  };
}

/**
 * Listed option strikes: current mid ±5% and ATM, snapped to the
 * underlying tick. Duplicates (tiny ticks / already-round mids) collapse.
 */
export function optionWindowStrikes(mid: number, tickSize = 0.01): number[] {
  if (!Number.isFinite(mid) || mid <= 0) return [];
  const tick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.01;
  const snap = (n: number) => Math.round(n / tick) * tick;
  const raw = [snap(mid * 0.95), snap(mid), snap(mid * 1.05)];
  return [...new Set(raw.map((k) => Math.round(k * 1e8) / 1e8))]
    .filter((k) => k > 0)
    .sort((a, b) => a - b);
}

/** Intrinsic (exercise) value per contract at the given underlying price. */
export function intrinsicValue(
  type: OptionType,
  underlyingPrice: number,
  strike: number,
): number {
  return type === "call"
    ? Math.max(0, underlyingPrice - strike)
    : Math.max(0, strike - underlyingPrice);
}

/**
 * A fair theoretical option mark used by the HFT market-maker and parity bots.
 * We don't have a full Black–Scholes clock, so we approximate value as
 * intrinsic plus a small, decaying time premium scaled by the underlying's
 * per-tick volatility and the fraction of the cycle remaining.
 */
export function theoreticalOption(
  type: OptionType,
  underlyingFv: number,
  strike: number,
  volatility: number,
  cycleFractionLeft: number,
): number {
  const intrinsic = intrinsicValue(type, underlyingFv, strike);
  const timeValue =
    Math.max(0, volatility) * 4 * Math.max(0, cycleFractionLeft);
  return intrinsic + timeValue;
}

/**
 * Put–call parity residual: `(call − put) − (spot − strike)`. Zero when the
 * market is arbitrage-free; the parity bot trades to push this toward zero.
 */
export function parityResidual(
  callPrice: number,
  putPrice: number,
  spot: number,
  strike: number,
): number {
  return callPrice - putPrice - (spot - strike);
}

/**
 * Allocate `total` units across short holders proportional to their size,
 * using the largest-remainder method so the integer parts always sum to
 * `total`. Holders are objects of `{ id, qty }` where `qty` is the (positive)
 * outstanding short quantity.
 */
export function proRataAssign<T extends { id: string; qty: number }>(
  shorts: T[],
  total: number,
): Array<{ id: string; qty: number }> {
  if (!Number.isSafeInteger(total)) return [];
  const pool = shorts.filter((s) => Number.isSafeInteger(s.qty) && s.qty > 0);
  const sum = pool.reduce((a, s) => a + s.qty, 0);
  if (sum <= 0 || total <= 0) return [];
  const capped = Math.min(total, sum);
  const raw = pool.map((s) => ({
    id: s.id,
    exact: (s.qty / sum) * capped,
  }));
  const out = raw.map((r) => ({ id: r.id, qty: Math.floor(r.exact) }));
  let assigned = out.reduce((a, r) => a + r.qty, 0);
  // Distribute the remainder to the largest fractional parts.
  const order = raw
    .map((r, i) => ({ i, frac: r.exact - Math.floor(r.exact) }))
    .sort((a, b) => b.frac - a.frac);
  let k = 0;
  while (assigned < capped && k < order.length) {
    out[order[k]!.i]!.qty += 1;
    assigned += 1;
    k += 1;
  }
  return out.filter((r) => r.qty > 0);
}

/** Ask % at which the desk always rejects (25% → 100%). */
export const BARGAIN_REJECT_AT = 0.25;

export interface BargainAskLeg {
  quantity: number;
  price: number;
  fairValue: number;
}

/**
 * Linear reject odds vs trader-favorable ask:
 * (0%, 0%) → (25%, 100%). Over 25% always rejects.
 */
export function bargainRejectProbability(askPct: number): number {
  if (!Number.isFinite(askPct) || askPct <= 0) return 0;
  return Math.max(0, Math.min(1, askPct / BARGAIN_REJECT_AT));
}

/**
 * How far the counter is from fair, as a fraction of FV notional.
 * Positive = trader-favorable: underpaying a buy, or overasking a sell.
 * Mixed packages use combined buy+sell FV as the denominator.
 */
export function bargainAskPct(
  legs: BargainAskLeg[],
  counterCash: number,
): number {
  if (!Number.isFinite(counterCash)) return 0;
  let buyFv = 0;
  let sellFv = 0;
  let paidForBuys = 0;
  let receivedForSells = 0;
  for (const leg of legs) {
    if (
      !Number.isFinite(leg.quantity) ||
      !Number.isFinite(leg.price) ||
      !Number.isFinite(leg.fairValue)
    ) {
      continue;
    }
    if (leg.quantity > 0) {
      buyFv += leg.quantity * leg.fairValue;
      paidForBuys += leg.quantity * leg.price;
    } else if (leg.quantity < 0) {
      const qty = -leg.quantity;
      sellFv += qty * leg.fairValue;
      receivedForSells += qty * leg.price;
    }
  }
  const surplus = counterCash + receivedForSells - paidForBuys + buyFv - sellFv;
  const notional = buyFv + sellFv;
  if (surplus <= 0 || notional <= 0) return 0;
  return surplus / notional;
}

/** ETF net asset value from a weighted basket of underlying spot prices. */
export function etfNav(
  basket: Array<{ symbol: string; weight: number }>,
  prices: Record<string, number>,
): number {
  let nav = 0;
  for (const c of basket) nav += (prices[c.symbol] ?? 0) * c.weight;
  return nav;
}

/** Pegged bond coupon: `(base − price) / divisor`, can go to zero/negative. */
export function peggedCoupon(
  base: number,
  price: number,
  divisor: number,
): number {
  if (divisor <= 0) return 0;
  return (base - price) / divisor;
}
