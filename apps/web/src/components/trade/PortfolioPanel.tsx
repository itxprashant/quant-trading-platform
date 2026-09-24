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
    <div className="min-w-0 space-y-1 px-3 py-2.5">
      <div className="text-[11px] text-muted">{label}</div>
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
      <div className="text-[10px] uppercase tracking-wide text-faint">
        {label}
      </div>
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
  activeSymbol,
  mm = false,
}: {
  portfolio: Portfolio | null;
  prices: Map<string, PricePoint>;
  activeSymbol?: string;
  mm?: boolean;
}) {
  const metrics = portfolio?.metrics;
  return (
    <Panel className="flex h-full min-w-0 flex-col overflow-hidden">
      <PanelHeader title="Portfolio">
        {portfolio && (
          <span className="text-[11px] text-muted">
            {portfolio.positions.length} positions
          </span>
        )}
      </PanelHeader>
      <div
        tabIndex={0}
        role="region"
        aria-label="Portfolio balances and holdings"
        className="max-h-[360px] flex-1 overflow-y-auto focus-visible:outline-offset-[-2px]"
      >
        {!portfolio ? (
          <div className="px-4 py-8 text-center text-xs text-muted">
            <p>Portfolio not available yet.</p>
            <p className="mt-1 text-faint">
              Sign in and join this challenge to track your cash and positions.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 border-b border-border">
              <Stat label="Cash" value={money(portfolio.cash)} />
              <Stat label="Market value" value={money(portfolio.marketValue)} />
              <div className="min-w-0 space-y-1 px-3 py-2.5">
                <div className="text-[11px] text-muted">Total PnL</div>
                <FlashValue
                  value={portfolio.pnl}
                  format={(n) => signed(n)}
                  className={cn(
                    "text-sm font-semibold",
                    dirClass(portfolio.pnl),
                  )}
                />
              </div>
              {portfolio.freeCash !== undefined && (
                <div className="min-w-0 space-y-1 px-3 py-2.5">
                  <div className="text-[11px] text-muted">Free cash</div>
                  <FlashValue
                    value={portfolio.freeCash}
                    format={(n) => money(n)}
                    className={cn(
                      "text-sm font-semibold",
                      portfolio.freeCash <= 0 ? "text-down" : "text-text",
                    )}
                  />
                </div>
              )}
              {portfolio.loanDebt !== undefined && portfolio.loanDebt > 0 && (
                <Stat
                  label="Loan debt"
                  value={money(portfolio.loanDebt)}
                  tone="text-down"
                />
              )}
              <div className="min-w-0 space-y-1 px-3 py-2.5">
                <div className="text-[11px] text-muted">Score</div>
                <FlashValue
                  value={portfolio.score}
                  format={(n) => money(n)}
                  className="text-sm font-semibold text-accent"
                />
              </div>
            </div>

            {portfolio.bonds && portfolio.bonds.length > 0 && (
              <div className="border-t border-border">
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-faint">
                  Bonds
                </div>
                {portfolio.bonds.map((b) => (
                  <div
                    key={b.bondId}
                    className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-1.5 text-xs"
                  >
                    <span className="min-w-0 break-words">{b.name}</span>
                    <span className="mono text-right text-muted">
                      ×{b.quantity}
                    </span>
                    <span className="mono text-right text-up">
                      {money(b.couponsPaid)} paid
                    </span>
                  </div>
                ))}
              </div>
            )}

            {metrics && (
              <div className="grid grid-cols-2 gap-px border-t border-border bg-border">
                <Metric
                  label="Realized"
                  value={signed(metrics.realizedPnl)}
                  tone={dirClass(metrics.realizedPnl)}
                />
                <Metric
                  label="Volume"
                  value={metrics.volume.toLocaleString("en-US")}
                />
                {mm && (
                  <>
                    <Metric
                      label="Spread capture"
                      value={money(metrics.spreadCapture)}
                      tone="text-up"
                    />
                    <Metric
                      label="Quote uptime"
                      value={formatUptime(metrics.quoteUptime)}
                    />
                  </>
                )}
              </div>
            )}

            <div
              tabIndex={0}
              role="region"
              aria-label="Position details"
              className="border-t border-border focus-visible:outline-offset-[-2px]"
            >
              {portfolio.positions.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted">
                  No open positions. Filled orders appear here.
                </div>
              ) : (
                <table className="w-full table-fixed text-xs">
                  <caption className="sr-only">
                    Open positions and unrealized profit or loss
                  </caption>
                  <colgroup>
                    <col className="w-[28%]" />
                    <col className="w-[18%]" />
                    <col className="w-[27%]" />
                    <col className="w-[27%]" />
                  </colgroup>
                  <thead className="bg-surface-2 text-[10px] uppercase tracking-wide text-muted">
                    <tr>
                      <th
                        scope="col"
                        className="px-2 py-2 text-left font-medium"
                      >
                        Symbol
                      </th>
                      <th
                        scope="col"
                        className="px-1.5 py-2 text-right font-medium"
                      >
                        Qty
                      </th>
                      <th
                        scope="col"
                        className="px-1.5 py-2 text-right font-medium"
                      >
                        Avg
                      </th>
                      <th
                        scope="col"
                        className="px-2 py-2 text-right font-medium"
                      >
                        Unreal.
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {portfolio.positions.map((p) => {
                      const cur = prices.get(p.symbol)?.price ?? p.avgPrice;
                      const upnl = p.quantity * (cur - p.avgPrice);
                      const selected = activeSymbol === p.symbol;
                      return (
                        <tr
                          key={p.symbol}
                          aria-current={selected ? "true" : undefined}
                          className={cn(
                            selected
                              ? "bg-accent-subtle"
                              : "hover:bg-surface-2",
                          )}
                        >
                          <th
                            scope="row"
                            className={cn(
                              "mono truncate px-2 py-2 text-left font-medium",
                              selected && "text-accent",
                            )}
                          >
                            {p.symbol}
                          </th>
                          <td
                            className={cn(
                              "mono px-1.5 py-2 text-right",
                              dirClass(p.quantity),
                            )}
                          >
                            {p.quantity > 0 ? "+" : ""}
                            {p.quantity}
                          </td>
                          <td className="mono truncate px-1.5 py-2 text-right text-muted">
                            {money(p.avgPrice)}
                          </td>
                          <td
                            className={cn(
                              "mono truncate px-2 py-2 text-right",
                              dirClass(upnl),
                            )}
                          >
                            {signed(upnl)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
