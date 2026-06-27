import type { OrderSide } from "@qtp/shared";

/**
 * Pure New Eden economic math — deterministic and side-effect free so it can
 * be unit tested in isolation and reused by the engine, scoring, and API.
 *
 * Reference: comp_desc.txt Section 1 (Bank, cost of carry, predatory loans,
 * margin calls).
 */

export interface FreeCashInput {
  /** Settled cash balance. */
  cash: number;
  /** Mark-to-market value of open positions (Σ qty × price). */
  marketValue: number;
  /** Outstanding loan debt still owed to the bank. */
  loanDebt: number;
}

/**
 * Free cash is the trader's true solvency: settled cash plus the liquidation
 * value of inventory, minus what they owe the bank. A margin call fires when
 * this crosses the threshold (default 0).
 */
export function freeCash(i: FreeCashInput): number {
  return i.cash + i.marketValue - i.loanDebt;
}

/** True when free cash has fallen to/below the margin threshold. */
export function isMarginBreach(free: number, threshold = 0): boolean {
  return free <= threshold;
}

/**
 * Cost of carry charged per game-minute: a flat fee per unit of absolute
 * inventory held. Long or short, holding costs money (comp_desc Section 1).
 */
export function carryCharge(
  absInventory: number,
  ratePerUnitPerMinute: number,
): number {
  if (absInventory <= 0 || ratePerUnitPerMinute <= 0) return 0;
  return absInventory * ratePerUnitPerMinute;
}

/** Total a borrower must repay for a new loan (borrow X, repay multiplier×X). */
export function loanTotalRepay(principal: number, multiplier: number): number {
  return principal * multiplier;
}

/**
 * Per-minute loan "bleed": the outstanding balance is amortised evenly over the
 * remaining game-minutes. With ≤1 minute left the full remainder is due.
 */
export function loanBleed(remaining: number, minutesLeft: number): number {
  if (remaining <= 0) return 0;
  if (minutesLeft <= 1) return remaining;
  return remaining / minutesLeft;
}

export interface LiquidationLeg {
  symbol: string;
  /** Side of the flattening order (opposite of the held position). */
  side: OrderSide;
  quantity: number;
}

/**
 * Market orders that flatten every open position. A long is sold, a short is
 * bought back. Zero-quantity positions are skipped.
 */
export function liquidationLegs(
  positions: Array<{ symbol: string; quantity: number }>,
): LiquidationLeg[] {
  const legs: LiquidationLeg[] = [];
  for (const p of positions) {
    if (p.quantity === 0) continue;
    legs.push({
      symbol: p.symbol,
      side: p.quantity > 0 ? "sell" : "buy",
      quantity: Math.abs(p.quantity),
    });
  }
  return legs;
}
