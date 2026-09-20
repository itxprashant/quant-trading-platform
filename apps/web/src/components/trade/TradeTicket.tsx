"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Order, OrderSide, OrderType } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Input";
import { ApiError, get, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";

export function TradeTicket({
  challengeId,
  symbol,
  maxQuantity,
  maxOpenOrders = 25,
  refreshKey = 0,
  price,
  onPriceChange,
  refPrice,
  frozen = false,
  positionQty = 0,
}: {
  challengeId: string;
  symbol: string;
  maxQuantity: number;
  maxOpenOrders?: number;
  refreshKey?: number;
  price: string;
  onPriceChange: (v: string) => void;
  refPrice?: number;
  frozen?: boolean;
  positionQty?: number;
}) {
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const isAdmin = user?.role === "admin";
  const [side, setSide] = useState<OrderSide>("buy");
  const [type, setType] = useState<OrderType>("limit");
  const [quantity, setQuantity] = useState("10");
  const [status, setStatus] = useState<{
    kind: "ok" | "err";
    msg: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [openOrders, setOpenOrders] = useState<Order[]>([]);

  const loadOpen = useCallback(() => {
    if (!user) {
      setOpenOrders([]);
      return;
    }
    get<Order[]>(`/api/orders?challengeId=${challengeId}&open=true`)
      .then(setOpenOrders)
      .catch(() => {});
  }, [challengeId, user]);

  useEffect(() => {
    loadOpen();
  }, [loadOpen, refreshKey]);

  const qtyNum = parseInt(quantity, 10) || 0;
  const openBuyQty = openOrders
    .filter((o) => o.symbol === symbol && o.side === "buy")
    .reduce((s, o) => s + o.remainingQuantity, 0);
  const openSellQty = openOrders
    .filter((o) => o.symbol === symbol && o.side === "sell")
    .reduce((s, o) => s + o.remainingQuantity, 0);
  const remainingCap = isAdmin
    ? Number.POSITIVE_INFINITY
    : Math.max(
        0,
        side === "buy"
          ? maxQuantity - positionQty - openBuyQty
          : maxQuantity + positionQty - openSellQty,
      );
  const atCountCap = openOrders.length >= maxOpenOrders;
  const atSizeCap = !isAdmin && remainingCap <= 0;
  const qtyCap = Number.isFinite(remainingCap) ? remainingCap : maxQuantity;

  async function submit() {
    if (!user) {
      router.push(`/login?next=/challenges/${challengeId}`);
      return;
    }
    if (frozen) {
      setStatus({
        kind: "err",
        msg: "Market frozen — cancellations only.",
      });
      return;
    }
    const qty = parseInt(quantity, 10);
    if (openOrders.length >= maxOpenOrders) {
      setStatus({
        kind: "err",
        msg: `Open order limit reached (${maxOpenOrders}). Cancel one to place another.`,
      });
      return;
    }
    if (!isAdmin && remainingCap <= 0) {
      setStatus({
        kind: "err",
        msg:
          side === "buy"
            ? "No buy room at the current inventory and working orders."
            : "No sell room at the current inventory and working orders.",
      });
      return;
    }
    setStatus(null);
    setSubmitting(true);
    try {
      const body = {
        challengeId,
        symbol,
        side,
        type,
        quantity: qty,
        ...(type === "limit" ? { price: parseFloat(price) } : {}),
      };
      const ack = await post<{
        orderId: string;
        status: string;
        quantity?: number;
      }>("/api/orders", body);
      const accepted = ack.quantity ?? qty;
      setOpenOrders((cur) => [
        ...cur,
        {
          id: ack.orderId ?? `local-${Date.now()}`,
          challengeId,
          userId: user.id,
          symbol,
          side,
          type,
          quantity: accepted,
          remainingQuantity: accepted,
          price: type === "limit" ? parseFloat(price) : null,
          status: "open",
          createdAt: new Date().toISOString(),
        },
      ]);
      loadOpen();
      const capped = accepted < qty;
      setStatus({
        kind: "ok",
        msg: `${side === "buy" ? "Buy" : "Sell"} ${accepted} ${symbol} submitted.${
          capped ? ` (capped from ${qty})` : ""
        }`,
      });
    } catch (err) {
      const code =
        err instanceof ApiError
          ? (err.body as { error?: string })?.error
          : undefined;
      setStatus({
        kind: "err",
        msg:
          code === "challenge_not_live"
            ? "Challenge is not live."
            : code === "market_frozen"
              ? "Market frozen — cancellations only."
              : code === "no_capacity"
                ? side === "buy"
                  ? "No buy room at the current inventory and working orders."
                  : "No sell room at the current inventory and working orders."
              : code === "quantity_exceeds_limit"
              ? `Max order size is ${maxQuantity}.`
              : code === "open_orders_exceeded"
                ? "Too many open orders. Cancel one to place another."
                : code === "open_quantity_exceeded"
                  ? `Working size would exceed the ${maxQuantity} unit cap. Cancel or reduce size.`
                  : code === "rate_limited"
                ? "Too many orders. Slow down and retry."
                : code === "volume_limited"
                  ? "Volume limit reached for this minute. Wait and retry."
                  : code === "validation_error"
                    ? "Check your order details."
                    : "Order rejected.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel className="flex min-w-0 flex-col overflow-hidden">
      <PanelHeader title="Order entry">
        <span className="mono truncate text-xs text-text">{symbol}</span>
      </PanelHeader>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div
          role="group"
          aria-label="Order side"
          className="grid grid-cols-2 gap-1 rounded-md border border-border bg-surface-2 p-1"
        >
          <button
            type="button"
            onClick={() => setSide("buy")}
            aria-pressed={side === "buy"}
            className={cn(
              "h-9 rounded-sm text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-accent",
              side === "buy"
                ? "bg-up-subtle text-up ring-1 ring-up/40"
                : "text-muted hover:text-text",
            )}
          >
            Buy
          </button>
          <button
            type="button"
            onClick={() => setSide("sell")}
            aria-pressed={side === "sell"}
            className={cn(
              "h-9 rounded-sm text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-accent",
              side === "sell"
                ? "bg-down-subtle text-down ring-1 ring-down/40"
                : "text-muted hover:text-text",
            )}
          >
            Sell
          </button>
        </div>

        <Field label="Order type">
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as OrderType)}
          >
            <option value="limit">Limit</option>
            <option value="market">Market</option>
          </Select>
        </Field>

        <Field
          label={
            isAdmin ? "Quantity" : `Quantity (up to ${qtyCap})`
          }
        >
          <Input
            type="number"
            min={1}
            step={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="mono"
          />
        </Field>

        <div className="grid grid-cols-4 gap-1.5">
          {[25, 50, 75, 100].map((p) => (
            <button
              key={p}
              type="button"
              aria-label={`Set quantity to ${p}% of the ${qtyCap} unit order limit`}
              onClick={() =>
                setQuantity(
                  String(
                    Math.max(1, Math.floor((qtyCap * p) / 100)),
                  ),
                )
              }
              className="h-7 rounded-md border border-border bg-surface-2 text-xs text-muted transition-colors hover:border-border-strong hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
            >
              {p}%
            </button>
          ))}
        </div>

        {type === "limit" && (
          <Field label="Limit price">
            <Input
              type="number"
              step="0.01"
              value={price}
              onChange={(e) => onPriceChange(e.target.value)}
              className="mono"
            />
          </Field>
        )}

        {type === "market" && (
          <p className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs leading-relaxed text-muted">
            Executes against available liquidity. The final price may differ
            from the last trade.
          </p>
        )}

        {type === "limit" &&
          refPrice != null &&
          qtyNum > 0 &&
          parseFloat(price) > 0 && (
            <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-3 text-xs text-muted">
              <span>Estimated notional</span>
              <span className="mono text-text">
                {(qtyNum * parseFloat(price)).toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>
          )}

        <Button
          variant={side === "buy" ? "buy" : "sell"}
          className="mt-auto w-full"
          size="lg"
          loading={submitting}
          disabled={
            frozen || (Boolean(user) && (atCountCap || atSizeCap))
          }
          onClick={submit}
        >
          {frozen
            ? "Market frozen"
            : user
              ? atCountCap
                ? "Open order limit reached"
                : atSizeCap
                  ? side === "buy"
                    ? "No buy room"
                    : "No sell room"
                  : `${side === "buy" ? "Buy" : "Sell"} ${symbol}`
              : "Sign in to trade"}
        </Button>

        {status && (
          <div
            role={status.kind === "err" ? "alert" : "status"}
            className={cn(
              "rounded-md px-3 py-2 text-xs",
              status.kind === "ok"
                ? "border border-up/30 bg-up-subtle text-up"
                : "border border-down/30 bg-down-subtle text-down",
            )}
          >
            {status.msg}
          </div>
        )}
      </div>
    </Panel>
  );
}
