"use client";

import { useCallback, useEffect, useState } from "react";
import { Landmark } from "lucide-react";
import type { BondHolding, BondTemplate } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ApiError, get, post } from "@/lib/api";
import { money } from "@/lib/format";
import { cn } from "@/lib/cn";

interface EtfView {
  symbol: string;
  name: string | null;
  basket: { symbol: string; weight: number }[];
  nav: number;
  marketPrice: number | null;
  windowOpen: boolean;
}

/**
 * Fixed-income + structured products desk (New Eden Session 1): buy bonds for
 * coupon income and create/redeem ETF units against NAV when a window is open.
 */
export function MarketsPanel({
  challengeId,
  onChange,
}: {
  challengeId: string;
  onChange?: () => void;
}) {
  const [templates, setTemplates] = useState<BondTemplate[]>([]);
  const [holdings, setHoldings] = useState<BondHolding[]>([]);
  const [etfs, setEtfs] = useState<EtfView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [etfQty, setEtfQty] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [b, e] = await Promise.all([
        get<{ templates: BondTemplate[]; holdings: BondHolding[] }>(
          `/api/markets/${challengeId}/bonds`,
        ),
        get<{ etfs: EtfView[] }>(`/api/markets/${challengeId}/etfs`),
      ]);
      setTemplates(b.templates);
      setHoldings(b.holdings);
      setEtfs(e.etfs);
    } catch {
      /* ignore — panel only shows when eden config present */
    }
  }, [challengeId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function buyBond(id: string) {
    setError(null);
    setBusy(`bond:${id}`);
    try {
      await post(`/api/markets/bonds/purchase`, {
        challengeId,
        bondId: id,
        quantity: 1,
      });
      setTimeout(load, 400);
      onChange?.();
    } catch (err) {
      setError(errText(err, "Bond purchase failed"));
    } finally {
      setBusy(null);
    }
  }

  async function etfTrade(symbol: string, action: "create" | "redeem") {
    setError(null);
    setBusy(`etf:${symbol}:${action}`);
    try {
      await post(`/api/markets/etfs/trade`, {
        challengeId,
        etfSymbol: symbol,
        action,
        quantity: Number(etfQty[symbol]) || 1,
      });
      setTimeout(load, 400);
      onChange?.();
    } catch (err) {
      setError(errText(err, "ETF trade failed"));
    } finally {
      setBusy(null);
    }
  }

  if (templates.length === 0 && etfs.length === 0) return null;

  return (
    <Panel className="flex flex-col">
      <PanelHeader
        title={
          <span className="flex items-center gap-1.5">
            <Landmark className="size-3.5" /> Bonds &amp; ETFs
          </span>
        }
      />
      <div className="space-y-4 p-3">
        {templates.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">
              Bonds
            </p>
            {templates.map((t) => {
              const held = holdings.find((h) => h.bondId === t.id);
              const coupon =
                t.couponPer5Min != null
                  ? `${money(t.couponPer5Min)}/5m`
                  : t.peggedYield
                    ? "pegged"
                    : "—";
              return (
                <div
                  key={t.id}
                  className="flex items-center justify-between rounded-lg border border-border bg-surface-2 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">{t.name}</p>
                    <p className="mono text-[11px] text-faint">
                      {money(t.price)} → face {money(t.faceValue)} · cpn {coupon}
                      {held ? ` · held ${held.quantity}` : ""}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busy === `bond:${t.id}`}
                    disabled={held != null && held.quantity >= t.maxPerUser}
                    onClick={() => buyBond(t.id)}
                  >
                    Buy
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {etfs.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-faint">
              ETFs
            </p>
            {etfs.map((etf) => {
              const premium =
                etf.marketPrice != null ? etf.marketPrice - etf.nav : null;
              return (
                <div
                  key={etf.symbol}
                  className="rounded-lg border border-border bg-surface-2 px-3 py-2"
                >
                  <div className="mb-1.5 flex items-center justify-between">
                    <div>
                      <span className="text-xs font-medium">{etf.symbol}</span>
                      <span
                        className={cn(
                          "ml-2 rounded px-1 text-[10px] font-semibold uppercase",
                          etf.windowOpen
                            ? "bg-up-subtle text-up"
                            : "bg-surface-3 text-faint",
                        )}
                      >
                        {etf.windowOpen ? "Window open" : "Window closed"}
                      </span>
                    </div>
                    <div className="text-right">
                      <p className="mono text-xs">NAV {money(etf.nav)}</p>
                      {premium != null && (
                        <p
                          className={cn(
                            "mono text-[10px]",
                            premium > 0 ? "text-up" : premium < 0 ? "text-down" : "text-faint",
                          )}
                        >
                          {premium >= 0 ? "+" : ""}
                          {money(premium)} vs mkt
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      min={1}
                      placeholder="1"
                      value={etfQty[etf.symbol] ?? ""}
                      onChange={(e) =>
                        setEtfQty((q) => ({ ...q, [etf.symbol]: e.target.value }))
                      }
                      className="mono h-7 w-16 px-2 text-xs"
                    />
                    <Button
                      variant="buy"
                      size="sm"
                      disabled={!etf.windowOpen}
                      loading={busy === `etf:${etf.symbol}:create`}
                      onClick={() => etfTrade(etf.symbol, "create")}
                    >
                      Create
                    </Button>
                    <Button
                      variant="sell"
                      size="sm"
                      disabled={!etf.windowOpen}
                      loading={busy === `etf:${etf.symbol}:redeem`}
                      onClick={() => etfTrade(etf.symbol, "redeem")}
                    >
                      Redeem
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {error && <p className="text-xs text-down">{error}</p>}
      </div>
    </Panel>
  );
}

function errText(err: unknown, fallback: string): string {
  return err instanceof ApiError
    ? ((err.body as { error?: string })?.error ?? fallback)
    : fallback;
}
