"use client";

import type { Portfolio, PricePoint } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { FlashValue } from "@/components/ui/Value";
import { money, signed, dirClass } from "@/lib/format";
import { cn } from "@/lib/cn";

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className="text-sm text-muted">{label}</span>
      <span className={cn("mono text-sm font-medium", tone)}>{value}</span>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <div className="bg-surface px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-faint">{label}</div>
      <div className={cn("mono mt-0.5 text-sm font-medium", tone)}>{value}</div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function PortfolioPanel({
  portfolio,
  prices,
  mm = false,
}: {
  portfolio: Portfolio | null;
  prices: Map<string, PricePoint>;
  mm?: boolean;
}) {
  const metrics = portfolio?.metrics;
  return (
    <Panel className="flex flex-col">
      <PanelHeader title="Portfolio" />
      {!portfolio ? (
        <div className="px-3 py-6 text-center text-sm text-faint">
          Place a trade to start your book.
        </div>
      ) : (
        <>
          <div className="divide-y divide-border">
            <Stat label="Cash" value={money(portfolio.cash)} />
            <Stat label="Market value" value={money(portfolio.marketValue)} />
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-sm text-muted">PnL</span>
              <FlashValue
                value={portfolio.pnl}
                format={(n) => signed(n)}
                className={cn("text-sm font-semibold", dirClass(portfolio.pnl))}
              />
            </div>
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-sm text-muted">Score</span>
              <FlashValue
                value={portfolio.score}
                format={(n) => money(n)}
                className="text-sm font-semibold text-accent"
              />
            </div>
          </div>

          {metrics && (
            <div className="grid grid-cols-2 gap-px border-t border-border bg-border">
              <Metric label="Realized" value={signed(metrics.realizedPnl)} tone={dirClass(metrics.realizedPnl)} />
              <Metric label="Volume" value={metrics.volume.toLocaleString("en-US")} />
              {mm && (
                <>
                  <Metric label="Spread capt." value={money(metrics.spreadCapture)} tone="text-up" />
                  <Metric label="Quote uptime" value={formatUptime(metrics.quoteUptime)} />
                </>
              )}
            </div>
          )}

          <div className="border-t border-border">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wide text-faint">
              <span>Symbol</span>
              <span className="text-right">Qty</span>
              <span className="text-right">Avg</span>
              <span className="text-right">uPnL</span>
            </div>
            {portfolio.positions.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-faint">No open positions</div>
            ) : (
              portfolio.positions.map((p) => {
                const cur = prices.get(p.symbol)?.price ?? p.avgPrice;
                const upnl = p.quantity * (cur - p.avgPrice);
                return (
                  <div
                    key={p.symbol}
                    className="grid grid-cols-[1fr_auto_auto_auto] gap-2 px-3 py-1.5 text-xs"
                  >
                    <span className="mono">{p.symbol}</span>
                    <span className={cn("mono text-right", dirClass(p.quantity))}>
                      {p.quantity > 0 ? "+" : ""}
                      {p.quantity}
                    </span>
                    <span className="mono text-right text-muted">{money(p.avgPrice)}</span>
                    <span className={cn("mono text-right", dirClass(upnl))}>{signed(upnl)}</span>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </Panel>
  );
}
