/**
 * Pure logic for New Eden policy mechanics: the Solidarity (wealth) Tax vote and
 * the manufactured-bubble government grant. Free of engine/DB state so it can be
 * unit-tested and shared by the engine runner and API.
 */

export interface VoteTally {
  yes: number;
  no: number;
  passed: boolean;
}

/** Tally yes/no ballots. Passes on a strict majority of votes cast. */
export function tallyVote(choices: Array<"yes" | "no">): VoteTally {
  let yes = 0;
  let no = 0;
  for (const c of choices) {
    if (c === "yes") yes += 1;
    else if (c === "no") no += 1;
  }
  return { yes, no, passed: yes > no };
}

export interface WealthAccount {
  id: string;
  cash: number;
}

export interface WealthTaxResult {
  /** Signed cash adjustment per account (negative = taxed, positive = relief). */
  deltas: Array<{ id: string; delta: number }>;
  /** Total cash moved from the top bracket to the bottom bracket. */
  redistributed: number;
}

/**
 * Solidarity tax: the wealthiest `topPct` contribute `ratePct` of their cash to
 * a pool that is split evenly among the poorest `bottomPct`. Only positive cash
 * is taxable. Conserves cash exactly (sum of deltas ≈ 0).
 */
export function wealthTaxTransfers(
  accounts: WealthAccount[],
  ratePct: number,
  topPct: number,
  bottomPct: number,
): WealthTaxResult {
  const n = accounts.length;
  if (n === 0 || ratePct <= 0) return { deltas: [], redistributed: 0 };

  const sorted = [...accounts].sort((a, b) => b.cash - a.cash);
  const topCount = Math.max(1, Math.min(n, Math.round(n * clamp01(topPct))));
  const bottomCount = Math.max(1, Math.min(n, Math.round(n * clamp01(bottomPct))));
  const rate = clamp01(ratePct);

  const taxed = new Map<string, number>();
  let pool = 0;
  for (let i = 0; i < topCount; i += 1) {
    const acct = sorted[i]!;
    if (acct.cash <= 0) continue;
    const tax = acct.cash * rate;
    taxed.set(acct.id, -tax);
    pool += tax;
  }
  if (pool <= 0) return { deltas: [], redistributed: 0 };

  const bottom = sorted.slice(n - bottomCount);
  const share = pool / bottom.length;
  const relief = new Map<string, number>();
  for (const acct of bottom) {
    relief.set(acct.id, (relief.get(acct.id) ?? 0) + share);
  }

  // Merge taxed + relief (a bottom account is never also a top account because
  // the brackets are taken from opposite ends; guard anyway by summing).
  const merged = new Map<string, number>();
  for (const [id, d] of taxed) merged.set(id, (merged.get(id) ?? 0) + d);
  for (const [id, d] of relief) merged.set(id, (merged.get(id) ?? 0) + d);

  return {
    deltas: [...merged.entries()].map(([id, delta]) => ({ id, delta })),
    redistributed: pool,
  };
}

export interface GrantHolder {
  id: string;
  qty: number;
}

/**
 * Pick the grant winner: the largest holder of the target symbol. Ties break by
 * the first id encountered. Returns null when nobody holds a positive position.
 */
export function grantWinner(holders: GrantHolder[]): string | null {
  let best: GrantHolder | null = null;
  for (const h of holders) {
    if (h.qty > 0 && (best === null || h.qty > best.qty)) best = h;
  }
  return best?.id ?? null;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
