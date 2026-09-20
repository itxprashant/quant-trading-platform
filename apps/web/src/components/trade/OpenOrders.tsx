"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import type { Order } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ApiError, del, get, post } from "@/lib/api";
import { money } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";

function cancelErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const code = (err.body as { error?: string })?.error;
    if (code === "order_not_cancellable") return "Already filled or cancelled.";
    if (code === "challenge_not_cancellable") return "Challenge is not active.";
    if (code === "forbidden") return "Not your order.";
    if (code === "not_found") return "Order not found.";
  }
  return "Cancel failed. Try again.";
}

export function OpenOrders({
  challengeId,
  refreshKey,
  maxOpenOrders = 25,
}: {
  challengeId: string;
  refreshKey: number;
  maxOpenOrders?: number;
}) {
  const user = useAuth((s) => s.user);
  const [orders, setOrders] = useState<Order[]>([]);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancellingAll, setCancellingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    if (!user) {
      setOrders([]);
      setLoaded(true);
      setLoadError(false);
      return;
    }
    get<Order[]>(`/api/orders?challengeId=${challengeId}&open=true`)
      .then((next) => {
        setOrders(next);
        setLoadError(false);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoaded(true));
  }, [challengeId, user]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Light polling as a fallback to the WS order events.
  useEffect(() => {
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  async function cancelAll() {
    if (orders.length === 0 || cancellingAll || cancellingId) return;
    if (!confirm(`Cancel all ${orders.length} working orders?`)) return;
    setError(null);
    setCancellingAll(true);
    try {
      await post("/api/orders/cancel-all", { challengeId });
      setOrders([]);
    } catch (err) {
      setError(cancelErrorMessage(err));
      load();
    } finally {
      setCancellingAll(false);
    }
  }

  async function cancel(order: Order) {
    setError(null);
    setCancellingId(order.id);
    try {
      await del(`/api/orders/${order.id}`);
      setOrders((o) => o.filter((x) => x.id !== order.id));
    } catch (err) {
      setError(cancelErrorMessage(err));
      load();
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <Panel className="flex h-full max-h-[20rem] min-h-0 min-w-0 flex-col overflow-hidden">
      <PanelHeader title="Open orders">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={cancelAll}
            disabled={
              orders.length === 0 || cancellingAll || cancellingId !== null
            }
            className="rounded-md px-2 py-0.5 text-[11px] font-medium text-muted hover:bg-down-subtle hover:text-down focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            {cancellingAll ? "Cancelling…" : "Cancel all"}
          </button>
          <span className="mono rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
            {orders.length}/{maxOpenOrders}
          </span>
        </div>
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {error && (
          <p
            role="alert"
            className="border-b border-border px-3 py-2 text-xs text-down"
          >
            {error}
          </p>
        )}
        {loadError && (
          <p
            role="status"
            className="border-b border-border px-3 py-2 text-xs text-warning"
          >
            Order updates unavailable.{" "}
            <button
              type="button"
              onClick={load}
              className="rounded underline underline-offset-2 hover:text-text"
            >
              Retry
            </button>
          </p>
        )}
        {!loaded ? (
          <p role="status" className="px-3 py-8 text-center text-xs text-muted">
            Loading open orders...
          </p>
        ) : orders.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted">
            {loadError
              ? "Your orders could not be retrieved."
              : user
                ? "No working orders. Unfilled orders will appear here."
                : "Sign in to see and manage your orders."}
          </div>
        ) : (
          <table className="w-full min-w-[400px] whitespace-nowrap text-xs">
            <caption className="sr-only">
              Working orders, remaining quantities, and cancellation actions
            </caption>
            <thead className="sticky top-0 bg-surface-2 text-[10px] uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Side
                </th>
                <th scope="col" className="px-2 py-2 text-left font-medium">
                  Type
                </th>
                <th scope="col" className="px-2 py-2 text-left font-medium">
                  Symbol
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Left / Qty
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Price
                </th>
                <th scope="col" className="px-2 py-2">
                  <span className="sr-only">Cancel</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {orders.map((o) => (
                <tr
                  key={o.id}
                  className={cn(
                    "hover:bg-surface-2",
                    cancellingId === o.id && "opacity-60",
                  )}
                >
                  <td
                    className={cn(
                      "px-3 py-2 font-medium",
                      o.side === "buy" ? "text-up" : "text-down",
                    )}
                  >
                    {o.side === "buy" ? "Buy" : "Sell"}
                  </td>
                  <td className="px-2 py-2 capitalize text-muted">{o.type}</td>
                  <td className="mono px-2 py-2">{o.symbol}</td>
                  <td className="mono px-2 py-2 text-right text-muted">
                    {o.remainingQuantity}/{o.quantity}
                  </td>
                  <td className="mono px-2 py-2 text-right">
                    {o.price != null ? money(o.price) : "Market"}
                  </td>
                  <td className="px-2 py-1">
                    <button
                      type="button"
                      onClick={() => cancel(o)}
                      disabled={cancellingAll || cancellingId === o.id}
                      className="grid size-7 place-items-center rounded-md text-muted hover:bg-down-subtle hover:text-down focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={`Cancel ${o.side} order for ${o.symbol}, ${o.remainingQuantity} remaining`}
                    >
                      {cancellingId === o.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <X className="size-3.5" />
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="border-t border-border px-3 py-2 text-[11px] text-faint">
        Remaining / original size. Cap {maxOpenOrders} working orders.
      </p>
    </Panel>
  );
}
