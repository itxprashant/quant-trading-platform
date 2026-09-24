"use client";

import { useCallback, useEffect, useState } from "react";
import { Landmark } from "lucide-react";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ApiError, get, post } from "@/lib/api";
import { money } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { MarketKind } from "./MarketList";

interface EtfView {
  symbol: string;
  name: string | null;
  basket: { symbol: string; weight: number }[];
  nav: number;
  marketPrice: number | null;
  windowOpen: boolean;
}

/**
 * Create/redeem for the ETF selected in the sidebar. Bonds live on BondPanel.
 */
export function MarketsPanel({
  challengeId,
  activeSymbol,
  activeKind,
  onChange,
  frozen = false,
}: {
  challengeId: string;
  activeSymbol: string;
  activeKind: MarketKind;
  onChange?: () => void;
  frozen?: boolean;
}) {
  const [etfs, setEtfs] = useState<EtfView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [etfQty, setEtfQty] = useState("");

  const loadEtfs = useCallback(async () => {
    try {
      const e = await get<{ etfs: EtfView[] }>(
        `/api/markets/${challengeId}/etfs`,
      );
      setEtfs(e.etfs);
    } catch {
      /* create/redeem stays closed until the next poll */
    }
  }, [challengeId]);

  useEffect(() => {
    void loadEtfs();
    const t = setInterval(loadEtfs, 5000);
    return () => clearInterval(t);
  }, [loadEtfs]);

  async function etfTrade(symbol: string, action: "create" | "redeem") {
    setError(null);
    setBusy(`etf:${symbol}:${action}`);
    try {
      await post(`/api/markets/etfs/trade`, {
        challengeId,
        etfSymbol: symbol,
        action,
        quantity: Number(etfQty) || 1,
      });
      onChange?.();
    } catch (err) {
      setError(errText(err, "ETF trade failed"));
    } finally {
      setBusy(null);
    }
  }

  const etf =
    activeKind === "etf"
      ? etfs.find((e) => e.symbol === activeSymbol)
      : undefined;

  if (!etf) return null;

  return (
    <Panel className="flex min-w-0 flex-col overflow-hidden">
      <PanelHeader
        title={
          <span className="flex items-center gap-1.5">
            <Landmark className="size-3.5" /> ETF window
          </span>
        }
      />
      <div className="space-y-4 p-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
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
              {etf.marketPrice != null && (
                <p
                  className={cn(
                    "mono text-[10px]",
                    etf.marketPrice - etf.nav > 0
                      ? "text-up"
                      : etf.marketPrice - etf.nav < 0
                        ? "text-down"
                        : "text-faint",
                  )}
                >
                  {etf.marketPrice - etf.nav >= 0 ? "+" : ""}
                  {money(etf.marketPrice - etf.nav)} vs mkt
                </p>
              )}
            </div>
          </div>
          <p className="text-xs text-muted">
            1 {etf.symbol} ={" "}
            {etf.basket
              .map((leg) => `${leg.weight} ${leg.symbol}`)
              .join(" + ")}
            . Creation delivers the basket; redemption receives it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              type="number"
              min={1}
              placeholder="1"
              aria-label={`${etf.symbol} quantity`}
              value={etfQty}
              onChange={(e) => setEtfQty(e.target.value)}
              className="mono h-7 w-16 px-2 text-xs"
            />
            <Button
              variant="buy"
              size="sm"
              disabled={frozen || !etf.windowOpen}
              loading={busy === `etf:${etf.symbol}:create`}
              onClick={() => etfTrade(etf.symbol, "create")}
            >
              Create
            </Button>
            <Button
              variant="sell"
              size="sm"
              disabled={frozen || !etf.windowOpen}
              loading={busy === `etf:${etf.symbol}:redeem`}
              onClick={() => etfTrade(etf.symbol, "redeem")}
            >
              Redeem
            </Button>
          </div>
        </div>

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
    return code ?? fallback;
  }
  return fallback;
}
