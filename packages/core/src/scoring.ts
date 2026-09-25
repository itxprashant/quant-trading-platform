import type { ScoringConfig } from "@qtp/shared";

/**
 * Mark-to-market profit versus the cash the trader started with.
 * Borrowed money is not wealth (`loanDebt`).
 */
export function profitPnl(
  cash: number,
  marketValue: number,
  startingCash: number,
  loanDebt = 0,
): number {
  return cash + marketValue - loanDebt - startingCash;
}

/**
 * Event-close wealth: free cash plus every asset marked at mid
 * (`marketValue` is already Σ mid×qty plus remaining bond marks).
 */
export function endingSettlement(cash: number, marketValue: number): number {
  return cash + marketValue;
}

export interface ScorablePortfolio {
  userId: string;
  pnl: number;
  /** Sum of absolute inventory across symbols (for MM penalty). */
  absInventory: number;
  /** Accumulated captured spread (passive fills), maintained by the worker. */
  spreadCapture?: number;
  /** Accumulated seconds of valid two-sided quoting. */
  quoteUptime?: number;
}

/**
 * Compute a single competitor's score from their portfolio and the
 * challenge's scoring configuration. Pure and deterministic.
 */
export function computeScore(
  p: ScorablePortfolio,
  cfg: ScoringConfig,
): number {
  if (cfg.kind === "directional") {
    return p.pnl * cfg.pnlWeight;
  }
  // market_making
  const spread = (p.spreadCapture ?? 0) * cfg.spreadCaptureWeight;
  const uptime = (p.quoteUptime ?? 0) * cfg.quoteUptimeWeight;
  const inventory = p.absInventory * cfg.inventoryPenaltyWeight;
  const pnl = p.pnl * cfg.pnlWeight;
  return spread + uptime + pnl - inventory;
}
