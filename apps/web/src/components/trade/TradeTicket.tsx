"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OrderSide, OrderType } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Input";
import { ApiError, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";

export function TradeTicket({
  challengeId,
  symbol,
  maxQuantity,
  price,
  onPriceChange,
  refPrice,
}: {
  challengeId: string;
  symbol: string;
  maxQuantity: number;
  price: string;
  onPriceChange: (v: string) => void;
  refPrice?: number;
}) {
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const [side, setSide] = useState<OrderSide>("buy");
  const [type, setType] = useState<OrderType>("limit");
  const [quantity, setQuantity] = useState("10");
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!user) {
      router.push(`/login?next=/challenges/${challengeId}`);
      return;
    }
    setStatus(null);
    setSubmitting(true);
    try {
      const qty = parseInt(quantity, 10);
      const body = {
        challengeId,
        symbol,
        side,
        type,
        quantity: qty,
        ...(type === "limit" ? { price: parseFloat(price) } : {}),
      };
      await post("/api/orders", body);
      setStatus({ kind: "ok", msg: `${side === "buy" ? "Buy" : "Sell"} ${qty} ${symbol} submitted.` });
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { error?: string })?.error : undefined;
      setStatus({
        kind: "err",
        msg:
          code === "challenge_not_live"
            ? "Challenge is not live."
            : code === "quantity_exceeds_limit"
              ? `Max order size is ${maxQuantity}.`
              : code === "rate_limited"
                ? "Too many orders — slow down and retry."
                : code === "volume_limited"
                  ? "Volume limit reached for this minute — wait and retry."
                  : code === "validation_error"
                    ? "Check your order details."
                    : "Order rejected.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  const qtyNum = parseInt(quantity, 10) || 0;

  return (
    <Panel className="flex flex-col">
      <PanelHeader title="Trade Ticket" />
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-2 gap-1.5 rounded-md bg-surface-2 p-1">
          <button
            onClick={() => setSide("buy")}
            className={cn(
              "h-8 rounded-sm text-sm font-medium transition-colors",
              side === "buy" ? "bg-up-subtle text-up ring-1 ring-up/40" : "text-muted hover:text-text",
            )}
          >
            Buy
          </button>
          <button
            onClick={() => setSide("sell")}
            className={cn(
              "h-8 rounded-sm text-sm font-medium transition-colors",
              side === "sell" ? "bg-down-subtle text-down ring-1 ring-down/40" : "text-muted hover:text-text",
            )}
          >
            Sell
          </button>
        </div>

        <Field label="Order type">
          <Select value={type} onChange={(e) => setType(e.target.value as OrderType)}>
            <option value="limit">Limit</option>
            <option value="market">Market</option>
          </Select>
        </Field>

        <Field label={`Quantity (max ${maxQuantity})`}>
          <Input
            type="number"
            min={1}
            max={maxQuantity}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="mono"
          />
        </Field>

        <div className="grid grid-cols-4 gap-1.5">
          {[25, 50, 75, 100].map((p) => (
            <button
              key={p}
              onClick={() => setQuantity(String(Math.max(1, Math.floor((maxQuantity * p) / 100))))}
              className="h-7 rounded-sm border border-border bg-surface-2 text-xs text-muted hover:text-text"
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

        {type === "limit" && refPrice != null && qtyNum > 0 && parseFloat(price) > 0 && (
          <div className="flex justify-between rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
            <span>Est. value</span>
            <span className="mono">{(qtyNum * parseFloat(price)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
        )}

        <Button
          variant={side === "buy" ? "buy" : "sell"}
          className="w-full"
          size="lg"
          loading={submitting}
          onClick={submit}
        >
          {user ? `Place ${side} order` : "Sign in to trade"}
        </Button>

        {status && (
          <div
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
