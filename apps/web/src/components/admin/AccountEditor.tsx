"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AdminAccountView, Challenge } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Input";
import { ApiError, get, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { money, signed } from "@/lib/format";

type EditMode = "set" | "adjust";

const MODES: Array<{ id: EditMode; label: string }> = [
  { id: "set", label: "Set value" },
  { id: "adjust", label: "Adjust by" },
];

function editError(err: unknown): string {
  const body =
    err instanceof ApiError
      ? (err.body as { error?: string; symbol?: string } | null)
      : null;
  switch (body?.error) {
    case "challenge_not_live":
      return "Accounts can only be edited while the challenge is live.";
    case "not_enrolled":
      return "That trader is no longer enrolled in this challenge.";
    case "unknown_symbol":
      return `${body.symbol ?? "That symbol"} is not listed in this challenge.`;
    case "validation_error":
      return "Check the values: cash must be a number and quantities whole numbers.";
    default:
      return "Could not update the account. Try again.";
  }
}

/**
 * Host override for a trader's cash and inventory, applied by the engine.
 * "Set value" edits are absolute, so fills between loading and applying are
 * replaced for the fields that changed; "Adjust by" edits are deltas added to
 * the live balances, so those fills are kept.
 */
export function AccountEditor({ challenge }: { challenge: Challenge }) {
  const challengeId = challenge.id;
  const [accounts, setAccounts] = useState<AdminAccountView[]>([]);
  const [userId, setUserId] = useState("");
  const [mode, setMode] = useState<EditMode>("set");
  const [cash, setCash] = useState("");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await get<{ accounts: AdminAccountView[] }>(
        `/api/admin/${challengeId}/accounts`,
      );
      setAccounts(res.accounts);
      setUserId((cur) =>
        res.accounts.some((a) => a.userId === cur)
          ? cur
          : (res.accounts[0]?.userId ?? ""),
      );
      setError(null);
    } catch {
      setError("Could not load trader accounts. Reload to try again.");
    } finally {
      setLoading(false);
    }
  }, [challengeId]);

  const live = challenge.status === "live";
  useEffect(() => {
    if (live) load();
  }, [live, load]);

  const account = accounts.find((a) => a.userId === userId);

  const symbols = useMemo(
    () =>
      Array.from(
        new Set([
          ...challenge.config.symbols.map((s) => s.symbol),
          ...(challenge.config.eden?.etfs ?? []).map((e) => e.symbol),
          ...(account?.positions ?? []).map((p) => p.symbol),
        ]),
      ),
    [challenge.config, account],
  );

  const adjust = mode === "adjust";

  // Reset the form whenever the trader, data or mode changes: stored values
  // to set from, or blank deltas to adjust by.
  useEffect(() => {
    if (!account) return;
    if (adjust) {
      setCash("");
      setQuantities({});
      return;
    }
    setCash(account.cash.toFixed(2));
    setQuantities(
      Object.fromEntries(
        account.positions.map((p) => [p.symbol, String(p.quantity)]),
      ),
    );
  }, [account, adjust]);

  const held = (symbol: string) =>
    account?.positions.find((p) => p.symbol === symbol);

  const cashInput = cash.trim() === "" ? undefined : Number(cash);
  const cashChange =
    !account || cashInput === undefined
      ? undefined
      : adjust
        ? cashInput !== 0
          ? { next: account.cash + cashInput, delta: cashInput }
          : undefined
        : cashInput !== Number(account.cash.toFixed(2))
          ? { next: cashInput, delta: cashInput - account.cash }
          : undefined;
  const positionChanges = symbols.flatMap((symbol) => {
    const raw = quantities[symbol]?.trim() ?? "";
    const current = held(symbol)?.quantity ?? 0;
    const value = raw === "" ? 0 : Number(raw);
    const next = adjust ? current + value : value;
    return next !== current
      ? [{ symbol, current, next, delta: next - current }]
      : [];
  });
  const invalid =
    (cashChange !== undefined && !Number.isFinite(cashChange.next)) ||
    positionChanges.some((p) => !Number.isSafeInteger(p.next));
  const hasChanges = cashChange !== undefined || positionChanges.length > 0;

  function switchMode(next: EditMode) {
    setMode(next);
    setMsg(null);
    setError(null);
  }

  async function apply() {
    if (!account || !hasChanges || invalid) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await post(
        `/api/admin/${challengeId}/accounts/${account.userId}`,
        adjust
          ? {
              ...(cashChange ? { cashDelta: cashChange.delta } : {}),
              ...(positionChanges.length
                ? {
                    positions: positionChanges.map(({ symbol, delta }) => ({
                      symbol,
                      delta,
                    })),
                  }
                : {}),
            }
          : {
              ...(cashChange ? { cash: cashChange.next } : {}),
              ...(positionChanges.length
                ? {
                    positions: positionChanges.map(({ symbol, next }) => ({
                      symbol,
                      quantity: next,
                    })),
                  }
                : {}),
            },
      );
      setMsg(
        `Edit sent for ${account.displayName || account.username}. They are notified when the engine applies it.`,
      );
      // Deltas are not idempotent: clear them so a second click cannot resend.
      if (adjust) {
        setCash("");
        setQuantities({});
      }
      setTimeout(load, 800);
    } catch (err) {
      setError(editError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!live) return null;

  return (
    <Panel className="min-w-0 rounded-md backdrop-blur-none">
      <PanelHeader title="Trader accounts">
        <Button
          size="sm"
          variant="ghost"
          onClick={load}
          loading={loading}
          aria-label="Reload trader accounts"
        >
          {!loading && <RefreshCw className="size-3.5" />}
          Reload
        </Button>
      </PanelHeader>
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="min-w-0 max-w-prose flex-1 text-xs leading-relaxed text-muted">
            {adjust
              ? "Add to or subtract from a trader's cash and inventory. Changes apply to their live balances, so anything filled since this view loaded is kept."
              : "Set a trader's cash and inventory directly. Values are absolute and replace anything filled since this view loaded."}{" "}
            Margin rules apply to the result, and the trader is notified.
          </p>
          <div
            role="group"
            aria-label="Edit mode"
            className="flex shrink-0 rounded-md border border-border bg-surface-2 p-0.5"
          >
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => switchMode(m.id)}
                aria-pressed={mode === m.id}
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent",
                  mode === m.id
                    ? "bg-accent-subtle text-text"
                    : "text-muted hover:text-text",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Field label="Trader">
            <Select
              value={userId}
              onChange={(e) => {
                setUserId(e.target.value);
                setMsg(null);
                setError(null);
              }}
              disabled={accounts.length === 0}
            >
              {accounts.length === 0 && (
                <option value="">
                  {loading ? "Loading…" : "No enrolled traders"}
                </option>
              )}
              {accounts.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.displayName || a.username}
                  {a.displayName && a.displayName !== a.username
                    ? ` (${a.username})`
                    : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={adjust ? "Cash change" : "Cash balance"}
            hint={
              account
                ? `Stored ${money(account.cash)}${account.loanDebt > 0 ? ` · loan debt ${money(account.loanDebt)}` : ""}`
                : undefined
            }
          >
            <Input
              type="number"
              step="0.01"
              value={cash}
              placeholder={adjust ? "0.00" : undefined}
              onChange={(e) => setCash(e.target.value)}
              disabled={!account}
              className="mono"
            />
          </Field>
        </div>

        {account && (
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Inventory"
          >
            <table className="w-full min-w-[360px] text-xs">
              <thead>
                <tr className="border-b border-border text-left text-[11px] text-muted">
                  <th className="py-1.5 pr-3 font-medium">Symbol</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Held</th>
                  <th className="py-1.5 pr-3 text-right font-medium">
                    Avg price
                  </th>
                  <th className="w-32 py-1.5 font-medium">
                    {adjust ? "Change" : "New quantity"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {symbols.map((symbol) => {
                  const pos = held(symbol);
                  return (
                    <tr
                      key={symbol}
                      className="border-b border-border last:border-0"
                    >
                      <td className="py-1.5 pr-3 font-medium">{symbol}</td>
                      <td className="mono py-1.5 pr-3 text-right tabular-nums">
                        {pos?.quantity ?? 0}
                      </td>
                      <td className="mono py-1.5 pr-3 text-right tabular-nums text-muted">
                        {pos ? money(pos.avgPrice) : "—"}
                      </td>
                      <td className="py-1">
                        <Input
                          aria-label={`${symbol} ${adjust ? "quantity change" : "new quantity"}`}
                          type="number"
                          step="1"
                          value={quantities[symbol] ?? ""}
                          placeholder="0"
                          onChange={(e) =>
                            setQuantities((q) => ({
                              ...q,
                              [symbol]: e.target.value,
                            }))
                          }
                          className="mono h-8"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-1.5 text-[11px] text-faint">
              {adjust
                ? "Negative changes reduce inventory and can take it short. Blank means no change."
                : "Negative quantities are short positions."}{" "}
              New or flipped positions are costed at the current mark.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <p className="min-w-0 text-xs text-muted">
            {hasChanges ? (
              <>
                Changes:{" "}
                <span className="mono text-text">
                  {[
                    ...(cashChange !== undefined && account
                      ? [
                          Number.isFinite(cashChange.next)
                            ? `cash ${money(account.cash)} → ${money(cashChange.next)}${adjust ? ` (${signed(cashChange.delta)})` : ""}`
                            : `cash ${money(account.cash)} → ?`,
                        ]
                      : []),
                    ...positionChanges.map(
                      (p) =>
                        `${p.symbol} ${p.current} → ${p.next}${adjust ? ` (${signed(p.delta, 0)})` : ""}`,
                    ),
                  ].join(" · ")}
                </span>
              </>
            ) : (
              "No changes."
            )}
          </p>
          <Button
            onClick={apply}
            loading={busy}
            disabled={!account || !hasChanges || invalid}
          >
            Apply changes
          </Button>
        </div>
        {invalid && (
          <p role="alert" className="text-xs text-down">
            {adjust
              ? "Quantity changes must be whole numbers."
              : "Quantities must be whole numbers."}
          </p>
        )}
        {msg && (
          <p role="status" className="text-xs text-up">
            {msg}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-down">
            {error}
          </p>
        )}
      </div>
    </Panel>
  );
}
