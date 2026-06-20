import { z } from "zod";
import { zChallengeType } from "./domain.js";

/**
 * Scoring configuration is stored as JSON on each challenge so the scoring
 * engine can be tuned per event without code changes.
 */
export const zDirectionalScoring = z.object({
  kind: z.literal("directional"),
  /** Multiplier applied to total PnL to produce the score. */
  pnlWeight: z.number().default(1),
});
export type DirectionalScoring = z.infer<typeof zDirectionalScoring>;

export const zMarketMakingScoring = z.object({
  kind: z.literal("market_making"),
  /** Reward per unit of captured spread (passive fills). */
  spreadCaptureWeight: z.number().default(1),
  /** Reward per second a two-sided quote within maxSpread is maintained. */
  quoteUptimeWeight: z.number().default(0.1),
  /** Max half-spread (in price units) that still counts as "quoting". */
  maxSpread: z.number().default(1),
  /** Minimum resting size on each side to count as quoting. */
  minQuoteSize: z.number().default(1),
  /** Penalty per unit of absolute inventory held, applied per snapshot. */
  inventoryPenaltyWeight: z.number().default(0.05),
  /** Still include PnL with this weight. */
  pnlWeight: z.number().default(0.25),
});
export type MarketMakingScoring = z.infer<typeof zMarketMakingScoring>;

export const zScoringConfig = z.discriminatedUnion("kind", [
  zDirectionalScoring,
  zMarketMakingScoring,
]);
export type ScoringConfig = z.infer<typeof zScoringConfig>;

export function defaultScoringFor(
  type: z.infer<typeof zChallengeType>,
): ScoringConfig {
  if (type === "market_making") {
    return zMarketMakingScoring.parse({ kind: "market_making" });
  }
  return zDirectionalScoring.parse({ kind: "directional" });
}
