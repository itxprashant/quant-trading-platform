"use client";

import { useState } from "react";
import { Sigma } from "lucide-react";
import type { OptionContract, PricePoint } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ApiError, post } from "@/lib/api";
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
  onChange,
}: {
  challengeId: string;
  contracts: OptionContract[];
  prices: Map<string, PricePoint>;
  onChange?: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [qty, setQty] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inWindow = contracts.some((c) => c.status === "exercise_window");

  async function trade(symbol: string, side: "buy" | "sell") {
    setError(null);
    setBusy(true);
    try {
      await post(`/api/orders`, {
        challengeId,
        symbol,
        side,
        type: "market",
        quantity: Number(qty) || 1,
      });
      onChange?.();
    } catch (err) {
      setError(errText(err, "Order failed"));
    } finally {
      setBusy(false);
    }
  }

  async function exercise(symbol: string) {
    setError(null);
    setBusy(true);
    try {
      await post(`/api/options/exercise`, {
        challengeId,
        symbol,
        quantity: Number(qty) || 1,
      });
      onChange?.();
    } catch (err) {
      setError(errText(err, "Exercise failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="flex flex-col">
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
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-2 text-faint">
              <tr>
                <th className="px-2.5 py-1.5 text-left font-medium">Series</th>
                <th className="px-2.5 py-1.5 text-right font-medium">Strike</th>
                <th className="px-2.5 py-1.5 text-right font-medium">Mark</th>
                <th className="px-2.5 py-1.5 text-right font-medium">Intrinsic</th>
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
                    </td>
                    <td className="px-2.5 py-1.5 text-right mono">{c.strike}</td>
                    <td className="px-2.5 py-1.5 text-right mono">
                      {mark != null ? money(mark) : "—"}
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

      {selected && (
        <div className="border-t border-border p-3">
          <div className="mb-2 flex items-center justify-between text-[11px] text-faint">
            <span className="mono text-muted">{selected}</span>
          </div>
          <div className="flex gap-2">
            <Input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="mono w-20"
            />
            <Button
              variant="buy"
              size="sm"
              loading={busy}
              onClick={() => trade(selected, "buy")}
            >
              Buy
            </Button>
            <Button
              variant="sell"
              size="sm"
              loading={busy}
              onClick={() => trade(selected, "sell")}
            >
              Sell
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              disabled={
                contracts.find((c) => c.symbol === selected)?.status !==
                "exercise_window"
              }
              onClick={() => exercise(selected)}
            >
              Exercise
            </Button>
          </div>
          {error && <p className="mt-2 text-xs text-down">{error}</p>}
        </div>
      )}
    </Panel>
  );
}

function errText(err: unknown, fallback: string): string {
  return err instanceof ApiError
    ? ((err.body as { error?: string })?.error ?? fallback)
    : fallback;
}
