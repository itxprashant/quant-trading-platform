"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatInstrumentLabel,
  type AdminStatistics,
  type AdminStatisticsRow,
  type Challenge,
} from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { get } from "@/lib/api";
import { cn } from "@/lib/cn";
import { dirClass, money, signed } from "@/lib/format";

const REFRESH_MS = 2000;

type SortKey =
  | "name"
  | "cash"
  | "loan"
  | "assets"
  | "equity"
  | "pnl"
  | `hold:${string}`;

function qtyClass(n: number): string {
  if (n > 0) return "text-text";
  if (n < 0) return "text-down";
  return "text-faint";
}

function rowValue(row: AdminStatisticsRow, key: SortKey): number | string {
  if (key === "name") return row.username;
  if (key === "cash") return row.cash;
  if (key === "loan") return row.loanDebt;
  if (key === "assets") return row.assets;
  if (key === "equity") return row.equity;
  if (key === "pnl") return row.pnl;
  return row.holdings[key.slice("hold:".length)] ?? 0;
}

export function StatisticsPanel({ challenge }: { challenge: Challenge }) {
  const challengeId = challenge.id;
  const [sheet, setSheet] = useState<AdminStatistics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "name",
    dir: "asc",
  });

  const load = useCallback(async () => {
    try {
      const next = await get<AdminStatistics>(
        `/api/admin/${challengeId}/statistics`,
      );
      setSheet(next);
      setError(null);
    } catch {
      setError("Could not refresh trader statistics.");
    } finally {
      setLoading(false);
    }
  }, [challengeId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const rows = sheet?.rows ?? [];
  const showLoan =
    challenge.type === "new_eden" || rows.some((row) => row.loanDebt !== 0);
  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const matched = needle
      ? rows.filter(
          (row) =>
            row.username.toLowerCase().includes(needle) ||
            row.displayName.toLowerCase().includes(needle),
        )
      : rows;
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...matched].sort((a, b) => {
      const left = rowValue(a, sort.key);
      const right = rowValue(b, sort.key);
      if (typeof left === "string" && typeof right === "string") {
        return left.localeCompare(right) * factor;
      }
      return ((left as number) - (right as number)) * factor;
    });
  }, [needle, rows, sort]);

  function toggleSort(key: SortKey) {
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" ? "asc" : "desc" },
    );
  }

  const totals = useMemo(() => {
    const holdings: Record<string, number> = {};
    let cash = 0;
    let loanDebt = 0;
    let assets = 0;
    let equity = 0;
    let pnl = 0;
    for (const row of visible) {
      cash += row.cash;
      loanDebt += row.loanDebt;
      assets += row.assets;
      equity += row.equity;
      pnl += row.pnl;
      for (const [id, quantity] of Object.entries(row.holdings)) {
        holdings[id] = (holdings[id] ?? 0) + quantity;
      }
    }
    return { holdings, cash, loanDebt, assets, equity, pnl };
  }, [visible]);

  const updated = sheet
    ? new Date(sheet.asOf).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;
  const columns = sheet?.columns ?? [];
  const colSpan = 2 + (showLoan ? 1 : 0) + columns.length + 3;

  return (
    <section id="statistics" className="scroll-mt-20">
      <Panel>
        <PanelHeader title="Statistics">
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="stats-filter">
              Filter traders
            </label>
            <input
              id="stats-filter"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter traders"
              className="h-8 w-40 rounded-md border border-border-strong bg-bg px-2 text-xs text-text outline-none placeholder:text-faint focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40"
            />
            <span className="mono text-[11px] text-muted">
              {loading && !sheet
                ? "Loading"
                : `${visible.length} trader${visible.length === 1 ? "" : "s"}`}
              {updated ? ` · ${updated}` : ""}
            </span>
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              Refresh
            </Button>
          </div>
        </PanelHeader>
        {error && (
          <p role="alert" className="border-b border-border px-4 py-2 text-xs text-down">
            {error}
          </p>
        )}
        <p className="border-b border-border px-4 py-2 text-xs text-muted lg:hidden">
          Scroll horizontally to see every asset.
        </p>
        <div
          className="max-h-[32rem] overflow-auto"
          tabIndex={0}
          role="region"
          aria-label="Trader statistics"
          aria-busy={loading && !sheet}
        >
          <table className="w-full min-w-[720px] border-separate border-spacing-0 text-left text-xs">
            <thead className="sticky top-0 z-20 bg-surface-2 text-[11px] uppercase tracking-wider text-muted">
              <tr>
                <SortHead
                  label="Trader"
                  active={sort.key === "name"}
                  dir={sort.dir}
                  onClick={() => toggleSort("name")}
                  className="sticky left-0 z-30 bg-surface-2 text-left"
                />
                <SortHead
                  label="Cash"
                  active={sort.key === "cash"}
                  dir={sort.dir}
                  onClick={() => toggleSort("cash")}
                />
                {showLoan && (
                  <SortHead
                    label="Loan"
                    active={sort.key === "loan"}
                    dir={sort.dir}
                    onClick={() => toggleSort("loan")}
                  />
                )}
                {columns.map((column) => (
                  <SortHead
                    key={column.id}
                    label={
                      column.kind === "symbol"
                        ? formatInstrumentLabel(column.label)
                        : column.label
                    }
                    hint={money(column.mark)}
                    active={sort.key === `hold:${column.id}`}
                    dir={sort.dir}
                    onClick={() => toggleSort(`hold:${column.id}`)}
                  />
                ))}
                <SortHead
                  label="Assets"
                  active={sort.key === "assets"}
                  dir={sort.dir}
                  onClick={() => toggleSort("assets")}
                />
                <SortHead
                  label="Equity"
                  active={sort.key === "equity"}
                  dir={sort.dir}
                  onClick={() => toggleSort("equity")}
                />
                <SortHead
                  label="PnL"
                  active={sort.key === "pnl"}
                  dir={sort.dir}
                  onClick={() => toggleSort("pnl")}
                />
              </tr>
            </thead>
            <tbody>
              {loading && !sheet && (
                <tr>
                  <td colSpan={colSpan} className="px-4 py-8 text-muted">
                    Loading trader statistics...
                  </td>
                </tr>
              )}
              {sheet && visible.length === 0 && (
                <tr>
                  <td colSpan={colSpan} className="px-4 py-8 text-muted">
                    {rows.length === 0
                      ? "No traders are enrolled in this event yet."
                      : "No traders match that filter."}
                  </td>
                </tr>
              )}
              {visible.map((row) => (
                <tr key={row.userId} className="group hover:bg-surface-2">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border-b border-border bg-surface px-3 py-2 text-left font-normal group-hover:bg-surface-2"
                  >
                    <span className="block max-w-44 truncate font-medium">
                      {row.displayName}
                    </span>
                    <span className="block truncate text-[11px] text-muted">
                      {row.username}
                    </span>
                  </th>
                  <Num>{money(row.cash)}</Num>
                  {showLoan && <Num>{money(row.loanDebt)}</Num>}
                  {columns.map((column) => {
                    const quantity = row.holdings[column.id] ?? 0;
                    return (
                      <Num key={column.id} className={qtyClass(quantity)}>
                        {quantity === 0 ? "0" : signed(quantity, 0)}
                      </Num>
                    );
                  })}
                  <Num>{money(row.assets)}</Num>
                  <Num>{money(row.equity)}</Num>
                  <Num className={dirClass(row.pnl)}>{signed(row.pnl)}</Num>
                </tr>
              ))}
            </tbody>
            {visible.length > 0 && (
              <tfoot className="sticky bottom-0 z-20 bg-surface-2 font-medium">
                <tr>
                  <th
                    scope="row"
                    className="sticky left-0 z-30 border-t border-border bg-surface-2 px-3 py-2 text-left font-medium"
                  >
                    {needle ? "Shown" : "All enrolled"}
                  </th>
                  <Num className="border-t border-border">{money(totals.cash)}</Num>
                  {showLoan && (
                    <Num className="border-t border-border">
                      {money(totals.loanDebt)}
                    </Num>
                  )}
                  {columns.map((column) => {
                    const quantity = totals.holdings[column.id] ?? 0;
                    return (
                      <Num
                        key={column.id}
                        className={cn("border-t border-border", qtyClass(quantity))}
                      >
                        {quantity === 0 ? "0" : signed(quantity, 0)}
                      </Num>
                    );
                  })}
                  <Num className="border-t border-border">{money(totals.assets)}</Num>
                  <Num className="border-t border-border">{money(totals.equity)}</Num>
                  <Num className={cn("border-t border-border", dirClass(totals.pnl))}>
                    {signed(totals.pnl)}
                  </Num>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Panel>
    </section>
  );
}

function SortHead({
  label,
  hint,
  active,
  dir,
  onClick,
  className,
}: {
  label: string;
  hint?: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={cn(
        "border-b border-border px-3 py-2 text-right font-medium",
        className,
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "inline-flex w-full flex-col items-end rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          className?.includes("text-left") && "items-start",
          active ? "text-text" : "hover:text-text",
        )}
      >
        <span>
          {label}
          {active ? (dir === "asc" ? " ↑" : " ↓") : ""}
        </span>
        {hint && (
          <span className="text-[10px] font-normal normal-case tracking-normal text-faint">
            {hint}
          </span>
        )}
      </button>
    </th>
  );
}

function Num({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <td
      className={cn(
        "mono border-b border-border px-3 py-2 text-right tabular-nums",
        className,
      )}
    >
      {children}
    </td>
  );
}
