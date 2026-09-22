"use client";

import { useEffect, useState } from "react";
import { loanPayment } from "@/lib/eden";
import { Landmark } from "lucide-react";
import type { Loan, Portfolio } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ApiError, get, post } from "@/lib/api";
import { money } from "@/lib/format";
import { cn } from "@/lib/cn";

type ScheduledLoan = Loan & {
  installment?: number;
  nextPaymentAt?: string | null;
  fundedAt?: string | null;
};

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
}: {
  challengeId: string;
  portfolio: Portfolio | null;
  multiplier?: number;
  endsAt?: string | null;
  carryRate?: number;
  disabled?: boolean;
  onChange?: () => void;
}) {
  const [amount, setAmount] = useState("1000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [loans, setLoans] = useState<ScheduledLoan[] | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let loading = false;
    setLoans(null);
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const rows = await get<ScheduledLoan[]>(`/api/loans/${challengeId}`);
        if (!cancelled) {
          setLoans(rows);
          setScheduleError(null);
        }
      } catch {
        if (!cancelled)
          setScheduleError(
            "Loan schedule refresh failed. Retrying automatically.",
          );
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [challengeId]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const principal = Number(amount) || 0;
  const free = portfolio?.freeCash ?? 0;
  const breach = free <= 0;
  const payment = loanPayment(principal, multiplier, endsAt, now);
  const activeLoans = (loans ?? portfolio?.loans ?? []).filter(
    (loan) => loan.status === "active",
  ) as ScheduledLoan[];

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
      const response = await post<{ loan: ScheduledLoan }>(
        `/api/loans/request`,
        { challengeId, principal },
      );
      setLoans((rows) => [
        response.loan,
        ...(rows ?? portfolio?.loans ?? []).filter(
          (loan) => loan.id !== response.loan.id,
        ),
      ]);
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

  return (
    <Panel className="flex min-w-0 flex-col overflow-hidden">
      <PanelHeader
        title={
          <span className="flex items-center gap-1.5">
            <Landmark className="size-3.5" /> Bank
          </span>
        }
      />
      <div className="divide-y divide-border">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm text-muted">Free cash</span>
          <span
            className={cn(
              "mono text-sm font-semibold",
              breach ? "text-down" : "text-text",
            )}
          >
            {portfolio ? money(free) : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-sm text-muted">Loan debt</span>
          <span className="mono text-sm font-medium text-down">
            {money(portfolio?.loanDebt ?? 0)}
          </span>
        </div>
      </div>

      {activeLoans.length > 0 && (
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[420px] text-xs">
            <caption className="px-3 py-2 text-left font-medium text-muted">
              Active loan repayment schedule
            </caption>
            <thead className="bg-surface-2 text-faint">
              <tr>
                <th className="px-3 py-2 text-right font-medium">Remaining</th>
                <th className="px-3 py-2 text-right font-medium">
                  Fixed / minute
                </th>
                <th className="px-3 py-2 text-left font-medium">
                  Next payment
                </th>
                <th className="px-3 py-2 text-left font-medium">Funding</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {activeLoans.map((loan) => (
                <tr key={loan.id}>
                  <td className="mono px-3 py-2 text-right">
                    {money(loan.remaining)}
                  </td>
                  <td className="mono px-3 py-2 text-right">
                    {loan.installment != null
                      ? money(loan.installment)
                      : "Awaiting schedule"}
                  </td>
                  <td className="mono px-3 py-2">
                    {loan.nextPaymentAt
                      ? Date.parse(loan.nextPaymentAt) <= now
                        ? "Due, awaiting debit"
                        : new Date(loan.nextPaymentAt).toLocaleTimeString()
                      : "Awaiting schedule"}
                  </td>
                  <td className="px-3 py-2">
                    {loan.fundedAt === null
                      ? "Pending funding"
                      : loan.fundedAt
                        ? `Funded ${new Date(loan.fundedAt).toLocaleTimeString()}`
                        : "Awaiting status"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {scheduleError && (
        <p role="alert" className="px-3 py-2 text-xs text-down">
          {scheduleError}
        </p>
      )}

      {portfolio && breach && (
        <div className="border-t border-down/30 bg-down-subtle px-3 py-2 text-xs text-down">
          Free cash is exhausted. A margin call triggers immediately; borrowing
          does not undo liquidation.
        </div>
      )}

      <div className="border-t border-border p-3">
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
            className="mono min-w-0"
          />
          <Button
            onClick={borrow}
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
        <p className="mt-2 text-xs text-muted">
          New loan estimate (not your existing schedule):{" "}
          {payment != null
            ? `${money(payment)} / minute`
            : "requires a future session end"}
          . Set when borrowing: {multiplier}x principal divided by remaining
          minutes, deducted every minute.
        </p>
        <p className="mt-2 text-xs text-muted">
          Carry: {money(carryRate)} per absolute inventory unit / minute.
          Current inventory estimate:{" "}
          {money(
            (portfolio?.positions.reduce(
              (sum, p) => sum + Math.abs(p.quantity),
              0,
            ) ?? 0) * carryRate,
          )}{" "}
          / minute.
        </p>
        {error && (
          <p role="alert" className="mt-2 text-xs text-down">
            {error}
          </p>
        )}
      </div>
    </Panel>
  );
}
