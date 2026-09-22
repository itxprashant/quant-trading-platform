"use client";

import { useEffect, useState } from "react";
import { Handshake, X } from "lucide-react";
import type { OtcLeg, OtcOffer } from "@qtp/shared";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Input";
import { ApiError, post } from "@/lib/api";
import { money, signed } from "@/lib/format";
import { cn } from "@/lib/cn";
import { otcChoiceLeg, otcNetCash } from "@/lib/eden";

function secsLeft(expiresAt: string): number {
  return Math.max(
    0,
    Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000),
  );
}

/**
 * The Deal Desk (comp_desc OTC bargaining). Pending offers from the host pop up
 * as modal cards with a live countdown; traders ACCEPT, REJECT, or BARGAIN a
 * counter cash figure. Settlement is binding and atomic on the engine.
 */
export function DealDesk({
  offers,
  result,
}: {
  offers: OtcOffer[];
  result: { offerId: string; status: OtcOffer["status"]; ts: number } | null;
}) {
  const [now, setNow] = useState(Date.now());
  const [bargaining, setBargaining] = useState<string | null>(null);
  const [counter, setCounter] = useState("");
  const [selection, setSelection] = useState<{
    offerId: string;
    symbol: string;
    quantity: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<{
    id: string;
    message: string;
    status: string;
    settleAt?: string;
  } | null>(null);

  useEffect(() => {
    if (!result) return;
    setDismissed((s) => new Set(s).add(result.offerId));
    setFeedback({
      id: result.offerId,
      status: result.status,
      message:
        result.status === "accepted"
          ? "Accepted and binding. Settlement pending; accepted bargains wait 5 seconds. You cannot cancel."
          : result.status === "settled"
            ? "Deal settled. Check your cash and holdings."
            : `Deal ${result.status}. No settlement will occur.`,
    });
  }, [result]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Surface the most recent live, non-dismissed offer.
  const live = offers
    .filter(
      (o) =>
        o.status === "pending" &&
        !dismissed.has(o.id) &&
        Date.parse(o.expiresAt) > now,
    )
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  const offer = live[0] as (OtcOffer & { choices?: OtcLeg[] }) | undefined;
  const hasChoices = offer?.choices !== undefined;
  const choiceSymbol =
    selection?.offerId === offer?.id
      ? (selection?.symbol ?? "")
      : (offer?.choices?.[0]?.symbol ?? "");
  const choiceQuantity =
    selection?.offerId === offer?.id ? (selection?.quantity ?? "1") : "1";
  const choice = offer?.choices?.find((leg) => leg.symbol === choiceSymbol);
  const selectedLeg = hasChoices
    ? otcChoiceLeg(offer?.choices ?? [], choiceSymbol, Number(choiceQuantity))
    : null;
  const previewLegs = hasChoices
    ? selectedLeg
      ? [selectedLeg]
      : []
    : (offer?.legs ?? []);
  const validChoice = !hasChoices || selectedLeg !== null;

  if (!offer)
    return feedback ? (
      <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-4">
        <section
          aria-label="Deal desk result"
          className="flex w-full max-w-md items-start gap-3 rounded-lg border border-border bg-surface p-4 shadow-md"
        >
          <p role="status" className="flex-1 text-xs text-muted">
            {feedback.message}
            {feedback.settleAt &&
              feedback.status === "accepted" &&
              ` ${Date.parse(feedback.settleAt) > now ? `Settlement due in ${Math.ceil((Date.parse(feedback.settleAt) - now) / 1000)}s.` : "Awaiting settlement confirmation."}`}
          </p>
          <button
            aria-label="Dismiss deal result"
            onClick={() => setFeedback(null)}
            className="text-muted hover:text-text"
          >
            <X className="size-4" />
          </button>
        </section>
      </div>
    ) : null;

  async function respond(
    o: OtcOffer,
    action: "accept" | "reject" | "bargain",
    counterCash?: number,
  ) {
    if (busy || Date.now() >= Date.parse(o.expiresAt)) return;
    if (action !== "reject" && !validChoice) return;
    if (
      action === "bargain" &&
      (!counter.trim() || !Number.isFinite(counterCash))
    )
      return;
    setError(null);
    setBusy(true);
    try {
      const response = await post<{ result: string; settleAt?: string }>(
        `/api/otc/${o.id}/respond`,
        {
          action,
          ...(action === "bargain" ? { counterCash } : {}),
          ...(action !== "reject" && hasChoices
            ? { choiceSymbol, choiceQuantity: Number(choiceQuantity) }
            : {}),
        },
      );
      setFeedback((previous) =>
        previous?.id === o.id && previous.status === "settled"
          ? previous
          : {
              id: o.id,
              status: response.result,
              settleAt: response.settleAt,
              message:
                response.result === "rejected"
                  ? action === "bargain"
                    ? "Bargain rejected by the desk. No trade will settle."
                    : "Offer rejected."
                  : response.result === "settled"
                    ? "Deal settled. Check your cash and holdings."
                    : `${action === "bargain" ? "Bargain accepted. Binding through the 5-second settlement delay" : "Accepted and binding. Settlement pending"}; you cannot cancel.`,
            },
      );
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
  const netCash = otcNetCash(offer.cashToTrader, previewLegs);

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-4 sm:bottom-4">
      <section
        aria-label="OTC deal desk"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-lg border border-accent/40 bg-surface shadow-md"
      >
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
          {hasChoices && (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Bailout: choose one asset and how many units to sell. The host
                price is fixed at 90% of fair value when offered.
              </p>
              <div className="grid grid-cols-[minmax(0,1fr)_100px] gap-2">
                <Field label="Asset to sell">
                  <Select
                    value={choiceSymbol}
                    disabled={busy}
                    onChange={(e) =>
                      setSelection({
                        offerId: offer.id,
                        symbol: e.target.value,
                        quantity: "1",
                      })
                    }
                  >
                    {!offer.choices?.length && (
                      <option value="">No eligible assets</option>
                    )}
                    {offer.choices?.map((leg) => (
                      <option key={leg.symbol} value={leg.symbol}>
                        {leg.symbol}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={`Units (max ${Math.abs(choice?.quantity ?? 0)})`}>
                  <Input
                    type="number"
                    min={1}
                    max={Math.abs(choice?.quantity ?? 0)}
                    step={1}
                    value={choiceQuantity}
                    disabled={busy}
                    onChange={(e) =>
                      setSelection({
                        offerId: offer.id,
                        symbol: choiceSymbol,
                        quantity: e.target.value,
                      })
                    }
                    className="mono"
                  />
                </Field>
              </div>
              {!validChoice && (
                <p className="text-xs text-warning">
                  Choose an eligible asset and a whole quantity within its
                  limit.
                </p>
              )}
            </div>
          )}
          {feedback && (
            <p role="status" className="text-xs text-muted">
              {feedback.message}
            </p>
          )}

          <div className="overflow-x-auto border-y border-border py-2.5">
            <table className="w-full min-w-[260px] text-xs">
              <tbody className="divide-y divide-border">
                {previewLegs.map((leg, i) => (
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
                  netCash >= 0 ? "text-up" : "text-down",
                )}
              >
                {validChoice ? signed(netCash) : "Select valid units"}
              </span>
            </div>
          </div>

          {bargaining === offer.id ? (
            <div className="space-y-2">
              <p className="text-xs text-muted">
                Counter the cash adjustment, not the total. Leg prices stay
                fixed. The desk may reject your bargain.
              </p>
              <div className="flex gap-2">
                <Input
                  type="number"
                  step="0.01"
                  value={counter}
                  onChange={(e) => setCounter(e.target.value)}
                  placeholder={String(offer.cashToTrader)}
                  aria-label="Counteroffer cash amount"
                  className="mono min-w-0"
                />
                <Button
                  size="md"
                  loading={busy}
                  disabled={
                    !validChoice ||
                    !counter.trim() ||
                    !Number.isFinite(Number(counter))
                  }
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
              <p className="text-xs text-muted">
                Counter net cash:{" "}
                <span className="mono">
                  {validChoice
                    ? signed(otcNetCash(Number(counter), previewLegs))
                    : "Select valid units"}
                </span>
              </p>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                variant="buy"
                className="flex-1"
                loading={busy}
                disabled={!validChoice}
                onClick={() => respond(offer, "accept")}
              >
                Accept
              </Button>
              <Button
                variant="secondary"
                loading={busy}
                disabled={!validChoice}
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
          <p className="text-xs text-faint">
            Net cash = cash adjustment ({signed(offer.cashToTrader)}) minus
            signed quantity x price for each leg. Accepted bargains bind through
            the 5-second settlement delay, even if news changes.
          </p>

          {error && (
            <p role="alert" className="text-xs text-down">
              {error}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
