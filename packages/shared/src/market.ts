import type { PriceLevel } from "./schemas.js";

export type ChartPriceSeries = "mid" | "last";

/** Best bid/ask mid; one-sided book falls back to the available side. */
export function midFromBook(
  bids: PriceLevel[],
  asks: PriceLevel[],
): number | null {
  const bid = bids[0]?.price;
  const ask = asks[0]?.price;
  if (bid != null && ask != null) return (bid + ask) / 2;
  if (bid != null) return bid;
  if (ask != null) return ask;
  return null;
}
