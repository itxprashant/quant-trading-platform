"use client";

import { useCallback, useEffect, useState } from "react";
import { Landmark } from "lucide-react";
import type { BondHolding, BondTemplate, Portfolio } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ApiError, get, post } from "@/lib/api";
import { money } from "@/lib/format";
import { loanPayment } from "@/lib/eden";

export function useBondMarket(challengeId: string, enabled: boolean) {
  const [templates, setTemplates] = useState<BondTemplate[]>([]);
  const [holdings, setHoldings] = useState<BondHolding[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const b = await get<{ templates: BondTemplate[]; holdings: BondHolding[] }>(
        `/api/markets/${challengeId}/bonds`,
      );
      setTemplates(b.templates);
      setHoldings(b.holdings);
      setError(null);
    } catch {
      setError("Could not refresh bonds. Retrying automatically.");
    }
  }, [challengeId, enabled]);

  useEffect(() => {
    if (!enabled) {
      setTemplates([]);
      setHoldings([]);
      return;
    }
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [enabled, load]);

  return { templates, holdings, error, reload: load };
}

/**
 * Government bonds sit off the watchlist: each series is bought once, at a
 * trader-chosen principal that must exceed free cash, then pays that amount
 * times the multiplier uniformly through the session end.
 */
export function BondPanel({
  challengeId,
  templates,
  holdings,
  portfolio,
  endsAt,
  refreshError,
  onChange,
  frozen = false,
}: {
  challengeId: string;
  templates: BondTemplate[];
  holdings: BondHolding[];
  portfolio: Portfolio | null;
  endsAt?: string | null;
  refreshError?: string | null;
  onChange?: () => void;
  frozen?: boolean;
}) {
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const available = templates.filter(
    (t) => !holdings.some((h) => h.bondId === t.id && h.quantity > 0),
  );
  const free = portfolio?.freeCash ?? 0;

  if (templates.length === 0 && !refreshError) return null;

  async function buy(id: string) {
    const price = Number(prices[id]);
    if (
      busy ||
      frozen ||
      !Number.isFinite(price) ||
      !(price > free) ||
      price > 1_000_000
    )
      return;
    setError(null);
    setBusy(id);
    try {
      await post(`/api/markets/bonds/purchase`, {
        challengeId,
        bondId: id,
        price,
      });
      setPrices((prev) => ({ ...prev, [id]: "" }));
      onChange?.();
    } catch (err) {
      setError(errText(err, "Bond purchase failed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel className="flex min-w-0 flex-col overflow-hidden">
      <PanelHeader
        title={
          <span className="flex items-center gap-1.5">
            <Landmark className="size-3.5" /> Government bonds
          </span>
        }
      />
      <div className="space-y-4 p-3">
        <p className="text-xs text-muted">
          Each series once. Price must exceed free cash ({money(free)}). You
          receive the chosen multiple uniformly until the session ends.
        </p>
        {refreshError && (
          <p role="alert" className="text-xs text-down">
            {refreshError}
          </p>
        )}
        {available.length === 0 && (
          <p className="text-xs text-faint">No government bonds left to buy.</p>
        )}
        {available.map((t) => {
          const multiplier = t.payoutMultiplier ?? 2;
          const price = Number(prices[t.id]) || 0;
          const payment = loanPayment(price, multiplier, endsAt, now);
          const valid =
            Number.isFinite(price) && price > free && price <= 1_000_000;
          return (
            <div key={t.id} className="space-y-2">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{t.name}</p>
                  <p className="text-[11px] text-faint">
                    {multiplier}× {price > 0 ? money(price * multiplier) : "—"}{" "}
                    paid
                    {payment != null ? ` at ${money(payment)} / minute` : ""}.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    min={0}
                    step={100}
                    placeholder="Price"
                    aria-label={`${t.name} price`}
                    value={prices[t.id] ?? ""}
                    onChange={(e) =>
                      setPrices((prev) => ({ ...prev, [t.id]: e.target.value }))
                    }
                    className="mono h-7 w-28 px-2 text-xs"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busy === t.id}
                    disabled={frozen || !valid || payment == null}
                    onClick={() => buy(t.id)}
                  >
                    Buy
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
        {error && (
          <p role="alert" className="text-xs text-down">
            {error}
          </p>
        )}
      </div>
    </Panel>
  );
}

function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const code = (err.body as { error?: string })?.error;
    if (code === "market_frozen") return "Market frozen — cancellations only.";
    if (code === "bond_limit") return "Already bought this bond.";
    if (code === "invalid_bond_deadline")
      return "Bonds need a future session end.";
    return code ?? fallback;
  }
  return fallback;
}
