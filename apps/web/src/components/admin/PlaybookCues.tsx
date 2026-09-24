"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { AdminCueSheet, AdminCueView, Challenge } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { ApiError, get, post } from "@/lib/api";
import { cn } from "@/lib/cn";

const KIND_LABEL: Record<AdminCueView["kind"], string> = {
  market: "Market",
  news: "Headline",
  otc: "Deal Desk",
  auction: "Auction",
  scene: "Scene",
};

const RUN_ERRORS: Record<string, string> = {
  cue_already_run: "That cue has already run.",
  market_frozen:
    "Deal Desk offers need an open market. Run Open market, or Reopen with options after halftime.",
  challenge_not_live: "Cues only run while the event is live.",
  not_cue_mode: "This event is not using playbook cues.",
  unknown_cue: "Unknown cue. Reload the page.",
};

/** Game-time offset, e.g. +10s or +5m 10s. */
function offset(sec: number): string {
  if (sec < 60) return `+${sec}s`;
  const rest = sec % 60;
  return `+${Math.floor(sec / 60)}m${rest ? ` ${rest}s` : ""}`;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/**
 * Cue sheet for a New Eden event in playbook-cue mode. Each cue fires one
 * playbook beat; the engine runs its steps with their built-in offsets.
 */
export function PlaybookCues({
  challenge,
  onChange,
}: {
  challenge: Challenge;
  /** Called when a cue finishes, since cues freeze, list, and close the event. */
  onChange?: () => void;
}) {
  const [sheet, setSheet] = useState<AdminCueSheet | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hideDone, setHideDone] = useState(false);
  const doneCount = useRef<number | null>(null);
  const live = challenge.status === "live";

  const refresh = useCallback(async () => {
    try {
      const next = await get<AdminCueSheet>(`/api/admin/${challenge.id}/cues`);
      setSheet(next);
      setLoadError(null);
      const count = next.cues.filter((c) => c.status === "done").length;
      if (doneCount.current !== null && count !== doneCount.current)
        onChange?.();
      doneCount.current = count;
    } catch {
      setLoadError("Could not load the cue sheet. Retrying automatically.");
    }
  }, [challenge.id, onChange]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const labelOf = (id: string) =>
    sheet?.cues.find((c) => c.id === id)?.label ?? id;

  async function run(cue: AdminCueView) {
    if (
      cue.id === "close" &&
      !confirm(
        "Close the event now? Trading halts and final rankings are computed. This cannot be undone.",
      )
    )
      return;
    setBusy(cue.id);
    setError(null);
    try {
      await post(`/api/admin/${challenge.id}/cues/run`, { cueId: cue.id });
    } catch (err) {
      const body =
        err instanceof ApiError
          ? (err.body as { error?: string; blockedBy?: string[] } | null)
          : null;
      setError(
        body?.error === "cue_blocked"
          ? `Waiting for ${(body.blockedBy ?? []).map(labelOf).join(", ")} to finish.`
          : (RUN_ERRORS[body?.error ?? ""] ??
              "Could not run the cue. Try again."),
      );
    } finally {
      setBusy(null);
    }
    // The engine records the fire a moment after the command lands.
    setTimeout(refresh, 400);
  }

  const next = sheet?.cues.find((c) => c.id === sheet.next);
  const done = sheet?.cues.filter((c) => c.status === "done").length ?? 0;
  const rows = sheet?.cues.filter((c) => !hideDone || c.status !== "done");

  return (
    <Panel className="min-w-0 rounded-md backdrop-blur-none">
      <PanelHeader title="Playbook cues">
        {sheet && (
          <span className="mono text-xs text-muted">
            {done}/{sheet.cues.length} done
          </span>
        )}
      </PanelHeader>
      {loadError && (
        <p
          role="alert"
          className="border-b border-border px-4 py-2 text-xs text-down"
        >
          {loadError}
        </p>
      )}
      {!sheet ? (
        <div className="space-y-2 p-4" role="status" aria-label="Loading cues">
          <Skeleton className="h-12" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            {next ? (
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide text-faint">
                  Next in playbook
                </p>
                <p className="mt-0.5 text-sm">
                  <span className="mono text-muted">m{next.minute}</span>{" "}
                  {next.label}
                </p>
                {next.status === "blocked" && (
                  <p className="text-xs text-faint">
                    Waiting for {next.blockedBy.map(labelOf).join(", ")} to
                    finish.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted">Every cue has run.</p>
            )}
            {next && (
              <Button
                onClick={() => run(next)}
                disabled={!live || next.status !== "ready" || busy !== null}
                loading={busy === next.id}
              >
                Run next
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-muted">
            <span>
              {live
                ? "Steps inside a cue keep their playbook offsets in game time."
                : "Cues run only while the event is live."}
            </span>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={hideDone}
                onChange={(e) => setHideDone(e.target.checked)}
                className="size-3.5 accent-accent"
              />
              Hide done
            </label>
          </div>
          {error && (
            <p
              role="alert"
              className="border-b border-border px-4 py-2 text-xs text-down"
            >
              {error}
            </p>
          )}
          <ul className="max-h-[32rem] overflow-y-auto" aria-label="Cues">
            {rows!.map((cue) => (
              <CueRow
                key={cue.id}
                cue={cue}
                isNext={cue.id === sheet.next}
                blockedBy={cue.blockedBy.map(labelOf)}
                canRun={live && busy === null}
                busy={busy === cue.id}
                onRun={() => run(cue)}
              />
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function CueRow({
  cue,
  isNext,
  blockedBy,
  canRun,
  busy,
  onRun,
}: {
  cue: AdminCueView;
  isNext: boolean;
  blockedBy: string[];
  canRun: boolean;
  busy: boolean;
  onRun: () => void;
}) {
  const stepsDone = cue.steps.filter((s) => s.done).length;
  const pending = cue.steps.find((s) => !s.done);
  const duration = cue.steps.at(-1)?.offsetSec ?? 0;
  return (
    <li
      className={cn(
        "grid grid-cols-[4.25rem_minmax(0,1fr)_auto] items-start gap-3 border-b border-border px-4 py-2.5 last:border-0",
        isNext && "bg-accent-subtle/40",
        cue.status === "done" && "text-muted",
      )}
    >
      <div className="pt-0.5">
        <p className="mono text-xs text-text">m{cue.minute}</p>
        <p className="whitespace-nowrap text-[10px] uppercase tracking-wide text-faint">
          {KIND_LABEL[cue.kind]}
        </p>
      </div>
      <div className="min-w-0 space-y-1">
        <p className="break-words text-sm">
          {cue.kind === "news" && cue.headlines[0] && (
            <Badge
              tone={
                cue.headlines[0].classification === "signal"
                  ? "info"
                  : "neutral"
              }
              className="mr-2 align-middle"
            >
              {cue.headlines[0].classification === "signal"
                ? "Signal"
                : "Noise"}
            </Badge>
          )}
          {cue.label}
        </p>
        {cue.kind !== "news" &&
          cue.headlines.map((h) => (
            <p key={h.minute} className="break-words text-xs text-muted">
              <span className="mono text-faint">m{h.minute}</span>{" "}
              <span className="uppercase text-faint">{h.classification}</span>{" "}
              {h.text}
            </p>
          ))}
        {cue.status === "blocked" && (
          <p className="text-xs text-faint">Needs {blockedBy.join(", ")}</p>
        )}
        {cue.status === "running" && pending && (
          <p className="text-xs text-info">
            {stepsDone}/{cue.steps.length} steps · next: {pending.label} at{" "}
            {offset(pending.offsetSec)}
          </p>
        )}
        {cue.steps.length > 1 && (
          <details className="text-xs text-muted">
            <summary className="cursor-pointer select-none text-faint hover:text-text">
              {cue.steps.length} steps over {offset(duration).slice(1)}
            </summary>
            <ol className="mt-1 space-y-0.5">
              {cue.steps.map((step, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mono w-14 shrink-0 text-faint">
                    {offset(step.offsetSec)}
                  </span>
                  <span className={cn(step.done && "text-faint line-through")}>
                    {step.label}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
      <div className="flex items-center gap-2 pt-0.5">
        {cue.status === "done" ? (
          <span className="flex items-center gap-1 text-xs text-muted">
            <Check className="size-3.5" aria-hidden />
            <span className="mono">
              {cue.firedAt ? clock(cue.firedAt) : "Done"}
            </span>
          </span>
        ) : cue.status === "running" ? (
          <Badge tone="info">Running</Badge>
        ) : (
          <Button
            size="sm"
            variant={cue.id === "close" ? "danger" : "secondary"}
            onClick={onRun}
            disabled={!canRun || cue.status === "blocked"}
            loading={busy}
            aria-label={`Run ${cue.label}`}
          >
            Run
          </Button>
        )}
      </div>
    </li>
  );
}
