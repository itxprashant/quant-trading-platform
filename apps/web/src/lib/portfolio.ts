import { bondMarkValue, type Portfolio } from "@qtp/shared";

/**
 * Live WS snapshots used to omit off-book bonds (and their mark). Merge them
 * onto the last complete portfolio so the desk does not blink.
 */
export function applyPortfolioUpdate(
  prev: Portfolio | null,
  next: Portfolio,
): Portfolio {
  const omittedBonds =
    next.bonds === undefined && (prev?.bonds?.length ?? 0) > 0;
  const bondValue = omittedBonds
    ? prev!.bonds!.reduce((sum, holding) => sum + bondMarkValue(holding), 0)
    : 0;
  return {
    ...next,
    bonds: next.bonds ?? prev?.bonds,
    loans: next.loans ?? prev?.loans,
    premium: next.premium ?? prev?.premium,
    marketValue: next.marketValue + bondValue,
  };
}
