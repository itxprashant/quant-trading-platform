"use client";

import { useEffect, useState } from "react";
import { Handshake, X } from "lucide-react";
import type { OtcOffer } from "@qtp/shared";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ApiError, post } from "@/lib/api";
import { money, signed } from "@/lib/format";
import { cn } from "@/lib/cn";

function secsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

/**
 * The Deal Desk (comp_desc OTC bargaining). Pending offers from the host pop up
 * as modal cards with a live countdown; traders ACCEPT, REJECT, or BARGAIN a
 * counter cash figure. Settlement is binding and atomic on the engine.
 */
export function DealDesk({ offers }: { offers: OtcOffer[] }) {
  const [now, setNow] = useState(Date.now());
  const [bargaining, setBargaining] = useState<string | null>(null);
  const [counter, setCounter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Surface the most recent live, non-dismissed offer.
  const live = offers
    .filter((o) => !dismissed.has(o.id) && secsLeft(o.expiresAt) > 0)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const offer = live[0];
  void now; // re-render each tick for the countdown

  if (!offer) return null;

  async function respond(
    o: OtcOffer,
    action: "accept" | "reject" | "bargain",
    counterCash?: number,
  ) {
    setError(null);
    setBusy(true);
    try {
      await post(`/api/otc/${o.id}/respond`, {
        action,
        ...(action === "bargain" ? { counterCash } : {}),
      });
      setBargaining(null);
      setDismissed((s) => new Set(s).add(o.id));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? ((err.body as { error?: string })?.error ?? "Response failed")
          : "Response failed",
      );
    } finally {
      setBusy(false);
    }
  }

  const left = secsLeft(offer.expiresAt);

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-4 sm:bottom-4">
      <div className="w-full max-w-md rounded-xl border border-accent/40 bg-surface shadow-2xl shadow-black/40 backdrop-blur-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-accent">
            <Handshake className="size-3.5" /> Deal Desk
          </span>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "mono text-xs",
                left <= 5 ? "text-down" : "text-muted",
              )}
            >
              {left}s
            </span>
            <button
              onClick={() => setDismissed((s) => new Set(s).add(offer.id))}
              className="text-faint hover:text-text"
              aria-label="Dismiss"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="space-y-3 p-4">
          <p className="text-sm text-text">{offer.description}</p>

          <div className="rounded-lg border border-border bg-surface-2 p-2.5">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-border">
                {offer.legs.map((leg, i) => (
                  <tr key={i}>
                    <td className="py-1">
                      <span
                        className={cn(
                          "mr-1.5 rounded px-1 text-[10px] font-semibold uppercase",
                          leg.quantity >= 0
                            ? "bg-up-subtle text-up"
                            : "bg-down-subtle text-down",
                        )}
                      >
                        {leg.quantity >= 0 ? "Recv" : "Give"}
                      </span>
                      <span className="mono">{Math.abs(leg.quantity)}</span>{" "}
                      <span className="text-muted">{leg.symbol}</span>
                    </td>
                    <td className="py-1 text-right mono text-faint">
                      @ {money(leg.price)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-xs">
              <span className="text-muted">Net cash to you</span>
              <span
                className={cn(
                  "mono font-semibold",
                  offer.cashToTrader >= 0 ? "text-up" : "text-down",
                )}
              >
                {signed(offer.cashToTrader)}
              </span>
            </div>
          </div>

          {bargaining === offer.id ? (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Counter the cash leg. Lowball the desk and it may walk.
              </p>
              <div className="flex gap-2">
                <Input
                  type="number"
                  step="0.01"
                  value={counter}
                  onChange={(e) => setCounter(e.target.value)}
                  placeholder={String(offer.cashToTrader)}
                  className="mono"
                />
                <Button
                  size="md"
                  loading={busy}
                  onClick={() => respond(offer, "bargain", Number(counter))}
                >
                  Send
                </Button>
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => setBargaining(null)}
                >
                  Back
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                variant="buy"
                className="flex-1"
                loading={busy}
                onClick={() => respond(offer, "accept")}
              >
                Accept
              </Button>
              <Button
                variant="secondary"
                loading={busy}
                onClick={() => {
                  setCounter(String(offer.cashToTrader));
                  setBargaining(offer.id);
                }}
              >
                Bargain
              </Button>
              <Button
                variant="danger"
                loading={busy}
                onClick={() => respond(offer, "reject")}
              >
                Reject
              </Button>
            </div>
          )}

          {error && <p className="text-xs text-down">{error}</p>}
        </div>
      </div>
    </div>
  );
}
