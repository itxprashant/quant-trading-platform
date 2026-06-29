/**
 * Pure resolution logic for the premium-feed blind auction (comp_desc Section
 * 3.3). Traders submit sealed bids; the top fraction win early news access and
 * the lowest winning bid is published as the public cutoff. Kept free of I/O so
 * it can be unit-tested and reused by the API resolver.
 */

export interface AuctionBidInput {
  userId: string;
  amount: number;
}

export interface AuctionResolution {
  /** User ids that won premium access. */
  winners: string[];
  /** Lowest winning bid (the public cutoff), or null when nobody bid. */
  cutoff: number | null;
}

/**
 * Rank sealed bids and select the winning cohort. `winnerFraction` is the share
 * of bidders who win (e.g. 0.3 = top 30%); at least one bidder wins when any
 * bids exist. Ties at the cutoff all win, so the realized winner count can
 * exceed the nominal fraction — this is deliberate and fair.
 */
export function resolveAuction(
  bids: AuctionBidInput[],
  winnerFraction: number,
): AuctionResolution {
  const valid = bids.filter((b) => Number.isFinite(b.amount) && b.amount > 0);
  if (valid.length === 0) return { winners: [], cutoff: null };

  const sorted = [...valid].sort((a, b) => b.amount - a.amount);
  const frac = Math.min(1, Math.max(0, winnerFraction));
  const count = Math.max(1, Math.min(sorted.length, Math.round(sorted.length * frac)));
  const cutoff = sorted[count - 1]!.amount;
  // Include every bid at or above the cutoff (tie handling).
  const winners = sorted.filter((b) => b.amount >= cutoff).map((b) => b.userId);
  return { winners, cutoff };
}
