"use client";

import { useState } from "react";
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
  onChange,
}: {
  challengeId: string;
  portfolio: Portfolio | null;
  multiplier?: number;
  onChange?: () => void;
}) {
  const [amount, setAmount] = useState("1000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const principal = Number(amount) || 0;
  const free = portfolio?.freeCash ?? 0;
  const breach = free <= 0;

  async function borrow() {
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

  return (
    <Panel className="flex flex-col">
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

      {breach && (
        <div className="border-t border-down/30 bg-down-subtle px-3 py-2 text-xs text-down">
          Free cash is exhausted. Borrow to avoid forced liquidation.
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
            step={100}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mono"
          />
          <Button onClick={borrow} loading={busy} disabled={principal <= 0}>
            Borrow
          </Button>
        </div>
        {error && <p className="mt-2 text-xs text-down">{error}</p>}
      </div>
    </Panel>
  );
}
