"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type {
  Challenge,
  LeaderboardEntry,
  OptionContract,
  OtcLeg,
} from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Input";
import { get, post } from "@/lib/api";

interface EtfView {
  symbol: string;
  name: string | null;
  nav: number;
  windowOpen: boolean;
}

/**
 * Live host console for New Eden challenges: drive the option cycle, toggle ETF
 * create/redeem windows, and author binding Deal Desk offers. Price drift, hard
 * sets, and news live in their own panels alongside this one.
 */
export function EdenHostConsole({ challenge }: { challenge: Challenge }) {
  const challengeId = challenge.id;
  const [contracts, setContracts] = useState<OptionContract[]>([]);
  const [etfs, setEtfs] = useState<EtfView[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [opt, mk] = await Promise.all([
        get<{ contracts: OptionContract[] }>(`/api/options/${challengeId}`),
        get<{ etfs: EtfView[] }>(`/api/markets/${challengeId}/etfs`),
      ]);
      setContracts(opt.contracts);
      setEtfs(mk.etfs);
    } catch {
      /* ignore */
    }
  }, [challengeId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const cycles = Array.from(
    new Set(contracts.filter((c) => c.status === "open").map((c) => c.cycleId)),
  );

  async function openCycle() {
    await post(`/api/admin/${challengeId}/options/open`);
    setMsg("Opened a fresh option cycle");
    setTimeout(refresh, 500);
  }
  async function closeCycle(cycleId: string) {
    await post(`/api/admin/${challengeId}/options/close`, { cycleId });
    setMsg("Closed cycle — exercise window open");
    setTimeout(refresh, 500);
  }
  async function toggleWindow(symbol: string, open: boolean) {
    await post(`/api/admin/${challengeId}/etf-window`, { etfSymbol: symbol, open });
    setMsg(`${symbol} window ${open ? "opened" : "closed"}`);
    setTimeout(refresh, 500);
  }

  return (
    <Panel>
      <PanelHeader title="Eden host console" />
      <div className="space-y-5 p-4">
        {/* Options cycle */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Options
            </p>
            <Button size="sm" variant="secondary" onClick={openCycle}>
              Open cycle
            </Button>
          </div>
          {cycles.length === 0 ? (
            <p className="text-xs text-faint">No open cycle.</p>
          ) : (
            <ul className="space-y-1.5">
              {cycles.map((id) => {
                const n = contracts.filter((c) => c.cycleId === id).length;
                return (
                  <li
                    key={id}
                    className="flex items-center justify-between rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs"
                  >
                    <span className="mono text-faint">
                      {id.slice(0, 8)} · {n} contracts
                    </span>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => closeCycle(id)}
                    >
                      Close
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ETF windows */}
        {etfs.length > 0 && (
          <section className="space-y-2 border-t border-border pt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              ETF windows
            </p>
            <ul className="space-y-1.5">
              {etfs.map((etf) => (
                <li
                  key={etf.symbol}
                  className="flex items-center justify-between rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs"
                >
                  <span>
                    <span className="font-medium">{etf.symbol}</span>{" "}
                    <span className="mono text-faint">NAV {etf.nav.toFixed(2)}</span>
                  </span>
                  <Button
                    size="sm"
                    variant={etf.windowOpen ? "danger" : "secondary"}
                    onClick={() => toggleWindow(etf.symbol, !etf.windowOpen)}
                  >
                    {etf.windowOpen ? "Close window" : "Open window"}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Deal Desk */}
        <section className="border-t border-border pt-4">
          <OtcBuilder challenge={challenge} onSent={() => setMsg("OTC offer sent")} />
        </section>

        {msg && <p className="text-xs text-up">{msg}</p>}
      </div>
    </Panel>
  );
}

function OtcBuilder({
  challenge,
  onSent,
}: {
  challenge: Challenge;
  onSent: () => void;
}) {
  const challengeId = challenge.id;
  const symbols = challenge.config.symbols.map((s) => s.symbol);
  const [traders, setTraders] = useState<LeaderboardEntry[]>([]);
  const [userId, setUserId] = useState("");
  const [description, setDescription] = useState("");
  const [cashToTrader, setCashToTrader] = useState("0");
  const [expiresSec, setExpiresSec] = useState("20");
  const [legs, setLegs] = useState<OtcLeg[]>([
    { symbol: symbols[0] ?? "", quantity: 1, price: 100 },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<LeaderboardEntry[]>(`/api/leaderboard/${challengeId}`)
      .then((rows) => {
        setTraders(rows);
        if (rows[0]) setUserId(rows[0].userId);
      })
      .catch(() => {});
  }, [challengeId]);

  function updateLeg(i: number, patch: Partial<OtcLeg>) {
    setLegs((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function send() {
    if (!userId || !description.trim() || legs.length === 0) {
      setError("Pick a trader, description, and at least one leg");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await post(`/api/admin/${challengeId}/otc`, {
        userId,
        description: description.trim(),
        legs: legs.map((l) => ({
          symbol: l.symbol,
          quantity: Math.trunc(l.quantity),
          price: Number(l.price),
        })),
        cashToTrader: Number(cashToTrader),
        expiresSec: Number(expiresSec),
      });
      setDescription("");
      onSent();
    } catch {
      setError("Failed to send offer");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
        Deal Desk offer
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Trader">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
            {traders.map((t) => (
              <option key={t.userId} value={t.userId}>
                {t.displayName || t.username}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Cash to trader">
          <Input
            type="number"
            step="0.01"
            value={cashToTrader}
            onChange={(e) => setCashToTrader(e.target.value)}
            className="mono"
          />
        </Field>
      </div>
      <Field label="Description">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value.slice(0, 280))}
          placeholder="We'll take your AERIUM block off-book…"
        />
      </Field>

      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted">Legs</span>
        {legs.map((leg, i) => (
          <div key={i} className="grid grid-cols-[1fr_70px_80px_auto] items-center gap-1.5">
            <Select
              value={leg.symbol}
              onChange={(e) => updateLeg(i, { symbol: e.target.value })}
            >
              {symbols.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            <Input
              type="number"
              value={leg.quantity}
              onChange={(e) => updateLeg(i, { quantity: Number(e.target.value) })}
              className="mono"
              title="Signed: + trader receives, − trader delivers"
            />
            <Input
              type="number"
              step="0.01"
              value={leg.price}
              onChange={(e) => updateLeg(i, { price: Number(e.target.value) })}
              className="mono"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLegs((ls) => ls.filter((_, j) => j !== i))}
              disabled={legs.length <= 1}
              aria-label="Remove leg"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        {legs.length < 6 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setLegs((ls) => [
                ...ls,
                { symbol: symbols[0] ?? "", quantity: 1, price: 100 },
              ])
            }
          >
            <Plus className="size-3.5" /> Add leg
          </Button>
        )}
      </div>

      <div className="grid grid-cols-[100px_1fr] items-end gap-2">
        <Field label="Expires (s)">
          <Input
            type="number"
            min={5}
            max={300}
            value={expiresSec}
            onChange={(e) => setExpiresSec(e.target.value)}
            className="mono"
          />
        </Field>
        <Button onClick={send} loading={busy}>
          Send offer
        </Button>
      </div>
      {error && <p className="text-xs text-down">{error}</p>}
    </div>
  );
}
