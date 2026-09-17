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
): string {
  return `${underlying}-${type === "call" ? "C" : "P"}-${formatStrike(strike)}`;
}

export interface ParsedOption {
  underlying: string;
  type: OptionType;
  strike: number;
}

/** Parse a contract symbol back into its parts, or null if it is not one. */
export function parseOptionSymbol(symbol: string): ParsedOption | null {
  const m = /^(.+)-([CP])-(.+)$/.exec(symbol);
  if (!m) return null;
  const strike = Number(m[3]!.replace(/_/g, "."));
  if (!Number.isFinite(strike)) return null;
  return {
    underlying: m[1]!,
    type: m[2] === "C" ? "call" : "put",
    strike,
  };
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
  const timeValue = Math.max(0, volatility) * 4 * Math.max(0, cycleFractionLeft);
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
  const pool = shorts.filter((s) => s.qty > 0);
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

/**
 * Probability a bargaining counter-offer is rejected by the Deal Desk, based
 * on how far below fair value the trader is trying to underpay. Underpaying
 * 5% ≈ 10% rejection; 20% ≈ 80% rejection (comp_desc Deal Desk rules). Trying
 * to pay at or above fair value is never rejected.
 */
export function bargainRejectProbability(underpayPct: number): number {
  if (underpayPct <= 0) return 0;
  return Math.max(0, Math.min(1, underpayPct * 4));
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
