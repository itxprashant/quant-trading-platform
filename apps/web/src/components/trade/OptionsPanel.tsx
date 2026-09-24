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
 * Options ticket for the instrument selected in the sidebar. Series for that
 * underlying are chosen from a compact select, not a second catalog.
 */
export function OptionsPanel({
  challengeId,
  contracts,
  prices,
  books,
  portfolio,
  activeSymbol,
  showBook = true,
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
  /** Sidebar selection: an underlying or a specific option series. */
  activeSymbol: string;
  /** Hide the docked book when the main book is already this series. */
  showBook?: boolean;
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
  const relevant = contracts.filter(
    (c) => c.symbol === activeSymbol || c.underlying === activeSymbol,
  );
  const contract = relevant.find((c) => c.symbol === selected);
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
    const pool = contracts.filter(
      (c) => c.symbol === activeSymbol || c.underlying === activeSymbol,
    );
    const next = pickSeries(pool, selected, exerciseWindowSec, Date.now());
    if (next !== selected) setSelected(next);
  }, [contracts, activeSymbol, selected, exerciseWindowSec]);

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

  const inWindow = relevant.some(
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

  if (relevant.length === 0) {
    if (!closedHint || contracts.length > 0) return null;
    return (
      <Panel className="flex min-w-0 flex-col overflow-hidden">
        <PanelHeader
          title={
            <span className="flex items-center gap-1.5">
              <Sigma className="size-3.5" /> Options
            </span>
          }
        />
        <p className="px-3 py-6 text-center text-xs text-faint">{closedHint}</p>
      </Panel>
    );
  }

  const intrinsic = contract
    ? intrinsicOf(contract, prices.get(contract.underlying)?.price)
    : null;
  const mark = contract ? prices.get(contract.symbol)?.price : undefined;

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

      <div className={cn("min-w-0", showBook && "grid lg:grid-cols-[minmax(0,1fr)_280px]")}>
        <section aria-label="Option order ticket" className="space-y-2.5 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {relevant.length > 1 ? (
                <Select
                  aria-label="Option series"
                  value={selected ?? ""}
                  onChange={(e) => setSelected(e.target.value)}
                  className="min-w-0 max-w-full"
                >
                  {relevant.map((c) => (
                    <option key={c.symbol} value={c.symbol}>
                      {c.optionType === "call" ? "C" : "P"} {c.underlying}{" "}
                      {c.strike}
                    </option>
                  ))}
                </Select>
              ) : contract ? (
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
            {contract && (
              <p className="text-[11px] text-faint">
                Mark{" "}
                <span className="mono text-muted">
                  {mark != null ? money(mark) : "—"}
                </span>
                {" · "}
                Intrinsic{" "}
                <span className={cn("mono", intrinsic && intrinsic > 0 ? "text-up" : "text-muted")}>
                  {intrinsic != null ? money(intrinsic) : "—"}
                </span>
              </p>
            )}
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
          {showBook ? (
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
          ) : null}
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
