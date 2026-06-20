"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import type { Order } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { del, get } from "@/lib/api";
import { money } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";

export function OpenOrders({
  challengeId,
  refreshKey,
}: {
  challengeId: string;
  refreshKey: number;
}) {
  const user = useAuth((s) => s.user);
  const [orders, setOrders] = useState<Order[]>([]);

  const load = useCallback(() => {
    if (!user) {
      setOrders([]);
      return;
    }
    get<Order[]>(`/api/orders?challengeId=${challengeId}&open=true`)
      .then(setOrders)
      .catch(() => {});
  }, [challengeId, user]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Light polling as a fallback to the WS order events.
  useEffect(() => {
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  async function cancel(id: string) {
    setOrders((o) => o.filter((x) => x.id !== id));
    await del(`/api/orders/${id}`).catch(() => load());
  }

  return (
    <Panel className="flex h-full flex-col">
      <PanelHeader title={`Open Orders (${orders.length})`} />
      <div className="flex-1 overflow-y-auto">
        <div className="grid grid-cols-[auto_auto_1fr_auto_auto_auto] gap-3 px-3 py-1.5 text-[10px] uppercase tracking-wide text-faint">
          <span>Side</span>
          <span>Type</span>
          <span>Symbol</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Price</span>
          <span />
        </div>
        {orders.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-faint">
            {user ? "No open orders" : "Sign in to see your orders"}
          </div>
        ) : (
          orders.map((o) => (
            <div
              key={o.id}
              className="grid grid-cols-[auto_auto_1fr_auto_auto_auto] items-center gap-3 px-3 py-1.5 text-xs hover:bg-surface-2"
            >
              <span className={cn("font-medium", o.side === "buy" ? "text-up" : "text-down")}>
                {o.side === "buy" ? "Buy" : "Sell"}
              </span>
              <span className="capitalize text-muted">{o.type}</span>
              <span className="mono">{o.symbol}</span>
              <span className="mono text-right text-muted">
                {o.remainingQuantity}/{o.quantity}
              </span>
              <span className="mono text-right">{o.price != null ? money(o.price) : "—"}</span>
              <button
                onClick={() => cancel(o.id)}
                className="grid size-5 place-items-center rounded-sm text-faint hover:bg-down-subtle hover:text-down"
                aria-label="Cancel order"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
