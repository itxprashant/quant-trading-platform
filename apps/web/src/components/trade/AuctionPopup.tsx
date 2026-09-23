"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, Gavel, X } from "lucide-react";
import type { EdenConfig } from "@qtp/shared";
import type { AuctionState } from "@/hooks/useAuction";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ApiError } from "@/lib/api";
import { money } from "@/lib/format";
import { cn } from "@/lib/cn";

/** How long a round's outcome stays up after allocation. */
const RESULT_MS = 8000;

function secsLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

/**
 * Premium-feed blind auction (comp_desc 3.3) as a floating card while a round
 * is open. Traders submit one sealed bid; the top fraction win early news and
 * the lowest winning bid is published. Outcome shows briefly after allocation
 * for rounds the trader saw open.
 */
export function AuctionPopup({
  state,
  terms,
  minimized,
  onMinimizedChange,
}: {
  state: AuctionState;
  terms?: EdenConfig;
  minimized: boolean;
  onMinimizedChange: (minimized: boolean) => void;
}) {
  const { auction, myBid, won, refreshError } = state;
  const [now, setNow] = useState(() => Date.now());
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; until: number } | null>(
    null,
  );
  const seenOpen = useRef(new Set<string>());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setAmount("");
    setError(null);
  }, [auction?.id]);

  useEffect(() => {
    if (!auction) return;
    if (auction.status === "open") {
      seenOpen.current.add(auction.id);
    } else if (seenOpen.current.delete(auction.id)) {
      setResult({ id: auction.id, until: Date.now() + RESULT_MS });
    }
  }, [auction?.id, auction?.status]);

  if (!auction) return null;
  const left = secsLeft(auction.expiresAt, now);
  const open = auction.status === "open" && left > 0;
  const allocating = auction.status === "open" && left === 0;
  const showResult =
    auction.status === "resolved" &&
    result?.id === auction.id &&
    now < result.until;
  if (!open && !allocating && !showResult) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!open || busy) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Enter a positive bid");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await state.bid(amt);
      setAmount("");
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

  const status = open
    ? `${left}s`
    : allocating
      ? "Allocating"
      : won
        ? "Won"
        : "Not won";
  const statusTone = open
    ? "text-warning"
    : showResult && won
      ? "text-up"
      : "text-muted";

  if (minimized) {
    return (
      <div className="fixed bottom-4 left-4 z-50">
        <button
          type="button"
          onClick={() => onMinimizedChange(false)}
          aria-label={`Premium news auction, ${status}. Expand`}
          className="flex items-center gap-2 rounded-md border border-accent/40 bg-surface px-3 py-2 text-xs shadow-md transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Gavel className="size-3.5 text-accent" aria-hidden />
          <span className="font-medium text-text">Auction</span>
          <span className={cn("mono tabular-nums", statusTone)}>{status}</span>
        </button>
      </div>
    );
  }

  const termsText = `${terms?.auctionDurationSec ?? 30}s sealed bids. Top ${(terms?.auctionWinnerFraction ?? 0.3) * 100}% of active bidders win and pay their own bid. Lowest winning bid is public. Winners receive ${terms?.premiumLeadSec ?? 10}s early news for ${terms?.premiumAccessMinutes ?? 15} minutes.`;

  return (
    <div className="fixed bottom-4 left-4 z-50 w-[min(340px,calc(100vw-2rem))]">
      <section
        aria-label="Premium news auction"
        className="rounded-lg border border-accent/40 bg-surface shadow-md"
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-accent">
            <Gavel className="size-3.5" aria-hidden /> Premium news auction
          </span>
          <div className="flex items-center gap-2">
            <span
              className={cn("mono text-xs font-medium tabular-nums", statusTone)}
            >
              {status}
            </span>
            {showResult ? (
              <button
                type="button"
                onClick={() => setResult(null)}
                aria-label="Dismiss auction result"
                className="text-faint hover:text-text"
              >
                <X className="size-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onMinimizedChange(true)}
                aria-label="Minimize auction"
                className="text-faint hover:text-text"
              >
                <ChevronDown className="size-4" />
              </button>
            )}
          </div>
        </div>
        <div className="space-y-3 p-3 text-sm">
          {open && (
            <>
              <p className="text-xs leading-relaxed text-muted">{termsText}</p>
              {myBid && (
                <p className="text-xs text-faint">
                  Your standing bid:{" "}
                  <span className="mono text-text">{money(myBid.amount)}</span>
                </p>
              )}
              <form onSubmit={submit} className="flex gap-2">
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
                <Button type="submit" loading={busy}>
                  {myBid ? "Update" : "Bid"}
                </Button>
              </form>
            </>
          )}
          {allocating && (
            <p role="status" className="text-xs text-warning">
              Bidding closed. Awaiting cutoff and allocation.
              {myBid && (
                <>
                  {" "}
                  Your bid:{" "}
                  <span className="mono">{money(myBid.amount)}</span>
                </>
              )}
            </p>
          )}
          {showResult && (
            <div role="status" className="space-y-1.5">
              <p
                className={cn(
                  "text-sm font-medium",
                  won ? "text-up" : "text-muted",
                )}
              >
                {won
                  ? "You won premium access. Market headlines arrive early in the news feed."
                  : myBid
                    ? "Round resolved. Your bid did not make the cutoff."
                    : "Round resolved. You did not bid this round."}
              </p>
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
          {refreshError && (
            <p role="alert" className="text-xs text-down">
              {refreshError}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
