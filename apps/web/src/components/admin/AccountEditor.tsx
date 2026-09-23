"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { AdminAccountView, Challenge } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Input";
import { ApiError, get, post } from "@/lib/api";
import { money } from "@/lib/format";

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
 * Host override for a trader's cash and inventory. Edits are absolute and
 * applied by the engine, so fills between loading and applying are replaced
 * for the fields that changed.
 */
export function AccountEditor({ challenge }: { challenge: Challenge }) {
  const challengeId = challenge.id;
  const [accounts, setAccounts] = useState<AdminAccountView[]>([]);
  const [userId, setUserId] = useState("");
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

  // Reset the form to the stored values whenever the trader or data changes.
  useEffect(() => {
    if (!account) return;
    setCash(account.cash.toFixed(2));
    setQuantities(
      Object.fromEntries(
        account.positions.map((p) => [p.symbol, String(p.quantity)]),
      ),
    );
  }, [account]);

  const held = (symbol: string) =>
    account?.positions.find((p) => p.symbol === symbol);

  const cashChange =
    account &&
    cash.trim() !== "" &&
    Number(cash) !== Number(account.cash.toFixed(2))
      ? Number(cash)
      : undefined;
  const positionChanges = symbols.flatMap((symbol) => {
    const raw = quantities[symbol]?.trim() ?? "";
    const current = held(symbol)?.quantity ?? 0;
    const next = raw === "" ? 0 : Number(raw);
    return next !== current ? [{ symbol, quantity: next, current }] : [];
  });
  const invalid =
    (cashChange !== undefined && !Number.isFinite(cashChange)) ||
    positionChanges.some((p) => !Number.isSafeInteger(p.quantity));
  const hasChanges = cashChange !== undefined || positionChanges.length > 0;

  async function apply() {
    if (!account || !hasChanges || invalid) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await post(`/api/admin/${challengeId}/accounts/${account.userId}`, {
        ...(cashChange !== undefined ? { cash: cashChange } : {}),
        ...(positionChanges.length
          ? {
              positions: positionChanges.map(({ symbol, quantity }) => ({
                symbol,
                quantity,
              })),
            }
          : {}),
      });
      setMsg(
        `Edit sent for ${account.displayName || account.username}. They are notified when the engine applies it.`,
      );
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
        <p className="text-xs leading-relaxed text-muted">
          Set a trader&apos;s cash and inventory directly. Values are absolute
          and replace anything filled since this view loaded. Margin rules apply
          to the result, and the trader is notified.
        </p>
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
            label="Cash balance"
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
                  <th className="w-32 py-1.5 font-medium">New quantity</th>
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
                          aria-label={`${symbol} new quantity`}
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
              Negative quantities are short positions. New positions are costed
              at the current mark.
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
                          `cash ${money(account.cash)} → ${Number.isFinite(cashChange) ? money(cashChange) : "?"}`,
                        ]
                      : []),
                    ...positionChanges.map(
                      (p) => `${p.symbol} ${p.current} → ${p.quantity}`,
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
            Quantities must be whole numbers.
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
