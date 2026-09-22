"use client";

import { useCallback, useEffect, useState } from "react";
import { Gavel } from "lucide-react";
import type { Auction, EdenConfig } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ApiError, get, post } from "@/lib/api";
import { money } from "@/lib/format";
import { cn } from "@/lib/cn";

interface AuctionView {
  auction: Auction | null;
  myBid: { amount: number; won: boolean } | null;
  premium: boolean;
}

function secsLeft(expiresAt: string): number {
  return Math.max(
    0,
    Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000),
  );
}

/**
 * Premium-feed blind auction (comp_desc 3.3). Traders submit one sealed bid for
 * early news access; the top fraction win and the lowest winning bid is the
 * public cutoff. Other bids are never revealed.
 */
export function AuctionPanel({
  challengeId,
  liveAuction,
  liveWon,
  connectionStatus,
  terms,
}: {
  challengeId: string;
  liveAuction: Auction | null;
  liveWon: boolean;
  connectionStatus: string;
  terms?: EdenConfig;
}) {
  const [view, setView] = useState<AuctionView | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [, setNow] = useState(Date.now());

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
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load, connectionStatus]);

  // Refresh from REST whenever a live auction message changes status/identity.
  useEffect(() => {
    if (liveAuction) load();
  }, [liveAuction?.id, liveAuction?.status, liveWon, load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Prefer the freshest of REST + live socket state.
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
  const premium = view?.premium ?? false;
  const myBid = view?.auction?.id === auction?.id ? view?.myBid : null;
  const won =
    (auction?.id === liveAuction?.id && liveWon) || myBid?.won || false;
  const termsText = `${terms?.auctionDurationSec ?? 30}s sealed bids. Top ${(terms?.auctionWinnerFraction ?? 0.3) * 100}% of active bidders win and pay their own bid. Lowest winning bid is public. Winners receive ${terms?.premiumLeadSec ?? 10}s early news for ${terms?.premiumAccessMinutes ?? 15} minutes.`;

  if (!auction) {
    return (
      <Panel className="flex min-w-0 flex-col overflow-hidden">
        <PanelHeader
          title={
            <span className="flex items-center gap-1.5">
              <Gavel className="size-3.5" /> Premium feed
            </span>
          }
        >
          {premium && <PremiumBadge />}
        </PanelHeader>
        <div className="px-3 py-6 text-center text-xs text-faint">
          No auction running. Premium news access is sold in blind rounds.
          <p className="mt-2">{termsText}</p>
          {refreshError && (
            <p role="alert" className="mt-2 text-down">
              {refreshError}
            </p>
          )}
        </div>
      </Panel>
    );
  }

  const open = auction.status === "open" && secsLeft(auction.expiresAt) > 0;

  async function bid() {
    if (
      !auction ||
      auction.status !== "open" ||
      Date.now() >= Date.parse(auction.expiresAt)
    )
      return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter a positive bid");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await post(`/api/auctions/${auction.id}/bid`, { amount: amt });
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? ((err.body as { error?: string })?.error ?? "Bid failed")
          : "Bid failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="flex min-w-0 flex-col overflow-hidden">
      <PanelHeader
        title={
          <span className="flex items-center gap-1.5">
            <Gavel className="size-3.5" /> Premium feed
          </span>
        }
      >
        {premium ? (
          <PremiumBadge />
        ) : open ? (
          <span className="mono text-xs text-warning">
            {secsLeft(auction.expiresAt)}s
          </span>
        ) : null}
      </PanelHeader>

      <div className="space-y-3 p-3 text-sm">
        <p className="text-xs text-muted">{termsText}</p>
        {refreshError && (
          <p role="alert" className="text-xs text-down">
            {refreshError}
          </p>
        )}
        {open ? (
          <>
            <p className="text-xs text-muted">
              Sealed bid for early news access. Top bidders win; the lowest
              winning bid becomes the public cutoff.
            </p>
            {myBid && (
              <p className="text-xs text-faint">
                Your standing bid:{" "}
                <span className="mono">{money(myBid.amount)}</span>
              </p>
            )}
            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Bid amount"
                aria-label="Sealed bid amount"
                className="mono min-w-0"
              />
              <Button loading={busy} onClick={bid}>
                {myBid ? "Update" : "Bid"}
              </Button>
            </div>
          </>
        ) : auction.status === "open" ? (
          <p role="status" className="text-xs text-warning">
            Bidding closed. Awaiting cutoff and allocation.
          </p>
        ) : (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">Round resolved</span>
              <span
                className={cn(
                  "rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  won ? "bg-up-subtle text-up" : "bg-surface-3 text-faint",
                )}
              >
                {won ? "You won access" : "Not won"}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">Public cutoff</span>
              <span className="mono">
                {auction.cutoff != null ? money(auction.cutoff) : "—"}
              </span>
            </div>
            {myBid && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">Your bid</span>
                <span className="mono">{money(myBid.amount)}</span>
              </div>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-down">
            {error}
          </p>
        )}
      </div>
    </Panel>
  );
}

function PremiumBadge() {
  return (
    <span className="rounded-md bg-accent-subtle px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
      Premium active
    </span>
  );
}
