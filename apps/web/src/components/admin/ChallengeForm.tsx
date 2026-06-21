"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import type {
  BotConfig,
  Challenge,
  ChallengeType,
  CreateChallengeInput,
  ScoringConfig,
  SymbolConfig,
} from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Input";
import { ApiError, patch, post } from "@/lib/api";

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

export function ChallengeForm({ existing }: { existing?: Challenge }) {
  const router = useRouter();
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [type, setType] = useState<ChallengeType>(existing?.type ?? "directional");
  const [symbols, setSymbols] = useState<SymbolConfig[]>(
    existing?.config.symbols ?? [{ ...blankSymbol(), symbol: "X1" }],
  );
  const [cfg, setCfg] = useState({
    startingCash: existing?.config.startingCash ?? 0,
    minPosition: existing?.config.minPosition ?? -50,
    maxPosition: existing?.config.maxPosition ?? 50,
    maxOrderQuantity: existing?.config.maxOrderQuantity ?? 50,
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
  const [startsAt, setStartsAt] = useState(
    existing?.startsAt ? existing.startsAt.slice(0, 16) : "",
  );
  const [endsAt, setEndsAt] = useState(
    existing?.endsAt ? existing.endsAt.slice(0, 16) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function changeType(t: ChallengeType) {
    setType(t);
    setScoring(defaultScoring(t));
  }

  function updateSymbol(i: number, patch: Partial<SymbolConfig>) {
    setSymbols((arr) => arr.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
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
          ...(bots.marketMakers > 0 || bots.noiseTraders > 0
            ? { bots }
            : {}),
        },
        scoring,
        startsAt: startsAt ? new Date(startsAt).toISOString() : null,
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
      };
      if (existing) await patch(`/api/challenges/${existing.id}`, payload);
      else await post("/api/challenges", payload);
      router.push("/admin");
    } catch (err) {
      const issues =
        err instanceof ApiError && Array.isArray((err.body as { issues?: unknown[] })?.issues)
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
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-down/30 bg-down-subtle px-3 py-2 text-sm text-down">
          {error}
        </div>
      )}

      <Panel className="p-4">
        <h3 className="mb-3 text-sm font-semibold">Basics</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring MM Cup" />
          </Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => changeType(e.target.value as ChallengeType)}>
              <option value="directional">Directional (PnL race)</option>
              <option value="market_making">Market making</option>
            </Select>
          </Field>
        </div>
        <div className="mt-4">
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Starts at" hint="Optional. Scheduled challenges auto-go live at this time.">
            <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </Field>
          <Field label="Ends at" hint="Optional. Auto-ends and drives the countdown.">
            <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </Field>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Instruments">
          <Button size="sm" variant="secondary" onClick={() => setSymbols((s) => [...s, blankSymbol()])}>
            <Plus className="size-3.5" /> Add
          </Button>
        </PanelHeader>
        <div className="space-y-2 p-3">
          <div className="grid grid-cols-[1fr_1.4fr_1fr_1fr_1fr_auto] gap-2 px-1 text-[10px] uppercase tracking-wide text-faint">
            <span>Symbol</span>
            <span>Name</span>
            <span>Initial</span>
            <span>Volatility</span>
            <span>Tick</span>
            <span />
          </div>
          {symbols.map((s, i) => (
            <div key={i} className="grid grid-cols-[1fr_1.4fr_1fr_1fr_1fr_auto] items-center gap-2">
              <Input
                value={s.symbol}
                onChange={(e) => updateSymbol(i, { symbol: e.target.value.toUpperCase() })}
                placeholder="X1"
                className="mono"
              />
              <Input value={s.name ?? ""} onChange={(e) => updateSymbol(i, { name: e.target.value })} />
              <Input type="number" step="0.01" value={s.initialPrice} onChange={(e) => updateSymbol(i, { initialPrice: Number(e.target.value) })} className="mono" />
              <Input type="number" step="0.1" value={s.volatility} onChange={(e) => updateSymbol(i, { volatility: Number(e.target.value) })} className="mono" />
              <Input type="number" step="0.01" value={s.tickSize} onChange={(e) => updateSymbol(i, { tickSize: Number(e.target.value) })} className="mono" />
              <button
                onClick={() => setSymbols((arr) => arr.filter((_, idx) => idx !== i))}
                disabled={symbols.length === 1}
                className="grid size-9 place-items-center rounded-md text-faint hover:bg-down-subtle hover:text-down disabled:opacity-30"
                aria-label="Remove symbol"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      </Panel>

      <Panel className="p-4">
        <h3 className="mb-3 text-sm font-semibold">Limits & rules</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Starting cash">{numField(cfg.startingCash, (n) => setCfg({ ...cfg, startingCash: n }))}</Field>
          <Field label="Min position">{numField(cfg.minPosition, (n) => setCfg({ ...cfg, minPosition: n }))}</Field>
          <Field label="Max position">{numField(cfg.maxPosition, (n) => setCfg({ ...cfg, maxPosition: n }))}</Field>
          <Field label="Max order qty">{numField(cfg.maxOrderQuantity, (n) => setCfg({ ...cfg, maxOrderQuantity: n }))}</Field>
          <Field label="Max orders / sec">{numField(cfg.maxOrdersPerSecond, (n) => setCfg({ ...cfg, maxOrdersPerSecond: Math.max(1, Math.round(n)) }))}</Field>
          <Field label="Max volume / min">{numField(cfg.maxVolumePerMinute, (n) => setCfg({ ...cfg, maxVolumePerMinute: Math.max(1, Math.round(n)) }))}</Field>
          <Field label="Allow margin">
            <Select value={String(cfg.allowMargin)} onChange={(e) => setCfg({ ...cfg, allowMargin: e.target.value === "true" })}>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </Select>
          </Field>
          <Field label="Autonomous price">
            <Select value={String(cfg.autonomousPrice)} onChange={(e) => setCfg({ ...cfg, autonomousPrice: e.target.value === "true" })}>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </Select>
          </Field>
        </div>
      </Panel>

      <Panel className="p-4">
        <h3 className="mb-1 text-sm font-semibold">Autonomous agents</h3>
        <p className="mb-3 text-xs text-muted">
          Bots keep the market liquid. Market makers quote two-sided liquidity; noise
          traders generate taker flow for participants to capture.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Market makers">
            {numField(bots.marketMakers, (n) => setBots({ ...bots, marketMakers: Math.max(0, Math.min(10, Math.round(n))) }))}
          </Field>
          <Field label="Noise traders">
            {numField(bots.noiseTraders, (n) => setBots({ ...bots, noiseTraders: Math.max(0, Math.min(30, Math.round(n))) }))}
          </Field>
          <Field label="Intensity (0-1)" hint="Bot activity per tick.">
            {numField(bots.intensity, (n) => setBots({ ...bots, intensity: Math.max(0, Math.min(1, n)) }), 0.1)}
          </Field>
          <Field label="MM half-spread">
            {numField(bots.spread, (n) => setBots({ ...bots, spread: Math.max(0, n) }), 0.05)}
          </Field>
          <Field label="MM quote size">
            {numField(bots.quoteSize, (n) => setBots({ ...bots, quoteSize: Math.max(1, Math.round(n)) }))}
          </Field>
        </div>
      </Panel>

      <Panel className="p-4">
        <h3 className="mb-3 text-sm font-semibold">Scoring</h3>
        {scoring.kind === "directional" ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="PnL weight">
              {numField(scoring.pnlWeight, (n) => setScoring({ ...scoring, pnlWeight: n }), 0.1)}
            </Field>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Spread capture weight">{numField(scoring.spreadCaptureWeight, (n) => setScoring({ ...scoring, spreadCaptureWeight: n }), 0.1)}</Field>
            <Field label="Quote uptime weight">{numField(scoring.quoteUptimeWeight, (n) => setScoring({ ...scoring, quoteUptimeWeight: n }), 0.05)}</Field>
            <Field label="Max spread">{numField(scoring.maxSpread, (n) => setScoring({ ...scoring, maxSpread: n }), 0.1)}</Field>
            <Field label="Min quote size">{numField(scoring.minQuoteSize, (n) => setScoring({ ...scoring, minQuoteSize: n }))}</Field>
            <Field label="Inventory penalty">{numField(scoring.inventoryPenaltyWeight, (n) => setScoring({ ...scoring, inventoryPenaltyWeight: n }), 0.01)}</Field>
            <Field label="PnL weight">{numField(scoring.pnlWeight, (n) => setScoring({ ...scoring, pnlWeight: n }), 0.05)}</Field>
          </div>
        )}
      </Panel>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => router.push("/admin")}>
          Cancel
        </Button>
        <Button onClick={submit} loading={saving} disabled={!name || symbols.some((s) => !s.symbol)}>
          {existing ? "Save changes" : "Create challenge"}
        </Button>
      </div>
    </div>
  );
}
