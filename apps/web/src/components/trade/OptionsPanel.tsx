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

function deadlineText(
  c: OptionContract,
  exerciseWindowSec: number,
  now: number,
): string {
  const phase = optionPhase(c, exerciseWindowSec, now);
  if (phase.tradable)
    return `Expiry ${Math.max(0, Math.ceil((phase.expiry - now) / 1000))}s`;
  if (now < phase.deadline && c.status !== "expired")
    return `Exercise ${Math.max(0, Math.ceil((phase.deadline - now) / 1000))}s`;
  return "Expired";
}

/** Keep the current series while it is live; otherwise prefer a tradable one. */
function pickSeries(
  contracts: OptionContract[],
  current: string | null,
  exerciseWindowSec: number,
  now: number,
): string | null {
  const kept = contracts.find((c) => c.symbol === current);
  if (kept && kept.status !== "expired") return current;
  const next =
    contracts.find((c) => optionPhase(c, exerciseWindowSec, now).tradable) ??
    contracts.find((c) => optionPhase(c, exerciseWindowSec, now).exercisable) ??
    contracts.find((c) => c.status !== "expired");
  return next?.symbol ?? null;
}

function TypeChip({ type }: { type: OptionContract["optionType"] }) {
  return (
    <span
      className={cn(
        "rounded-sm px-1 text-[10px] font-semibold uppercase",
        type === "call" ? "bg-up-subtle text-up" : "bg-down-subtle text-down",
      )}
    >
      {type === "call" ? "C" : "P"}
    </span>
  );
}

