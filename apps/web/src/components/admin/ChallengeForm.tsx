"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import type {
  BotConfig,
  Challenge,
  ChallengeType,
  CreateChallengeInput,
  EdenConfig,
  ScoringConfig,
  SymbolConfig,
} from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Input";
import { ApiError, patch, post } from "@/lib/api";
import {
  EDEN_EVENT_AERIUM,
  EDEN_EVENT_BOTS,
  EDEN_EVENT_OPTIONS,
  EDEN_EVENT_DEFAULTS,
  EDEN_EVENT_DURATION_MINUTES,
} from "@qtp/shared";

const blankSymbol = (): SymbolConfig => ({
  symbol: "",
  name: "",
  initialPrice: 100,
  volatility: 0.5,
  tickSize: 0.01,
});

function defaultScoring(type: ChallengeType): ScoringConfig {
  return type === "market_making"
    ? {
        kind: "market_making",
        spreadCaptureWeight: 1,
        quoteUptimeWeight: 0.1,
        maxSpread: 1,
        minQuoteSize: 1,
        inventoryPenaltyWeight: 0.05,
        pnlWeight: 0.25,
      }
    : { kind: "directional", pnlWeight: 1 };
}

/** Sensible New Eden defaults matching comp_desc.txt rules. */
function defaultEden(): EdenConfig & { eventScript?: boolean } {
  return {
    eventScript: false,
    rules: {
      enabled: true,
      costOfCarryPerUnitPerMinute: 1,
      loanRepayMultiplier: 2,
      marginCallThreshold: 0,
      forcedLiquidation: true,
      positionCap: 100,
    },
    bots: {
      ...EDEN_EVENT_BOTS,
      vegaSnipers: 0,
      parityArbers: 0,
    },
    options: {
      ...EDEN_EVENT_OPTIONS,
      underlyings: [],
    },
    auctionDurationSec: EDEN_EVENT_DEFAULTS.auctionDurationSec,
    auctionWinnerFraction: EDEN_EVENT_DEFAULTS.auctionWinnerFraction,
    premiumLeadSec: EDEN_EVENT_DEFAULTS.premiumLeadSec,
    premiumAccessMinutes: EDEN_EVENT_DEFAULTS.premiumAccessMinutes,
  };
}

