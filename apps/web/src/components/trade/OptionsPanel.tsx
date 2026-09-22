"use client";

import { useEffect, useState } from "react";
import { Sigma } from "lucide-react";
import type {
  OptionContract,
  OrderBookSnapshot,
  Portfolio,
  PricePoint,
} from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { ApiError, get, post } from "@/lib/api";
import { OrderBook } from "./OrderBook";
import { optionPhase } from "@/lib/eden";
import { money } from "@/lib/format";
import { cn } from "@/lib/cn";

function intrinsicOf(
  c: OptionContract,
  underlyingPrice: number | undefined,
): number | null {
  if (underlyingPrice == null) return null;
  return c.optionType === "call"
    ? Math.max(0, underlyingPrice - c.strike)
    : Math.max(0, c.strike - underlyingPrice);
}

/**
 * The options grinder (comp_desc Session 2). Lists the live call/put series,
 * lets traders take liquidity (market buy/sell) and EXERCISE in-the-money
 * contracts during the 15-second window.
 */
export function OptionsPanel({
  challengeId,
  contracts,
  prices,
  books,
  portfolio,
  exerciseWindowSec = 15,
  maxQuantity = 50,
  positionCap = 100,
  onChange,
  frozen = false,
}: {
  challengeId: string;
  contracts: OptionContract[];
  prices: Map<string, PricePoint>;
  books: Map<string, OrderBookSnapshot>;
  portfolio: Portfolio | null;
  exerciseWindowSec?: number;
  maxQuantity?: number;
  positionCap?: number;
  onChange?: () => void;
  frozen?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [qty, setQty] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [type, setType] = useState<"limit" | "market">("limit");
  const [price, setPrice] = useState("");
  const [now, setNow] = useState(Date.now());
  const [restBook, setRestBook] = useState<OrderBookSnapshot>();
  const contract = contracts.find((c) => c.symbol === selected);
  const phase = contract ? optionPhase(contract, exerciseWindowSec, now) : null;
  const held =
    portfolio?.positions.find((p) => p.symbol === selected)?.quantity ?? 0;
  const quantity = Number(qty);
  const validQty = Number.isInteger(quantity) && quantity > 0;
  const validPrice =
    type === "market" ||
    (price.trim() !== "" &&
      Number.isFinite(Number(price)) &&
      Number(price) > 0);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setRestBook(undefined);
    setPrice("");
    setError(null);
    setMessage(null);
    if (!selected) return;
    let cancelled = false;
    const load = () =>
      get<OrderBookSnapshot>(
        `/api/market/${challengeId}/${encodeURIComponent(selected)}/orderbook`,
      )
        .then((book) => {
          if (!cancelled) setRestBook(book);
        })
        .catch(() => {
          if (!cancelled)
            setError("Could not refresh depth. Live depth may be delayed.");
        });
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [challengeId, selected]);

  const inWindow = contracts.some(
    (c) => optionPhase(c, exerciseWindowSec, now).exercisable,
  );

  async function trade(symbol: string, side: "buy" | "sell") {
    if (
      !contract ||
      !optionPhase(contract, exerciseWindowSec, Date.now()).tradable ||
      !validQty ||
      quantity > maxQuantity ||
      !validPrice ||
      frozen ||
      busy
    )
      return;
    setError(null);
    setBusy(true);
    try {
      await post(`/api/orders`, {
        challengeId,
        symbol,
        side,
        type,
        quantity,
        ...(type === "limit" ? { price: Number(price) } : {}),
      });
      setMessage("Order submitted. Check working orders and fills below.");
      onChange?.();
    } catch (err) {
      setError(errText(err, "Order failed"));
    } finally {
      setBusy(false);
    }
  }

  async function exercise(symbol: string) {
    if (
      !contract ||
      !optionPhase(contract, exerciseWindowSec, Date.now()).exercisable ||
      !validQty ||
      quantity > held ||
      frozen ||
      busy
    )
      return;
    setError(null);
    setBusy(true);
    try {
      await post(`/api/options/exercise`, {
        challengeId,
        symbol,
        quantity,
      });
      setMessage("Exercise submitted. Awaiting settlement confirmation.");
      onChange?.();
    } catch (err) {
      setError(errText(err, "Exercise failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="flex min-w-0 flex-col overflow-hidden">
      <PanelHeader
        title={
          <span className="flex items-center gap-1.5">
            <Sigma className="size-3.5" /> Options
          </span>
        }
      >
        {inWindow && (
          <span className="rounded-md bg-warning/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
            Exercise window
          </span>
        )}
      </PanelHeader>

      {contracts.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-faint">
          No option cycle is open right now.
        </div>
      ) : (
        <div className="max-h-72 overflow-auto">
          <table className="w-full min-w-[380px] text-xs">
            <caption className="sr-only">
              Option contracts. Select a series to trade or exercise.
            </caption>
            <thead className="sticky top-0 bg-surface-2 text-faint">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-medium">Series</th>
                <th className="px-2.5 py-1.5 text-right font-medium">Strike</th>
                <th className="px-2.5 py-1.5 text-right font-medium">Mark</th>
                <th className="px-2.5 py-1.5 text-right font-medium">
                  Deadline
                </th>
                <th className="px-2.5 py-1.5 text-right font-medium">
                  Intrinsic
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {contracts.map((c) => {
                const mark = prices.get(c.symbol)?.price;
                const intrinsic = intrinsicOf(
                  c,
                  prices.get(c.underlying)?.price,
                );
                const isSel = selected === c.symbol;
                return (
                  <tr
                    key={c.symbol}
                    onClick={() => setSelected(c.symbol)}
                    className={cn(
                      "cursor-pointer transition-colors",
                      isSel ? "bg-accent-subtle/30" : "hover:bg-surface-2",
                    )}
                  >
                    <td className="px-2.5 py-1.5">
                      <button
                        type="button"
                        aria-pressed={isSel}
                        aria-label={`Select ${c.symbol}`}
                        onClick={() => setSelected(c.symbol)}
                        className="inline-flex items-center rounded py-1 text-left focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        <span
                          className={cn(
                            "mr-1 rounded px-1 text-[10px] font-semibold uppercase",
                            c.optionType === "call"
                              ? "bg-up-subtle text-up"
                              : "bg-down-subtle text-down",
                          )}
                        >
                          {c.optionType === "call" ? "C" : "P"}
                        </span>
                        <span className="text-muted">{c.underlying}</span>
                      </button>
                    </td>
                    <td className="px-2.5 py-1.5 text-right mono">
                      {c.strike}
                    </td>
                    <td className="px-2.5 py-1.5 text-right mono">
                      {mark != null ? money(mark) : "—"}
                    </td>
                    <td className="px-2.5 py-1.5 text-right mono text-muted">
                      {optionPhase(c, exerciseWindowSec, now).tradable
                        ? `Expiry ${Math.max(0, Math.ceil((Date.parse(c.expiresAt) - now) / 1000))}s`
                        : now <
                              Date.parse(c.expiresAt) +
                                exerciseWindowSec * 1000 &&
                            c.status !== "expired"
                          ? `Exercise ${Math.max(0, Math.ceil((Date.parse(c.expiresAt) + exerciseWindowSec * 1000 - now) / 1000))}s`
                          : "Expired"}
                    </td>
                    <td
                      className={cn(
                        "px-2.5 py-1.5 text-right mono",
                        intrinsic && intrinsic > 0 ? "text-up" : "text-faint",
                      )}
                    >
                      {intrinsic != null ? money(intrinsic) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && contract && (
        <div className="border-t border-border p-3">
          <div className="mb-2 flex items-center justify-between text-[11px] text-faint">
            <span className="mono break-all text-muted">{selected}</span>
          </div>
          <p className="mb-2 text-xs text-muted">
            Held: <span className="mono">{held}</span>. Manual exercise only,
            within {exerciseWindowSec}s of expiry. Missed contracts expire
            worthless. Assignment can breach inventory limits; restore capacity
            within 30s.
          </p>
          <p className="mb-2 text-xs text-faint">
            Expires {new Date(contract.expiresAt).toLocaleTimeString()};
            exercise closes {new Date(phase!.deadline).toLocaleTimeString()}.
          </p>
          <p className="mb-2 text-xs text-faint">
            Orders: 1-{maxQuantity} whole units. Inventory cap: +/-{positionCap}
            . Exercise up to {Math.max(0, held)} held contracts;{" "}
            {contract.optionType === "call" ? "receive" : "deliver"}{" "}
            {contract.underlying} at strike {money(contract.strike)}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Select
              aria-label="Option order type"
              value={type}
              onChange={(e) => setType(e.target.value as "limit" | "market")}
              className="w-28"
            >
              <option value="limit">Limit</option>
              <option value="market">Market</option>
            </Select>
            {type === "limit" && (
              <Input
                aria-label="Option limit price"
                type="number"
                min="0.01"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="Price"
                className="mono w-28"
              />
            )}
            <Input
              type="number"
              min={1}
              aria-label="Option quantity"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="mono w-20"
            />
            <Button
              variant="buy"
              size="sm"
              loading={busy}
              disabled={
                frozen ||
                !phase?.tradable ||
                !validQty ||
                quantity > maxQuantity ||
                !validPrice
              }
              onClick={() => trade(selected, "buy")}
            >
              Buy
            </Button>
            <Button
              variant="sell"
              size="sm"
              loading={busy}
              disabled={
                frozen ||
                !phase?.tradable ||
                !validQty ||
                quantity > maxQuantity ||
                !validPrice
              }
              onClick={() => trade(selected, "sell")}
            >
              Sell
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              disabled={
                frozen || !phase?.exercisable || !validQty || quantity > held
              }
              onClick={() => exercise(selected)}
            >
              Exercise
            </Button>
          </div>
          {message && (
            <p role="status" className="mt-2 text-xs text-up">
              {message}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-xs text-down">
              {error}
            </p>
          )}
        </div>
      )}
      {selected && contract && (
        <OrderBook
          embedded
          snapshot={
            books.get(selected) ??
            (restBook?.symbol === selected ? restBook : undefined)
          }
          onPick={(p) => {
            setPrice(p.toFixed(2));
            setType("limit");
          }}
        />
      )}
    </Panel>
  );
}

function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const code = (err.body as { error?: string })?.error;
    if (code === "market_frozen") return "Market frozen — cancellations only.";
    return code ?? fallback;
  }
  return fallback;
}