/**
 * The options grinder (comp_desc Session 2). Series on the left; the order
 * ticket and depth for the selected series stay docked on the right so
 * traders can take liquidity and EXERCISE in-the-money contracts during the
 * 15-second window without reflowing the panel.
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
  closedHint,
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
  /** Shown when no cycle is open, e.g. when options list later in the event. */
  closedHint?: string;
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
    const next = pickSeries(contracts, selected, exerciseWindowSec, Date.now());
    if (next !== selected) setSelected(next);
  }, [contracts, selected, exerciseWindowSec]);

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
  const canTrade =
    !frozen &&
    !!phase?.tradable &&
    validQty &&
    quantity <= maxQuantity &&
    validPrice;

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
      setMessage("Order submitted. Check working orders and fills.");
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
          <span className="rounded-sm bg-warning/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
            Exercise window
          </span>
        )}
      </PanelHeader>

      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 lg:border-r lg:border-border">
          {contracts.length === 0 ? (
            <div className="px-3 py-10 text-center text-xs text-faint">
              <p>No option cycle is open right now.</p>
              {closedHint && <p className="mt-1">{closedHint}</p>}
            </div>
          ) : (
            <div className="max-h-[440px] overflow-auto">
              <table className="w-full min-w-[380px] text-xs">
                <caption className="sr-only">
                  Option contracts. Select a series to trade or exercise.
                </caption>
                <thead className="sticky top-0 bg-surface-2 text-faint">
                  <tr>
                    <th className="px-2.5 py-1.5 text-left font-medium">
                      Series
                    </th>
                    <th className="px-2.5 py-1.5 text-right font-medium">
                      Strike
                    </th>
                    <th className="px-2.5 py-1.5 text-right font-medium">
                      Mark
                    </th>
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
                          isSel ? "bg-accent-subtle" : "hover:bg-surface-2",
                        )}
                      >
                        <td className="px-2.5 py-1.5">
                          <button
                            type="button"
                            aria-pressed={isSel}
                            aria-label={`Select ${c.symbol}`}
                            onClick={() => setSelected(c.symbol)}
                            className="inline-flex items-center gap-1 rounded py-1 text-left focus-visible:outline-2 focus-visible:outline-accent"
                          >
                            <TypeChip type={c.optionType} />
                            <span
                              className={isSel ? "text-accent" : "text-muted"}
                            >
                              {c.underlying}
                            </span>
                          </button>
                        </td>
                        <td className="px-2.5 py-1.5 text-right mono">
                          {c.strike}
                        </td>
                        <td className="px-2.5 py-1.5 text-right mono">
                          {mark != null ? money(mark) : "—"}
                        </td>
                        <td className="px-2.5 py-1.5 text-right mono text-muted">
                          {deadlineText(c, exerciseWindowSec, now)}
                        </td>
                        <td
                          className={cn(
                            "px-2.5 py-1.5 text-right mono",
                            intrinsic && intrinsic > 0
                              ? "text-up"
                              : "text-faint",
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
        </div>

        <div className="flex min-w-0 flex-col border-t border-border lg:border-t-0">
          <section aria-label="Option order ticket" className="space-y-2.5 p-3">
            <div className="flex items-center justify-between gap-2">
              {contract ? (
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                  <TypeChip type={contract.optionType} />
                  <span className="truncate">
                    {contract.underlying} {money(contract.strike)}
                  </span>
                </span>
              ) : (
                <span className="text-sm text-faint">No series selected</span>
              )}
              {contract && (
                <span
                  className={cn(
                    "mono shrink-0 text-xs",
                    phase?.exercisable ? "text-warning" : "text-muted",
                  )}
                >
                  {deadlineText(contract, exerciseWindowSec, now)}
                </span>
              )}
            </div>
            <p className="text-[11px] text-faint">
              Held <span className="mono text-muted">{held}</span> · Orders 1–
              {maxQuantity} · Cap ±{positionCap}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Select
                aria-label="Option order type"
                value={type}
                disabled={!contract}
                onChange={(e) => setType(e.target.value as "limit" | "market")}
              >
                <option value="limit">Limit</option>
                <option value="market">Market</option>
              </Select>
              <Input
                type="number"
                min={1}
                aria-label="Option quantity"
                value={qty}
                disabled={!contract}
                onChange={(e) => setQty(e.target.value)}
                className="mono"
              />
              {type === "limit" && (
                <Input
                  aria-label="Option limit price"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={price}
                  disabled={!contract}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="Limit price"
                  className="mono col-span-2"
                />
              )}
              <Button
                variant="buy"
                size="sm"
                loading={busy}
                disabled={!canTrade}
                onClick={() => selected && trade(selected, "buy")}
              >
                Buy
              </Button>
              <Button
                variant="sell"
                size="sm"
                loading={busy}
                disabled={!canTrade}
                onClick={() => selected && trade(selected, "sell")}
              >
                Sell
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="col-span-2"
                loading={busy}
                disabled={
                  frozen || !phase?.exercisable || !validQty || quantity > held
                }
                onClick={() => selected && exercise(selected)}
              >
                Exercise
              </Button>
            </div>
            {contract && phase && (
              <p className="text-[11px] leading-relaxed text-faint">
                Expires {new Date(phase.expiry).toLocaleTimeString()}; exercise
                closes {new Date(phase.deadline).toLocaleTimeString()}. Manual
                exercise only, within {exerciseWindowSec}s of expiry; missed
                contracts expire worthless. Exercising{" "}
                {contract.optionType === "call" ? "receives" : "delivers"}{" "}
                {contract.underlying} at strike. Assignment can breach
                inventory limits; restore capacity within 30s.
              </p>
            )}
            {message && (
              <p role="status" className="text-xs text-up">
                {message}
              </p>
            )}
            {error && (
              <p role="alert" className="text-xs text-down">
                {error}
              </p>
            )}
          </section>
          <OrderBook
            embedded
            depth={6}
            snapshot={
              selected
                ? (books.get(selected) ??
                  (restBook?.symbol === selected ? restBook : undefined))
                : undefined
            }
            onPick={(p) => {
              setPrice(p.toFixed(2));
              setType("limit");
            }}
          />
        </div>
      </div>
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
