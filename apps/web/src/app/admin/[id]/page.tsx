"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowUpRight, ChevronLeft } from "lucide-react";
import type {
  Challenge,
  NewsFeed,
  NewsItem,
  NewsKind,
  NewsLevel,
} from "@qtp/shared";
import { get, post } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { AdminGuard } from "@/components/AdminGuard";
import { ChallengeForm } from "@/components/admin/ChallengeForm";
import { EdenHostConsole } from "@/components/admin/EdenHostConsole";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/Badge";

function LiveControls({ challenge }: { challenge: Challenge }) {
  const [symbol, setSymbol] = useState(
    challenge.config.symbols[0]?.symbol ?? "",
  );
  const [target, setTarget] = useState("100");
  const [speed, setSpeed] = useState("5");
  const [price, setPrice] = useState("100");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"drift" | "price" | null>(null);

  async function drift() {
    setBusy("drift");
    setError(null);
    setMsg(null);
    try {
      await post(`/api/admin/${challenge.id}/drift`, {
        symbol,
        target: Number(target),
        speed: Number(speed),
      });
      setMsg(`Drifting ${symbol} → ${target}`);
    } catch {
      setError("Could not set price drift. Check the symbol and try again.");
    } finally {
      setBusy(null);
    }
  }
  async function setHard() {
    setBusy("price");
    setError(null);
    setMsg(null);
    try {
      await post(`/api/admin/${challenge.id}/price`, {
        symbol,
        price: Number(price),
      });
      setMsg(`Set ${symbol} = ${price}`);
    } catch {
      setError("Could not set the price. Check the symbol and try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel className="min-w-0 rounded-md backdrop-blur-none">
      <PanelHeader title="Live price controls" />
      <div className="space-y-4 p-4">
        <Field label="Symbol">
          <Select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {challenge.config.symbols.map((s) => (
              <option key={s.symbol} value={s.symbol}>
                {s.symbol}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Field label="Drift target">
            <Input
              type="number"
              step="0.01"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="mono"
            />
          </Field>
          <Field label="Speed (1-10)">
            <Input
              type="number"
              min={1}
              max={10}
              value={speed}
              onChange={(e) => setSpeed(e.target.value)}
              className="mono"
            />
          </Field>
          <Button
            variant="secondary"
            onClick={drift}
            disabled={busy !== null || !symbol}
            loading={busy === "drift"}
          >
            Drift
          </Button>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <Field label="Hard set price">
            <Input
              type="number"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="mono"
            />
          </Field>
          <Button
            variant="secondary"
            onClick={setHard}
            disabled={busy !== null || !symbol}
            loading={busy === "price"}
          >
            Set price
          </Button>
        </div>
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

function FreezeControls({
  challenge,
  onChange,
}: {
  challenge: Challenge;
  onChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/admin/${challenge.id}/freeze`, {
        frozen: !challenge.frozen,
      });
      await onChange();
    } catch {
      setError("Could not update market freeze. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (challenge.status !== "live") return null;

  return (
    <Panel className="min-w-0 rounded-md backdrop-blur-none">
      <PanelHeader title="Market freeze" />
      <div className="space-y-3 p-4">
        <p className="text-xs leading-relaxed text-muted">
          Halt new orders, matching, and bots. Resting books stay intact;
          traders can still cancel.
        </p>
        <Button
          variant="secondary"
          onClick={toggle}
          disabled={busy}
          loading={busy}
        >
          {challenge.frozen ? "Unfreeze market" : "Freeze market"}
        </Button>
        {challenge.frozen && (
          <p role="status" className="text-xs text-warning">
            Market is frozen — cancellations only.
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

interface BasketRow {
  symbol: string;
  weight: string;
}

function AddInstrumentControls({ challenge }: { challenge: Challenge }) {
  const [tab, setTab] = useState<"spot" | "etf" | "option">("spot");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Spot asset fields.
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [initialPrice, setInitialPrice] = useState("100");
  const [volatility, setVolatility] = useState("0.5");
  const [tickSize, setTickSize] = useState("0.01");
  const [locked, setLocked] = useState(false);

  // ETF fields.
  const [etfSymbol, setEtfSymbol] = useState("");
  const [etfName, setEtfName] = useState("");
  const [basket, setBasket] = useState<BasketRow[]>([
    { symbol: challenge.config.symbols[0]?.symbol ?? "", weight: "1" },
  ]);

  // Options underlying.
  const [underlying, setUnderlying] = useState(
    challenge.config.symbols[0]?.symbol ?? "",
  );

  async function run(fn: () => Promise<string>) {
    setError(null);
    setMsg(null);
    try {
      setMsg(await fn());
    } catch {
      setError("Request failed (symbol may already exist).");
    }
  }

  const addSpot = () =>
    run(async () => {
      await post(`/api/admin/${challenge.id}/symbols`, {
        symbol: symbol.trim().toUpperCase(),
        name: name.trim() || undefined,
        initialPrice: Number(initialPrice),
        volatility: Number(volatility),
        tickSize: Number(tickSize),
        locked,
      });
      const s = symbol.trim().toUpperCase();
      setSymbol("");
      setName("");
      return `Listed ${s}${locked ? " (locked)" : ""}.`;
    });

  const addEtf = () =>
    run(async () => {
      await post(`/api/admin/${challenge.id}/etfs`, {
        symbol: etfSymbol.trim().toUpperCase(),
        name: etfName.trim() || undefined,
        basket: basket
          .filter((b) => b.symbol.trim())
          .map((b) => ({
            symbol: b.symbol.trim().toUpperCase(),
            weight: Number(b.weight),
          })),
      });
      const s = etfSymbol.trim().toUpperCase();
      setEtfSymbol("");
      setEtfName("");
      return `Listed ETF ${s}.`;
    });

  const openOptions = () =>
    run(async () => {
      await post(`/api/admin/${challenge.id}/options/open`, { underlying });
      return `Opened options cycle on ${underlying}.`;
    });

  return (
    <Panel className="min-w-0 rounded-md backdrop-blur-none">
      <PanelHeader title="Instrument listings" />
      <div className="space-y-4 p-4">
        <div
          className="flex gap-1 border-b border-border pb-3"
          role="group"
          aria-label="Instrument type"
        >
          {(["spot", "etf", "option"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`rounded-sm px-3 py-1.5 text-xs font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                tab === t
                  ? "bg-accent-subtle text-accent"
                  : "text-muted hover:bg-surface-2 hover:text-text"
              }`}
            >
              {t === "option" ? "Options" : t}
            </button>
          ))}
        </div>

        {tab === "spot" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Symbol">
                <Input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  placeholder="ZETA"
                  className="mono"
                />
              </Field>
              <Field label="Name (optional)">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Initial price">
                <Input
                  type="number"
                  step="0.01"
                  value={initialPrice}
                  onChange={(e) => setInitialPrice(e.target.value)}
                  className="mono"
                />
              </Field>
              <Field label="Tick size">
                <Input
                  type="number"
                  step="0.01"
                  value={tickSize}
                  onChange={(e) => setTickSize(e.target.value)}
                  className="mono"
                />
              </Field>
              <Field label="Volatility">
                <Input
                  type="number"
                  step="0.1"
                  value={volatility}
                  onChange={(e) => setVolatility(e.target.value)}
                  className="mono"
                />
              </Field>
              <label className="flex items-end gap-2 pb-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={locked}
                  onChange={(e) => setLocked(e.target.checked)}
                  className="size-3.5 accent-accent"
                />
                Start locked (unlock later)
              </label>
            </div>
            <Button onClick={addSpot} disabled={!symbol.trim()}>
              List asset
            </Button>
          </div>
        )}

        {tab === "etf" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label="ETF symbol">
                <Input
                  value={etfSymbol}
                  onChange={(e) => setEtfSymbol(e.target.value.toUpperCase())}
                  placeholder="ORBX"
                  className="mono"
                />
              </Field>
              <Field label="Name (optional)">
                <Input
                  value={etfName}
                  onChange={(e) => setEtfName(e.target.value)}
                />
              </Field>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted">Basket</p>
              {basket.map((row, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_100px_auto] items-end gap-2"
                >
                  <Field label="Component">
                    <Select
                      value={row.symbol}
                      onChange={(e) =>
                        setBasket((b) =>
                          b.map((r, j) =>
                            j === i ? { ...r, symbol: e.target.value } : r,
                          ),
                        )
                      }
                    >
                      {challenge.config.symbols.map((s) => (
                        <option key={s.symbol} value={s.symbol}>
                          {s.symbol}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Weight">
                    <Input
                      type="number"
                      min={1}
                      value={row.weight}
                      onChange={(e) =>
                        setBasket((b) =>
                          b.map((r, j) =>
                            j === i ? { ...r, weight: e.target.value } : r,
                          ),
                        )
                      }
                      className="mono"
                    />
                  </Field>
                  <Button
                    variant="secondary"
                    aria-label={`Remove basket component ${i + 1}`}
                    onClick={() =>
                      setBasket((b) => b.filter((_, j) => j !== i))
                    }
                    disabled={basket.length <= 1}
                  >
                    ×
                  </Button>
                </div>
              ))}
              <Button
                variant="secondary"
                onClick={() =>
                  setBasket((b) => [
                    ...b,
                    {
                      symbol: challenge.config.symbols[0]?.symbol ?? "",
                      weight: "1",
                    },
                  ])
                }
              >
                Add component
              </Button>
            </div>
            <Button onClick={addEtf} disabled={!etfSymbol.trim()}>
              List ETF
            </Button>
          </div>
        )}

        {tab === "option" && (
          <div className="space-y-3">
            <Field label="Underlying">
              <Select
                value={underlying}
                onChange={(e) => setUnderlying(e.target.value)}
              >
                {challenge.config.symbols.map((s) => (
                  <option key={s.symbol} value={s.symbol}>
                    {s.symbol}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-xs text-faint">
              Opens a call/put cycle around the underlying&apos;s current price.
            </p>
            <Button onClick={openOptions} disabled={!underlying}>
              Open options cycle
            </Button>
          </div>
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

function NewsControls({ challenge }: { challenge: Challenge }) {
  const isEden = challenge.type === "new_eden";
  const [message, setMessage] = useState("");
  const [feed, setFeed] = useState<NewsFeed>("announcement");
  const [level, setLevel] = useState<NewsLevel>("info");
  const [kind, setKind] = useState<NewsKind>("neutral");
  const [fvEffects, setFvEffects] = useState([
    { symbol: challenge.config.symbols[0]?.symbol ?? "", delta: 0 },
  ]);
  const [momentum, setMomentum] = useState([
    { symbol: challenge.config.symbols[0]?.symbol ?? "", sentiment: 0 },
  ]);
  const [embargoSec, setEmbargoSec] = useState("10");
  const [volEvent, setVolEvent] = useState(false);
  const [publishAt, setPublishAt] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<NewsItem[]>([]);

  useEffect(() => {
    get<{ items: NewsItem[] }>(`/api/challenges/${challenge.id}/news?limit=5`)
      .then((r) => setRecent(r.items))
      .catch(() => {});
  }, [challenge.id]);

  async function send() {
    const trimmed = message.trim();
    if (!trimmed) return;
    setSending(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { message: trimmed, level, feed };
      // datetime-local yields a local wall-clock string; send an absolute ISO.
      if (publishAt) {
        const when = new Date(publishAt);
        if (!Number.isNaN(when.getTime())) body.publishAt = when.toISOString();
      }
      if (isEden) {
        body.kind = kind;
        body.embargoSec = Number(embargoSec);
        if (kind === "signal")
          body.fvEffects = fvEffects.filter((e) => e.delta !== 0);
        if (kind === "noise")
          body.momentum = momentum.filter((e) => e.sentiment !== 0);
        if (volEvent) body.volEvent = true;
      }
      const res = await post<{ item: NewsItem; scheduled?: boolean }>(
        `/api/admin/${challenge.id}/news`,
        body,
      );
      // Scheduled items stay dormant until their publish time; only surface
      // immediately-published items in the recent list.
      if (!res.scheduled) {
        setRecent((prev) =>
          [res.item, ...prev.filter((n) => n.id !== res.item.id)].slice(0, 5),
        );
      }
      setMessage("");
      setVolEvent(false);
      setPublishAt("");
    } catch {
      setError("Failed to send news");
    } finally {
      setSending(false);
    }
  }

  return (
    <Panel className="min-w-0 rounded-md backdrop-blur-none">
      <PanelHeader title="News & announcements" />
      <div className="space-y-4 p-4">
        <Field label={feed === "news" ? "Market news" : "Announcement"}>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, 500))}
            rows={3}
            maxLength={500}
            placeholder={
              feed === "news"
                ? "Market/flavor headline for traders…"
                : "Operational announcement for traders…"
            }
            className="w-full resize-y rounded-md border border-border bg-surface-3 px-3 py-2 text-sm text-text placeholder:text-faint outline-none transition-colors focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40"
          />
        </Field>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Feed">
            <Select
              value={feed}
              onChange={(e) => setFeed(e.target.value as NewsFeed)}
            >
              <option value="announcement">Announcement</option>
              <option value="news">Market news</option>
            </Select>
          </Field>
          <Field label="Level">
            <Select
              value={level}
              onChange={(e) => setLevel(e.target.value as NewsLevel)}
            >
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="urgent">Urgent</option>
            </Select>
          </Field>
          {isEden && (
            <Field label="Kind">
              <Select
                value={kind}
                onChange={(e) => setKind(e.target.value as NewsKind)}
              >
                <option value="neutral">Neutral</option>
                <option value="signal">Signal (moves FV)</option>
                <option value="noise">Noise (no FV)</option>
              </Select>
            </Field>
          )}
          <Field label="Publish at (optional)">
            <Input
              type="datetime-local"
              value={publishAt}
              onChange={(e) => setPublishAt(e.target.value)}
              className="mono"
            />
          </Field>
          <Button onClick={send} disabled={sending || !message.trim()}>
            {sending ? "Sending…" : publishAt ? "Schedule" : "Send"}
          </Button>
          <span className="pb-2 text-xs text-faint">{message.length}/500</span>
        </div>
        {isEden && (
          <div className="flex flex-wrap items-end gap-3">
            <Field
              label="Premium embargo (s)"
              hint="Public release is delayed; premium sees it first."
            >
              <Input
                type="number"
                min={0}
                max={120}
                step={1}
                value={embargoSec}
                onChange={(e) => setEmbargoSec(e.target.value)}
                className="mono w-24"
              />
            </Field>
            {kind === "signal" && (
              <>
                {fvEffects.map((effect, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <Field label={`FV symbol ${i + 1}`}>
                      <Select
                        value={effect.symbol}
                        onChange={(e) =>
                          setFvEffects((rows) =>
                            rows.map((row, j) =>
                              j === i
                                ? { ...row, symbol: e.target.value }
                                : row,
                            ),
                          )
                        }
                      >
                        {challenge.config.symbols.map((s) => (
                          <option key={s.symbol} value={s.symbol}>
                            {s.symbol}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="FV delta">
                      <Input
                        type="number"
                        step="0.01"
                        value={effect.delta}
                        onChange={(e) =>
                          setFvEffects((rows) =>
                            rows.map((row, j) =>
                              j === i
                                ? { ...row, delta: Number(e.target.value) }
                                : row,
                            ),
                          )
                        }
                        className="mono"
                      />
                    </Field>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove FV effect ${i + 1}`}
                      onClick={() =>
                        setFvEffects((rows) => rows.filter((_, j) => j !== i))
                      }
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={fvEffects.length >= 20}
                  onClick={() =>
                    setFvEffects((rows) => [
                      ...rows,
                      {
                        symbol: challenge.config.symbols[0]?.symbol ?? "",
                        delta: 0,
                      },
                    ])
                  }
                >
                  Add FV effect
                </Button>
              </>
            )}
            {kind === "noise" && (
              <div className="w-full space-y-2">
                <p className="text-xs text-muted">
                  NOISE does not move fair value. Set sentiment from -1 (sell)
                  to +1 (buy) to drive momentum flow.
                </p>
                {momentum.map((effect, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <Field label={`Momentum symbol ${i + 1}`}>
                      <Select
                        value={effect.symbol}
                        onChange={(e) =>
                          setMomentum((rows) =>
                            rows.map((row, j) =>
                              j === i
                                ? { ...row, symbol: e.target.value }
                                : row,
                            ),
                          )
                        }
                      >
                        {[
                          ...challenge.config.symbols,
                          ...(challenge.config.eden?.etfs ?? []),
                        ].map((s) => (
                          <option key={s.symbol} value={s.symbol}>
                            {s.symbol}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Sentiment">
                      <Input
                        type="number"
                        min={-1}
                        max={1}
                        step={0.1}
                        value={effect.sentiment}
                        onChange={(e) =>
                          setMomentum((rows) =>
                            rows.map((row, j) =>
                              j === i
                                ? { ...row, sentiment: Number(e.target.value) }
                                : row,
                            ),
                          )
                        }
                        className="mono w-24"
                      />
                    </Field>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove momentum effect ${i + 1}`}
                      onClick={() =>
                        setMomentum((rows) => rows.filter((_, j) => j !== i))
                      }
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={momentum.length >= 20}
                  onClick={() =>
                    setMomentum((rows) => [
                      ...rows,
                      {
                        symbol: challenge.config.symbols[0]?.symbol ?? "",
                        sentiment: 0,
                      },
                    ])
                  }
                >
                  Add momentum effect
                </Button>
              </div>
            )}
            <label className="flex items-center gap-2 pb-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={volEvent}
                onChange={(e) => setVolEvent(e.target.checked)}
                className="size-3.5 accent-accent"
              />
              Volatility event (vega snipers react)
            </label>
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-down">
            {error}
          </p>
        )}
        {recent.length > 0 && (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-xs font-medium text-muted">Recent</p>
            <ul className="space-y-1.5">
              {recent.map((item) => (
                <li
                  key={item.id}
                  className="break-words border-b border-border py-2 text-xs last:border-0"
                >
                  <span className="mono text-faint">
                    {new Date(item.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>{" "}
                  <span className="uppercase text-faint">[{item.level}]</span>{" "}
                  {item.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}

function EditInner() {
  const { id } = useParams<{ id: string }>();
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setChallenge(await get<Challenge>(`/api/challenges/${id}`));
    } catch {
      setError(
        "Could not load this challenge. Check your connection and try again.",
      );
    }
  }, [id]);

  useEffect(() => {
    setChallenge(null);
    load();
  }, [load]);

  return (
    <div className="min-h-dvh">
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <Link
          href="/admin"
          className="mb-6 inline-flex items-center gap-1 rounded-sm text-xs text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ChevronLeft className="size-3.5" /> Event register
        </Link>
        {error ? (
          <div
            role="alert"
            className="space-y-3 rounded-md border border-down/30 bg-surface p-5"
          >
            <h1 className="text-lg font-semibold">Challenge unavailable</h1>
            <p className="text-sm text-muted">{error}</p>
            <Button variant="secondary" onClick={load}>
              Retry
            </Button>
          </div>
        ) : !challenge ? (
          <div
            className="space-y-4"
            role="status"
            aria-label="Loading challenge"
          >
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-64" />
          </div>
        ) : (
          <>
            <header className="mb-6 border-b border-border pb-5">
              <p className="mono mb-2 text-[11px] uppercase tracking-[0.16em] text-muted">
                Event operations /{" "}
                {challenge.type === "new_eden"
                  ? "New Eden Exchange"
                  : challenge.type === "market_making"
                    ? "Market making"
                    : "Directional"}
              </p>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                  <h1 className="min-w-0 max-w-full break-words text-2xl font-semibold tracking-tight">
                    {challenge.name}
                  </h1>
                  <StatusBadge status={challenge.status} />
                  {challenge.frozen && challenge.status === "live" && (
                    <span className="rounded-sm border border-warning/30 bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
                      Frozen
                    </span>
                  )}
                </div>
                <Link
                  href={`/challenges/${challenge.id}`}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-3 text-xs font-medium hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Open trading view <ArrowUpRight className="size-3.5" />
                </Link>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
                <span>
                  <span className="mono text-text">
                    {challenge.config.symbols.length}
                  </span>{" "}
                  instruments
                </span>
                <span>
                  <span className="mono text-text">
                    {challenge.participantCount ?? 0}
                  </span>{" "}
                  traders
                </span>
                <nav
                  aria-label="Editor sections"
                  className="flex gap-4 sm:ml-auto"
                >
                  {(challenge.status === "live" ||
                    challenge.status === "paused") && (
                    <a
                      href="#live-operations"
                      className="rounded-sm hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      Live operations
                    </a>
                  )}
                  <a
                    href="#configuration"
                    className="rounded-sm hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    Configuration
                  </a>
                </nav>
              </div>
            </header>
            {(challenge.status === "live" || challenge.status === "paused") && (
              <section
                id="live-operations"
                aria-labelledby="live-heading"
                className="mb-8 scroll-mt-20 space-y-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2
                    id="live-heading"
                    className="text-lg font-semibold tracking-tight"
                  >
                    Live operations
                  </h2>
                  <p className="text-xs text-muted">
                    These controls send commands directly to this session.
                  </p>
                </div>
                <div className="grid items-start gap-4 lg:grid-cols-2">
                  <LiveControls challenge={challenge} />
                  <FreezeControls challenge={challenge} onChange={load} />
                  <AddInstrumentControls challenge={challenge} />
                </div>
                {challenge.type === "new_eden" && (
                  <EdenHostConsole challenge={challenge} />
                )}
                <NewsControls challenge={challenge} />
              </section>
            )}
            <section
              id="configuration"
              aria-labelledby="config-heading"
              className="scroll-mt-20"
            >
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                <h2
                  id="config-heading"
                  className="text-lg font-semibold tracking-tight"
                >
                  Configuration
                </h2>
                <p className="text-xs text-muted">
                  Review the settings below, then save your changes.
                </p>
              </div>
              <ChallengeForm key={challenge.id} existing={challenge} />
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default function EditChallengePage() {
  return (
    <AdminGuard>
      <EditInner />
    </AdminGuard>
  );
}
