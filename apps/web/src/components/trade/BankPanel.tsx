"use client";

import { useEffect, useState } from "react";
import { loanPayment } from "@/lib/eden";
import { Landmark } from "lucide-react";
import type { Portfolio } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ApiError, post } from "@/lib/api";
import { money } from "@/lib/format";
import { cn } from "@/lib/cn";

/**
 * The New Eden central bank: shows solvency (free cash) and lets a trader take
 * a predatory loan (borrow X now, owe 2× to the bank, bled back each minute).
 */
export function BankPanel({
  challengeId,
  portfolio,
  multiplier = 2,
  endsAt,
  carryRate = 1,
  disabled = false,
  onChange,
  className,
}: {
  challengeId: string;
  portfolio: Portfolio | null;
  multiplier?: number;
  endsAt?: string | null;
  carryRate?: number;
  disabled?: boolean;
  onChange?: () => void;
  className?: string;
}) {
  const [amount, setAmount] = useState("1000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const principal = Number(amount) || 0;
  const free = portfolio?.freeCash ?? 0;
  const breach = free <= 0;
  const payment = loanPayment(principal, multiplier, endsAt, now);

  async function borrow() {
    if (
      busy ||
      disabled ||
      payment == null ||
      !Number.isFinite(principal) ||
      principal <= 0 ||
      principal > 1_000_000
    )
      return;
    setError(null);
    setBusy(true);
    try {
      await post(`/api/loans/request`, { challengeId, principal });
      onChange?.();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? ((err.body as { error?: string })?.error ?? "Loan failed")
          : "Loan failed",
      );
    } finally {
      setBusy(false);
    }
  }

  const carryNow =
    (portfolio?.positions.reduce((sum, p) => sum + Math.abs(p.quantity), 0) ??
      0) * carryRate;

  return (
    <Panel className={cn("flex min-w-0 flex-col overflow-hidden", className)}>
      <PanelHeader
        title={
          <span className="flex items-center gap-1.5">
            <Landmark className="size-3.5" /> Bank
          </span>
        }
        className="min-h-9 px-3 py-1.5"
      />
      <div className="grid grid-cols-2 gap-x-2 border-b border-border px-3 py-1.5">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-faint">
            Free cash
          </div>
          <div
            className={cn(
              "mono truncate text-sm font-semibold",
              breach ? "text-down" : "text-text",
            )}
          >
            {portfolio ? money(free) : "—"}
          </div>
        </div>
        <div className="min-w-0 text-right">
          <div className="text-[10px] uppercase tracking-wide text-faint">
            Loan debt
          </div>
          <div className="mono truncate text-sm font-medium text-down">
            {money(portfolio?.loanDebt ?? 0)}
          </div>
        </div>
      </div>

      {portfolio && breach && (
        <div className="border-b border-down/30 bg-down-subtle px-3 py-1.5 text-[11px] leading-snug text-down">
          Free cash exhausted. A margin call is live; borrowing does not undo
          liquidation.
        </div>
      )}

      <div className="p-2.5">
        <div className="mb-1 flex items-end justify-between text-[11px] text-faint">
          <span>Borrow</span>
          <span>
            Repay{" "}
            <span className="mono text-warning">
              {money(principal * multiplier)}
            </span>
          </span>
        </div>
        <div className="flex gap-2">
          <Input
            type="number"
            min={1}
            max={1000000}
            step={100}
            aria-label="Amount to borrow"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mono h-8 min-w-0 px-2 text-xs"
          />
          <Button
            onClick={borrow}
            size="sm"
            loading={busy}
            disabled={
              disabled ||
              payment == null ||
              !Number.isFinite(principal) ||
              principal <= 0 ||
              principal > 1_000_000
            }
          >
            Borrow
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-muted">
          {payment != null
            ? `${money(payment)}/min`
            : "Needs a future session end"}{" "}
          · {multiplier}× · carry {money(carryRate)}/unit
          {portfolio ? ` · ${money(carryNow)} now` : ""}
        </p>
        {error && (
          <p role="alert" className="mt-1.5 text-[11px] text-down">
            {error}
          </p>
        )}
      </div>
    </Panel>
  );
}
