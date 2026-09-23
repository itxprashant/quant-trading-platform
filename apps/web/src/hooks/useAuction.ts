"use client";

import { useCallback, useEffect, useState } from "react";
import type { Auction } from "@qtp/shared";
import { get, post } from "@/lib/api";

interface AuctionView {
  auction: Auction | null;
  myBid: { amount: number; won: boolean } | null;
  premium: boolean;
}

export interface AuctionState {
  auction: Auction | null;
  myBid: { amount: number; won: boolean } | null;
  /** Trader currently holds premium (early) news access. */
  premium: boolean;
  won: boolean;
  refreshError: string | null;
  /** Place or replace the sealed bid; throws `ApiError` on rejection. */
  bid: (amount: number) => Promise<void>;
}

/**
 * Premium-feed blind auction state (comp_desc 3.3), merged from REST polling
 * and live socket messages so whichever is fresher wins.
 */
export function useAuction({
  challengeId,
  enabled,
  liveAuction,
  liveWon,
  connectionStatus,
}: {
  challengeId: string;
  enabled: boolean;
  liveAuction: Auction | null;
  liveWon: boolean;
  connectionStatus: string;
}): AuctionState {
  const [view, setView] = useState<AuctionView | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await get<AuctionView>(`/api/auctions/${challengeId}`));
      setRefreshError(null);
    } catch {
      setRefreshError(
        "Could not refresh auction status. Retrying automatically.",
      );
    }
  }, [challengeId]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [enabled, load, connectionStatus]);

  // Refresh from REST whenever a live auction message changes status/identity.
  useEffect(() => {
    if (enabled && liveAuction) void load();
  }, [enabled, liveAuction?.id, liveAuction?.status, liveWon, load]);

  const rest = view?.auction;
  const auction = !rest
    ? liveAuction
    : !liveAuction
      ? rest
      : rest.id === liveAuction.id
        ? rest.status === "resolved"
          ? rest
          : liveAuction
        : Date.parse(rest.createdAt) >= Date.parse(liveAuction.createdAt)
          ? rest
          : liveAuction;
  const myBid = view?.auction?.id === auction?.id ? (view?.myBid ?? null) : null;
  const won =
    (auction?.id === liveAuction?.id && liveWon) || myBid?.won || false;

  const bid = useCallback(
    async (amount: number) => {
      if (!auction) return;
      await post(`/api/auctions/${auction.id}/bid`, { amount });
      await load();
    },
    [auction, load],
  );

  return {
    auction: enabled ? auction : null,
    myBid,
    premium: enabled && (view?.premium ?? false),
    won,
    refreshError: enabled ? refreshError : null,
    bid,
  };
}