export function ChallengeForm({ existing }: { existing?: Challenge }) {
  const router = useRouter();
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [type, setType] = useState<ChallengeType>(
    existing?.type ?? "directional",
  );
  const [symbols, setSymbols] = useState<SymbolConfig[]>(
    existing?.config.symbols ?? [{ ...blankSymbol(), symbol: "X1" }],
  );
  const [cfg, setCfg] = useState({
    startingCash: existing?.config.startingCash ?? 0,
    minPosition: existing?.config.minPosition ?? -50,
    maxPosition: existing?.config.maxPosition ?? 50,
    maxOrderQuantity: existing?.config.maxOrderQuantity ?? 50,
    maxOpenOrders: existing?.config.maxOpenOrders ?? 25,
    maxOrdersPerSecond: existing?.config.maxOrdersPerSecond ?? 5,
    maxVolumePerMinute: existing?.config.maxVolumePerMinute ?? 500,
    allowMargin: existing?.config.allowMargin ?? true,
    autonomousPrice: existing?.config.autonomousPrice ?? true,
  });
  const [scoring, setScoring] = useState<ScoringConfig>(
    existing?.scoring ?? defaultScoring(existing?.type ?? "directional"),
  );
  const [bots, setBots] = useState<BotConfig>(
    existing?.config.bots ?? {
      marketMakers: 0,
      noiseTraders: 0,
      spread: 0.5,
      quoteSize: 5,
      intensity: 0.5,
    },
  );
  const [eden, setEden] = useState<EdenConfig & { eventScript?: boolean }>(
    existing?.config.eden ?? defaultEden(),
  );
  const [startsAt, setStartsAt] = useState(
    existing?.startsAt ? existing.startsAt.slice(0, 16) : "",
  );
  const [endsAt, setEndsAt] = useState(
    existing?.endsAt ? existing.endsAt.slice(0, 16) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function togglePlaybook(enabled: boolean) {
    if (!enabled) {
      setEden((e) => ({ ...e, eventScript: false }));
      return;
    }
    setSymbols([structuredClone(EDEN_EVENT_AERIUM)]);
    setCfg((c) => ({
      ...c,
      startingCash: 10000,
      minPosition: -100,
      maxPosition: 100,
      maxOrderQuantity: 50,
      maxOpenOrders: 25,
      maxOrdersPerSecond: 8,
      maxVolumePerMinute: 1000,
      allowMargin: true,
      autonomousPrice: true,
    }));
    setBots((b) => ({ ...b, marketMakers: 0, noiseTraders: 0 }));
    const preset = defaultEden();
    setEden({
      ...preset,
      eventScript: true,
      bots: structuredClone(EDEN_EVENT_BOTS),
      options: structuredClone(EDEN_EVENT_OPTIONS),
      bonds: [],
      etfs: [],
    });
  }

  function changeType(t: ChallengeType) {
    setType(t);
    setScoring(defaultScoring(t));
    if (t === "new_eden") {
      // New Eden defaults: ±100 inventory cap, margin enabled (the bank).
      setCfg((c) => ({
        ...c,
        minPosition: -100,
        maxPosition: 100,
        allowMargin: true,
      }));
      setEden((e) => e ?? defaultEden());
    }
  }

  function updateSymbol(i: number, patch: Partial<SymbolConfig>) {
    setSymbols((arr) =>
      arr.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    );
  }

  async function submit() {
    setError(null);
    setSaving(true);
    try {
      const payload: CreateChallengeInput = {
        name,
        description: description || undefined,
        type,
        config: {
          ...cfg,
          symbols: symbols.map((s) => ({
            ...s,
            symbol: s.symbol.toUpperCase(),
            name: s.name || undefined,
          })),
          ...(bots.marketMakers > 0 || bots.noiseTraders > 0 ? { bots } : {}),
          ...(type === "new_eden" ? { eden } : {}),
        },
        scoring,
        startsAt: startsAt ? new Date(startsAt).toISOString() : null,
        endsAt:
          type === "new_eden" && eden.eventScript && startsAt
            ? new Date(
                new Date(startsAt).getTime() +
                  EDEN_EVENT_DURATION_MINUTES * 60000,
              ).toISOString()
            : endsAt
              ? new Date(endsAt).toISOString()
              : null,
      };
      if (existing) await patch(`/api/challenges/${existing.id}`, payload);
      else await post("/api/challenges", payload);
      router.push("/admin");
    } catch (err) {
      const issues =
        err instanceof ApiError &&
        Array.isArray((err.body as { issues?: unknown[] })?.issues)
          ? (err.body as { issues: { path: string; message: string }[] }).issues
              .map((i) => `${i.path}: ${i.message}`)
              .join(", ")
          : "Could not save challenge.";
      setError(issues);
    } finally {
      setSaving(false);
    }
  }

  const numField = (v: number, set: (n: number) => void, step = 1) => (
    <Input
      type="number"
      step={step}
      value={v}
      onChange={(e) => set(Number(e.target.value))}
      className="mono"
    />
  );

  return (
    <div className="space-y-5">
      <Panel className="rounded-md backdrop-blur-none">
        <PanelHeader title="Event details & schedule" />
        <div className="p-4 sm:p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Spring MM Cup"
              />
            </Field>
            <Field label="Type">
              <Select
                value={type}
                onChange={(e) => changeType(e.target.value as ChallengeType)}
              >
                <option value="directional">Directional (PnL race)</option>
                <option value="market_making">Market making</option>
                <option value="new_eden">New Eden Exchange</option>
              </Select>
            </Field>
          </div>
          {type === "new_eden" && (
            <section className="mt-4 space-y-2 border-t border-border pt-4">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="size-4 accent-accent"
                  checked={eden.eventScript ?? false}
                  disabled={!!existing && existing.status !== "draft"}
                  onChange={(e) => togglePlaybook(e.target.checked)}
                />
                New Eden playbook preset
              </label>
              <p className="max-w-prose text-xs text-muted">
                Enabling replaces the starting instruments and economy settings:
                AERIUM only at 1,000, 100-unit inventory cap, 50-unit order cap,
                $1/unit/minute carry and 2x loans. Starting cash defaults to
                10,000 (host-configurable).
              </p>
              <p className="max-w-prose text-xs text-muted">
                Scripted mode runs a fixed 130-minute timeline: standard bond at
                10m, pegged bond at 18m, NEURO at 30m, ORBITAL ETF (2 AERIUM + 1
                NEURO) at 45m, halt 60-70m, options at 70m, tax vote at 80m,
                dual-asset shock at 90m, grant 100-105m and close at 130m. ETF
                windows last 30s every 10m; option cycles last 5m with 15s
                exercise.
              </p>
              <p className="max-w-prose text-xs text-muted">
                Ticker every 5m outside halftime. Auction rounds: 15, 30, 45,
                75, 90, 105 and 120m; bidding opens 40s before the round and
                closes 10s before its news. Top 30% pay their bid for 10s early
                news over 15m. OTC replies allow 15s; accepted bargains bind
                through a 5s settlement delay. Host mode (toggle off) has no
                automatic timeline: the host opens markets, publishes news and
                runs operations manually. Disabling keeps the current
                configuration.
              </p>
              {eden.eventScript && (
                <p className="text-xs text-warning">
                  Do not manually duplicate scripted operations. A scheduled
                  start sets the end to start + 130 minutes on save.
                </p>
              )}
            </section>
          )}
          <div className="mt-4">
            <Field label="Description">
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          </div>
          <div className="mt-5 grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
            <Field
              label="Starts at"
              hint="Optional. Scheduled challenges auto-go live at this time."
            >
              <Input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </Field>
            <Field
              label="Ends at"
              hint="Optional. Auto-ends and drives the countdown."
            >
              <Input
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </Field>
          </div>
        </div>
      </Panel>

      <Panel className="min-w-0 rounded-md backdrop-blur-none">
        <PanelHeader title="Instruments">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setSymbols((s) => [...s, blankSymbol()])}
          >
            <Plus className="size-3.5" /> Add instrument
          </Button>
        </PanelHeader>
        <div
          className="overflow-x-auto p-4"
          tabIndex={0}
          role="region"
          aria-label="Instrument configuration"
        >
          <div className="min-w-[680px] space-y-2">
            <div
              className="grid grid-cols-[1fr_1.4fr_1fr_1fr_1fr_36px] gap-2 px-1 pb-1 text-[11px] uppercase tracking-wide text-muted"
              aria-hidden="true"
            >
              <span>Symbol</span>
              <span>Name</span>
              <span>Initial price</span>
              <span>Volatility</span>
              <span>Tick size</span>
              <span />
            </div>
            {symbols.map((s, i) => (
              <div
                key={i}
                className="grid grid-cols-[1fr_1.4fr_1fr_1fr_1fr_36px] items-center gap-2"
              >
                <Input
                  aria-label={`Instrument ${i + 1} symbol`}
                  value={s.symbol}
                  onChange={(e) =>
                    updateSymbol(i, { symbol: e.target.value.toUpperCase() })
                  }
                  placeholder="X1"
                  className="mono"
                />
                <Input
                  aria-label={`Instrument ${i + 1} name`}
                  value={s.name ?? ""}
                  onChange={(e) => updateSymbol(i, { name: e.target.value })}
                />
                <Input
                  aria-label={`Instrument ${i + 1} initial price`}
                  type="number"
                  step="0.01"
                  value={s.initialPrice}
                  onChange={(e) =>
                    updateSymbol(i, { initialPrice: Number(e.target.value) })
                  }
                  className="mono"
                />
                <Input
                  aria-label={`Instrument ${i + 1} volatility`}
                  type="number"
                  step="0.1"
                  value={s.volatility}
                  onChange={(e) =>
                    updateSymbol(i, { volatility: Number(e.target.value) })
                  }
                  className="mono"
                />
                <Input
                  aria-label={`Instrument ${i + 1} tick size`}
                  type="number"
                  step="0.01"
                  value={s.tickSize}
                  onChange={(e) =>
                    updateSymbol(i, { tickSize: Number(e.target.value) })
                  }
                  className="mono"
                />
                <button
                  onClick={() =>
                    setSymbols((arr) => arr.filter((_, idx) => idx !== i))
                  }
                  disabled={symbols.length === 1}
                  className="grid size-9 place-items-center rounded-md text-muted hover:bg-down-subtle hover:text-down focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-30"
                  aria-label={`Remove instrument ${s.symbol || i + 1}`}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted">
          Prices and tick sizes are per instrument. At least one instrument is
          required.
        </p>
      </Panel>

      <Panel className="rounded-md backdrop-blur-none">
        <PanelHeader title="Trading limits & rules" />
        <div className="grid gap-4 p-4 sm:grid-cols-3 sm:p-5">
          <Field label="Starting cash">
            {numField(cfg.startingCash, (n) =>
              setCfg({ ...cfg, startingCash: n }),
            )}
          </Field>
          <Field label="Min position">
            {numField(cfg.minPosition, (n) =>
              setCfg({ ...cfg, minPosition: n }),
            )}
          </Field>
          <Field label="Max position">
            {numField(cfg.maxPosition, (n) =>
              setCfg({ ...cfg, maxPosition: n }),
            )}
          </Field>
          <Field label="Max order qty">
            {numField(cfg.maxOrderQuantity, (n) =>
              setCfg({ ...cfg, maxOrderQuantity: n }),
            )}
          </Field>
          <Field label="Max open orders">
            {numField(cfg.maxOpenOrders, (n) =>
              setCfg({
                ...cfg,
                maxOpenOrders: Math.max(1, Math.round(n)),
              }),
            )}
          </Field>
          <Field label="Max orders / sec">
            {numField(cfg.maxOrdersPerSecond, (n) =>
              setCfg({
                ...cfg,
                maxOrdersPerSecond: Math.max(1, Math.round(n)),
              }),
            )}
          </Field>
          <Field label="Max volume / min">
            {numField(cfg.maxVolumePerMinute, (n) =>
              setCfg({
                ...cfg,
                maxVolumePerMinute: Math.max(1, Math.round(n)),
              }),
            )}
          </Field>
          <Field label="Allow margin">
            <Select
              value={String(cfg.allowMargin)}
              onChange={(e) =>
                setCfg({ ...cfg, allowMargin: e.target.value === "true" })
              }
            >
              <option value="true">Yes</option>
              <option value="false">No</option>
            </Select>
          </Field>
          <Field label="Autonomous price">
            <Select
              value={String(cfg.autonomousPrice)}
              onChange={(e) =>
                setCfg({ ...cfg, autonomousPrice: e.target.value === "true" })
              }
            >
              <option value="true">Yes</option>
              <option value="false">No</option>
            </Select>
          </Field>
        </div>
      </Panel>

      <Panel className="rounded-md backdrop-blur-none">
        <PanelHeader title="Autonomous agents" />
        <div className="p-4 sm:p-5">
          <p className="mb-3 text-xs text-muted">
            Bots keep the market liquid. Market makers quote two-sided
            liquidity; noise traders generate taker flow for participants to
            capture.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Market makers">
              {numField(bots.marketMakers, (n) =>
                setBots({
                  ...bots,
                  marketMakers: Math.max(0, Math.min(10, Math.round(n))),
                }),
              )}
            </Field>
            <Field label="Noise traders">
              {numField(bots.noiseTraders, (n) =>
                setBots({
                  ...bots,
                  noiseTraders: Math.max(0, Math.min(30, Math.round(n))),
                }),
              )}
            </Field>
            <Field label="Intensity (0-1)" hint="Bot activity per tick.">
              {numField(
                bots.intensity,
                (n) =>
                  setBots({ ...bots, intensity: Math.max(0, Math.min(1, n)) }),
                0.1,
              )}
            </Field>
            <Field label="MM half-spread">
              {numField(
                bots.spread,
                (n) => setBots({ ...bots, spread: Math.max(0, n) }),
                0.05,
              )}
            </Field>
            <Field label="MM quote size">
              {numField(bots.quoteSize, (n) =>
                setBots({ ...bots, quoteSize: Math.max(1, Math.round(n)) }),
              )}
            </Field>
          </div>
        </div>
      </Panel>

      {type === "new_eden" && (
        <Panel className="rounded-md backdrop-blur-none">
          <PanelHeader title="New Eden economy" />
          <div className="p-4 sm:p-5">
            <p className="mb-3 text-xs text-muted">
              The central bank charges a holding fee per unit of inventory,
              lends at a punitive multiple, and force-liquidates traders whose
              free cash goes negative. Options, bonds, ETFs, OTC deals,
              auctions, votes and grants are driven live from the host console.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label="Carry / unit / min"
                hint="Holding fee per |unit| each game-minute."
              >
                {numField(
                  eden.rules.costOfCarryPerUnitPerMinute,
                  (n) =>
                    setEden({
                      ...eden,
                      rules: {
                        ...eden.rules,
                        costOfCarryPerUnitPerMinute: Math.max(0, n),
                      },
                    }),
                  0.5,
                )}
              </Field>
              <Field label="Loan repay ×" hint="Borrow X, repay this × X.">
                {numField(
                  eden.rules.loanRepayMultiplier,
                  (n) =>
                    setEden({
                      ...eden,
                      rules: {
                        ...eden.rules,
                        loanRepayMultiplier: Math.max(1, n),
                      },
                    }),
                  0.5,
                )}
              </Field>
              <Field
                label="Position cap"
                hint="Absolute inventory breach threshold."
              >
                {numField(eden.rules.positionCap, (n) =>
                  setEden({
                    ...eden,
                    rules: {
                      ...eden.rules,
                      positionCap: Math.max(1, Math.round(n)),
                    },
                  }),
                )}
              </Field>
              <Field label="Margin call at free cash ≤">
                {numField(eden.rules.marginCallThreshold, (n) =>
                  setEden({
                    ...eden,
                    rules: { ...eden.rules, marginCallThreshold: n },
                  }),
                )}
              </Field>
              <Field label="Force liquidate">
                <Select
                  value={String(eden.rules.forcedLiquidation)}
                  onChange={(e) =>
                    setEden({
                      ...eden,
                      rules: {
                        ...eden.rules,
                        forcedLiquidation: e.target.value === "true",
                      },
                    })
                  }
                >
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </Select>
              </Field>
            </div>
            <h3 className="mb-3 mt-5 border-t border-border pt-4 text-xs font-semibold uppercase tracking-wide text-muted">
              Premium feed terms
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Auction duration (s)">
                {numField(eden.auctionDurationSec, (n) =>
                  setEden({
                    ...eden,
                    auctionDurationSec: Math.max(1, Math.round(n)),
                  }),
                )}
              </Field>
              <Field label="Winning fraction (0-1)">
                {numField(
                  eden.auctionWinnerFraction,
                  (n) =>
                    setEden({
                      ...eden,
                      auctionWinnerFraction: Math.max(0, Math.min(1, n)),
                    }),
                  0.05,
                )}
              </Field>
              <Field label="Early news lead (s)">
                {numField(eden.premiumLeadSec, (n) =>
                  setEden({
                    ...eden,
                    premiumLeadSec: Math.max(1, Math.round(n)),
                  }),
                )}
              </Field>
              <Field label="Access duration (min)">
                {numField(eden.premiumAccessMinutes, (n) =>
                  setEden({
                    ...eden,
                    premiumAccessMinutes: Math.max(1, Math.round(n)),
                  }),
                )}
              </Field>
            </div>
            <h3 className="mb-3 mt-5 border-t border-border pt-4 text-xs font-semibold uppercase tracking-wide text-muted">
              Bot ecosystem
            </h3>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="HFT market makers">
                {numField(eden.bots?.hftMarketMakers ?? 0, (n) =>
                  setEden({
                    ...eden,
                    bots: {
                      ...defaultEden().bots!,
                      ...eden.bots,
                      hftMarketMakers: Math.max(0, Math.min(10, Math.round(n))),
                    },
                  }),
                )}
              </Field>
              <Field label="Momentum traders">
                {numField(eden.bots?.momentumTraders ?? 0, (n) =>
                  setEden({
                    ...eden,
                    bots: {
                      ...defaultEden().bots!,
                      ...eden.bots,
                      momentumTraders: Math.max(0, Math.min(30, Math.round(n))),
                    },
                  }),
                )}
              </Field>
              <Field label="Vega snipers">
                {numField(eden.bots?.vegaSnipers ?? 0, (n) =>
                  setEden({
                    ...eden,
                    bots: {
                      ...defaultEden().bots!,
                      ...eden.bots,
                      vegaSnipers: Math.max(0, Math.min(10, Math.round(n))),
                    },
                  }),
                )}
              </Field>
              <Field label="Parity arbers">
                {numField(eden.bots?.parityArbers ?? 0, (n) =>
                  setEden({
                    ...eden,
                    bots: {
                      ...defaultEden().bots!,
                      ...eden.bots,
                      parityArbers: Math.max(0, Math.min(10, Math.round(n))),
                    },
                  }),
                )}
              </Field>
              <Field label="MM half-spread">
                {numField(
                  eden.bots?.spread ?? 1,
                  (n) =>
                    setEden({
                      ...eden,
                      bots: {
                        ...defaultEden().bots!,
                        ...eden.bots,
                        spread: Math.max(0, n),
                      },
                    }),
                  0.1,
                )}
              </Field>
              <Field label="Intensity (0-1)">
                {numField(
                  eden.bots?.intensity ?? 0.5,
                  (n) =>
                    setEden({
                      ...eden,
                      bots: {
                        ...defaultEden().bots!,
                        ...eden.bots,
                        intensity: Math.max(0, Math.min(1, n)),
                      },
                    }),
                  0.1,
                )}
              </Field>
            </div>
            <h3 className="mb-3 mt-5 border-t border-border pt-4 text-xs font-semibold uppercase tracking-wide text-muted">
              Bond templates
            </h3>
            <p className="mb-3 text-xs text-muted">
              Host mode: saving a template makes it available for purchase.
              Scripted mode issues its own bonds at 10m and 18m.
            </p>
            {(eden.bonds ?? []).map((bond, i) => {
              const update = (patch: Partial<typeof bond>) =>
                setEden({
                  ...eden,
                  bonds: eden.bonds!.map((b, j) =>
                    j === i ? { ...b, ...patch } : b,
                  ),
                });
              return (
                <fieldset
                  key={i}
                  disabled={eden.eventScript}
                  aria-label={`Bond ${bond.name}`}
                  className="grid gap-3 border-t border-border py-3 sm:grid-cols-3"
                >
                  <Field label="Bond ID">
                    <Input
                      value={bond.id}
                      onChange={(e) => update({ id: e.target.value })}
                    />
                  </Field>
                  <Field label="Name">
                    <Input
                      value={bond.name}
                      onChange={(e) => update({ name: e.target.value })}
                    />
                  </Field>
                  <Field label="Purchase price">
                    {numField(bond.price, (n) => update({ price: n }), 0.01)}
                  </Field>
                  <Field label="Face value">
                    {numField(
                      bond.faceValue,
                      (n) => update({ faceValue: n }),
                      0.01,
                    )}
                  </Field>
                  <Field label="Per-trader limit">
                    {numField(bond.maxPerUser, (n) =>
                      update({ maxPerUser: Math.max(1, Math.round(n)) }),
                    )}
                  </Field>
                  <Field label="Coupon type">
                    <Select
                      value={bond.peggedYield ? "pegged" : "fixed"}
                      onChange={(e) =>
                        update(
                          e.target.value === "pegged"
                            ? {
                                couponPer5Min: undefined,
                                peggedYield: {
                                  symbol: symbols[0]?.symbol ?? "AERIUM",
                                  base: 2000,
                                  divisor: 10,
                                },
                              }
                            : { peggedYield: undefined, couponPer5Min: 500 },
                        )
                      }
                    >
                      <option value="fixed">Fixed / 5m</option>
                      <option value="pegged">Pegged / 5m</option>
                    </Select>
                  </Field>
                  {bond.peggedYield ? (
                    <>
                      <Field label="Peg symbol">
                        <Select
                          value={bond.peggedYield.symbol}
                          onChange={(e) =>
                            update({
                              peggedYield: {
                                ...bond.peggedYield!,
                                symbol: e.target.value,
                              },
                            })
                          }
                        >
                          {symbols.map((s) => (
                            <option key={s.symbol}>{s.symbol}</option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Base">
                        {numField(bond.peggedYield.base, (n) =>
                          update({
                            peggedYield: { ...bond.peggedYield!, base: n },
                          }),
                        )}
                      </Field>
                      <Field label="Divisor (> 0)">
                        {numField(bond.peggedYield.divisor, (n) =>
                          update({
                            peggedYield: { ...bond.peggedYield!, divisor: n },
                          }),
                        )}
                      </Field>
                      <p className="text-xs text-warning sm:col-span-3">
                        Coupon = (base - market price) / divisor. Negative
                        coupons debit the holder.
                      </p>
                    </>
                  ) : (
                    <Field label="Fixed coupon / 5m">
                      {numField(
                        bond.couponPer5Min ?? 0,
                        (n) => update({ couponPer5Min: Math.max(0, n) }),
                        0.01,
                      )}
                    </Field>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setEden({
                        ...eden,
                        bonds: eden.bonds!.filter((_, j) => j !== i),
                      })
                    }
                  >
                    Remove bond
                  </Button>
                </fieldset>
              );
            })}
            <Button
              variant="secondary"
              size="sm"
              disabled={(eden.bonds?.length ?? 0) >= 8 || eden.eventScript}
              onClick={() =>
                setEden({
                  ...eden,
                  bonds: [
                    ...(eden.bonds ?? []),
                    {
                      id: `bond_${Date.now()}`,
                      name: "Standard Bond",
                      price: 10000,
                      faceValue: 10000,
                      couponPer5Min: 500,
                      maxPerUser: 1,
                    },
                  ],
                })
              }
            >
              Add bond
            </Button>
          </div>
        </Panel>
      )}

      <Panel className="rounded-md backdrop-blur-none">
        <PanelHeader title="Scoring model" />
        <div className="p-4 sm:p-5">
          {scoring.kind === "directional" ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="PnL weight">
                {numField(
                  scoring.pnlWeight,
                  (n) => setScoring({ ...scoring, pnlWeight: n }),
                  0.1,
                )}
              </Field>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Spread capture weight">
                {numField(
                  scoring.spreadCaptureWeight,
                  (n) => setScoring({ ...scoring, spreadCaptureWeight: n }),
                  0.1,
                )}
              </Field>
              <Field label="Quote uptime weight">
                {numField(
                  scoring.quoteUptimeWeight,
                  (n) => setScoring({ ...scoring, quoteUptimeWeight: n }),
                  0.05,
                )}
              </Field>
              <Field label="Max spread">
                {numField(
                  scoring.maxSpread,
                  (n) => setScoring({ ...scoring, maxSpread: n }),
                  0.1,
                )}
              </Field>
              <Field label="Min quote size">
                {numField(scoring.minQuoteSize, (n) =>
                  setScoring({ ...scoring, minQuoteSize: n }),
                )}
              </Field>
              <Field label="Inventory penalty">
                {numField(
                  scoring.inventoryPenaltyWeight,
                  (n) => setScoring({ ...scoring, inventoryPenaltyWeight: n }),
                  0.01,
                )}
              </Field>
              <Field label="PnL weight">
                {numField(
                  scoring.pnlWeight,
                  (n) => setScoring({ ...scoring, pnlWeight: n }),
                  0.05,
                )}
              </Field>
            </div>
          )}
        </div>
      </Panel>

      {error && (
        <div
          role="alert"
          className="break-words rounded-md border border-down/30 bg-surface px-4 py-3 text-sm text-down"
        >
          {error}
        </div>
      )}
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface px-4 py-3">
        <p className="text-xs text-muted">
          {existing
            ? "Changes apply when you save."
            : "Review your configuration before creating."}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => router.push("/admin")}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={saving}
            disabled={!name || symbols.some((s) => !s.symbol)}
          >
            {existing ? "Save changes" : "Create challenge"}
          </Button>
        </div>
      </div>
    </div>
  );
}
