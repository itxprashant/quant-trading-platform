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
import { otcNetCash } from "@/lib/eden";
import { money } from "@/lib/format";

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
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [opt, mk] = await Promise.all([
        get<{ contracts: OptionContract[] }>(`/api/options/${challengeId}`),
        get<{ etfs: EtfView[] }>(`/api/markets/${challengeId}/etfs`),
      ]);
      setContracts(opt.contracts);
      setEtfs(mk.etfs);
      setRefreshError(null);
    } catch {
      setRefreshError(
        "Could not refresh options and ETF windows. Retrying automatically; displayed state may be outdated.",
      );
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
    setBusy("open");
    setError(null);
    setMsg(null);
    try {
      await post(`/api/admin/${challengeId}/options/open`);
      setMsg("Opened a fresh option cycle");
      setTimeout(refresh, 500);
    } catch {
      setError(
        "Could not open an option cycle. Check the current cycles before retrying.",
      );
    } finally {
      setBusy(null);
    }
  }
  async function closeCycle(cycleId: string) {
    setBusy(cycleId);
    setError(null);
    setMsg(null);
    try {
      await post(`/api/admin/${challengeId}/options/close`, { cycleId });
      setMsg("Closed cycle; exercise window open");
      setTimeout(refresh, 500);
    } catch {
      setError(
        "Could not close the option cycle. Check its current state before retrying.",
      );
    } finally {
      setBusy(null);
    }
  }
  async function toggleWindow(symbol: string, open: boolean) {
    setBusy(symbol);
    setError(null);
    setMsg(null);
    try {
      await post(`/api/admin/${challengeId}/etf-window`, {
        etfSymbol: symbol,
        open,
      });
      setMsg(`${symbol} window ${open ? "opened" : "closed"}`);
      setTimeout(refresh, 500);
    } catch {
      setError(
        "Could not update the ETF window. Check its current state before retrying.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel className="min-w-0 rounded-md backdrop-blur-none">
      <PanelHeader title="New Eden / Host desk" />
      {refreshError && (
        <p
          role="alert"
          className="border-b border-border px-4 py-3 text-xs text-down"
        >
          {refreshError}
        </p>
      )}
      <div className="grid gap-6 p-4 sm:p-5 lg:grid-cols-2">
        {/* Options cycle */}
        <section className="min-w-0 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Options
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={openCycle}
              loading={busy === "open"}
              disabled={busy !== null}
            >
              Open cycle
            </Button>
          </div>
          {cycles.length === 0 ? (
            <p className="py-2 text-xs text-muted">
              No open option cycles. Open a cycle to begin trading.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {cycles.map((id) => {
                const n = contracts.filter((c) => c.cycleId === id).length;
                return (
                  <li
                    key={id}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 text-xs"
                  >
                    <span className="mono text-faint">
                      {id.slice(0, 8)} · {n} contracts
                    </span>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy !== null}
                      loading={busy === id}
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
        <section className="min-w-0 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            ETF windows
          </p>
          {etfs.length === 0 && (
            <p className="py-2 text-xs text-muted">
              No ETFs listed. Add one from Instrument listings to manage its
              create/redeem window.
            </p>
          )}
          <ul className="space-y-1.5">
            {etfs.map((etf) => (
              <li
                key={etf.symbol}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border py-2 text-xs"
              >
                <span>
                  <span className="font-medium">{etf.symbol}</span>{" "}
                  <span className="mono text-faint">
                    NAV {etf.nav.toFixed(2)}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant={etf.windowOpen ? "danger" : "secondary"}
                  disabled={busy !== null}
                  loading={busy === etf.symbol}
                  onClick={() => toggleWindow(etf.symbol, !etf.windowOpen)}
                >
                  {etf.windowOpen ? "Close window" : "Open window"}
                </Button>
              </li>
            ))}
          </ul>
        </section>

        {/* Deal Desk */}
        <section className="min-w-0 border-t border-border pt-5">
          <OtcBuilder
            challenge={challenge}
            symbols={Array.from(
              new Set([
                ...challenge.config.symbols.map((s) => s.symbol),
                ...etfs.map((e) => e.symbol),
                ...contracts
                  .filter((c) => c.status === "open")
                  .map((c) => c.symbol),
              ]),
            )}
            onSent={() => setMsg("OTC offer sent")}
          />
        </section>

        {/* Premium auction / policy vote / grant */}
        <section className="min-w-0 border-t border-border pt-5">
          <OpsControls challenge={challenge} onMsg={setMsg} />
        </section>
      </div>
      {(msg || error) && (
        <div className="border-t border-border px-4 py-3">
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
      )}
    </Panel>
  );
}

function OtcBuilder({
  challenge,
  symbols,
  onSent,
}: {
  challenge: Challenge;
  symbols: string[];
  onSent: () => void;
}) {
  const challengeId = challenge.id;
  const [traders, setTraders] = useState<LeaderboardEntry[]>([]);
  const [userId, setUserId] = useState("");
  const [description, setDescription] = useState("");
  const [cashToTrader, setCashToTrader] = useState("0");
  const [expiresSec, setExpiresSec] = useState("15");
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
      .catch(() =>
        setError("Could not load traders. Reload the page to try again."),
      );
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
            {traders.length === 0 && (
              <option value="">No traders available</option>
            )}
            {traders.map((t) => (
              <option key={t.userId} value={t.userId}>
                {t.displayName || t.username}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Cash adjustment"
          hint="Added after signed leg costs, not the total settlement."
        >
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

      <div
        className="space-y-1.5 overflow-x-auto"
        tabIndex={0}
        role="region"
        aria-label="Deal legs"
      >
        <p className="text-xs font-medium text-muted">
          Legs{" "}
          <span className="font-normal">
            (positive quantity receives; negative delivers)
          </span>
        </p>
        <div className="min-w-[360px] space-y-2">
          <div
            aria-hidden="true"
            className="grid grid-cols-[1fr_70px_80px_34px] gap-1.5 text-[11px] text-muted"
          >
            <span>Symbol</span>
            <span>Quantity</span>
            <span>Price</span>
            <span />
          </div>
          {legs.map((leg, i) => (
            <div
              key={i}
              className="grid grid-cols-[1fr_70px_80px_34px] items-center gap-1.5"
            >
              <Select
                aria-label={`Leg ${i + 1} symbol`}
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
                aria-label={`Leg ${i + 1} signed quantity`}
                type="number"
                value={leg.quantity}
                onChange={(e) =>
                  updateLeg(i, { quantity: Number(e.target.value) })
                }
                className="mono"
                title="Signed: + trader receives, − trader delivers"
              />
              <Input
                aria-label={`Leg ${i + 1} price`}
                type="number"
                step="0.01"
                value={leg.price}
                onChange={(e) =>
                  updateLeg(i, { price: Number(e.target.value) })
                }
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
        </div>
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
        <Button
          onClick={send}
          loading={busy}
          disabled={!userId || !description.trim()}
        >
          Send offer
        </Button>
      </div>
      <p className="text-xs text-muted">
        Net cash to trader:{" "}
        <span className="mono">
          {money(otcNetCash(Number(cashToTrader), legs))}
        </span>
        . Acceptance is binding; accepted bargains settle after 5 seconds.
      </p>
      {error && (
        <p role="alert" className="text-xs text-down">
          {error}
        </p>
      )}
    </div>
  );
}

function OpsControls({
  challenge,
  onMsg,
}: {
  challenge: Challenge;
  onMsg: (m: string) => void;
}) {
  const challengeId = challenge.id;
  const symbols = challenge.config.symbols.map((s) => s.symbol);

  const [auctionSec, setAuctionSec] = useState("30");
  const [voteTitle, setVoteTitle] = useState("Solidarity Tax");
  const [voteDesc, setVoteDesc] = useState(
    "Tax the wealthiest 10% and redistribute to the bottom 20%.",
  );
  const [voteSec, setVoteSec] = useState("60");
  const [grantSymbol, setGrantSymbol] = useState(symbols[0] ?? "");
  const [grantDesc, setGrantDesc] = useState(
    "Largest holder at the deadline wins the grant.",
  );
  const [grantPrize, setGrantPrize] = useState("10000");
  const [grantSec, setGrantSec] = useState("300");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function openAuction() {
    setBusy("auction");
    setError(null);
    try {
      await post(`/api/admin/${challengeId}/auction`, {
        durationSec: Number(auctionSec),
      });
      onMsg("Auction round opened");
    } catch {
      setError(
        "Could not open the auction. Check the session state before retrying.",
      );
    } finally {
      setBusy(null);
    }
  }
  async function openVote() {
    setBusy("vote");
    setError(null);
    try {
      await post(`/api/admin/${challengeId}/vote`, {
        title: voteTitle.trim(),
        description: voteDesc.trim(),
        durationSec: Number(voteSec),
      });
      onMsg("Policy vote opened");
    } catch {
      setError(
        "Could not open the policy vote. Check the session state before retrying.",
      );
    } finally {
      setBusy(null);
    }
  }
  async function openGrant() {
    setBusy("grant");
    setError(null);
    try {
      await post(`/api/admin/${challengeId}/grant`, {
        symbol: grantSymbol,
        description: grantDesc.trim(),
        prize: Number(grantPrize),
        durationSec: Number(grantSec),
      });
      onMsg("Grant mission opened");
    } catch {
      setError(
        "Could not open the grant. Check the session state before retrying.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Premium auction */}
      <div className="space-y-1.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          Premium auction
        </p>
        <p className="text-xs text-muted">
          Top {(challenge.config.eden?.auctionWinnerFraction ?? 0.3) * 100}% of
          active bidders pay their own bid. Publish the cutoff after close.
          Access lasts {challenge.config.eden?.premiumAccessMinutes ?? 15}{" "}
          minutes with a {challenge.config.eden?.premiumLeadSec ?? 10}s news
          lead.
        </p>
        <div className="grid grid-cols-[100px_1fr] items-end gap-2">
          <Field label="Duration (s)">
            <Input
              type="number"
              min={5}
              max={600}
              value={auctionSec}
              onChange={(e) => setAuctionSec(e.target.value)}
              className="mono"
            />
          </Field>
          <Button
            variant="secondary"
            disabled={busy !== null}
            loading={busy === "auction"}
            onClick={openAuction}
          >
            Open auction
          </Button>
        </div>
      </div>

      {/* Policy vote */}
      <div className="space-y-1.5 border-t border-border pt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          Policy vote
        </p>
        <Field label="Title">
          <Input
            value={voteTitle}
            onChange={(e) => setVoteTitle(e.target.value)}
          />
        </Field>
        <Field label="Description">
          <Input
            value={voteDesc}
            onChange={(e) => setVoteDesc(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-[100px_1fr] items-end gap-2">
          <Field label="Duration (s)">
            <Input
              type="number"
              min={5}
              max={600}
              value={voteSec}
              onChange={(e) => setVoteSec(e.target.value)}
              className="mono"
            />
          </Field>
          <Button
            variant="secondary"
            disabled={busy !== null}
            loading={busy === "vote"}
            onClick={openVote}
          >
            Open vote
          </Button>
        </div>
      </div>

      {/* Government grant */}
      <div className="space-y-1.5 border-t border-border pt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          Government grant
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Symbol">
            <Select
              value={grantSymbol}
              onChange={(e) => setGrantSymbol(e.target.value)}
            >
              {symbols.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Prize">
            <Input
              type="number"
              step="0.01"
              value={grantPrize}
              onChange={(e) => setGrantPrize(e.target.value)}
              className="mono"
            />
          </Field>
        </div>
        <Field label="Description">
          <Input
            value={grantDesc}
            onChange={(e) => setGrantDesc(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-[100px_1fr] items-end gap-2">
          <Field label="Duration (s)">
            <Input
              type="number"
              min={5}
              max={3600}
              value={grantSec}
              onChange={(e) => setGrantSec(e.target.value)}
              className="mono"
            />
          </Field>
          <Button
            variant="secondary"
            disabled={busy !== null}
            loading={busy === "grant"}
            onClick={openGrant}
          >
            Open grant
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs text-down">
          {error}
        </p>
      )}
    </div>
  );
}
