"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  AdminCheckpoint,
  AdminCheckpointResume,
  Challenge,
} from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { ApiError, get, post } from "@/lib/api";

const RESUME_ERRORS: Record<string, string> = {
  engine_still_running:
    "The engine has not released the event yet. It is paused; press Resume again in a few seconds.",
  challenge_ended: "The event has ended. Final results cannot be rewound.",
  not_running: "Resume works while the event is live or paused.",
  not_paused:
    "The event status changed during the resume. Reload the page and try again.",
  invalid_checkpoint: "This checkpoint cannot be loaded. Pick another one.",
  checkpoint_not_found: "That checkpoint no longer exists. Reload the list.",
};

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

/**
 * Rewind points saved by the engine every two minutes. Resuming restores one
 * and slides the event clock so the time left matches that moment.
 */
export function CheckpointsPanel({
  challenge,
  onChange,
}: {
  challenge: Challenge;
  /** Called after a resume, since it changes status, times, and config. */
  onChange?: () => void;
}) {
  const [items, setItems] = useState<AdminCheckpoint[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const res = await get<{ items: AdminCheckpoint[] }>(
        `/api/admin/${challenge.id}/checkpoints`,
      );
      setItems(res.items);
      setLoadError(null);
    } catch {
      setLoadError("Could not load checkpoints. Retrying automatically.");
    }
    setNow(Date.now());
  }, [challenge.id]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function resume(cp: AdminCheckpoint) {
    if (
      !confirm(
        `Resume from ${clock(cp.takenAt)} (minute ${cp.minuteCount})?\n\n` +
          "Everything after that moment is discarded: trades, orders, cash, positions, news, auctions, deals and cue progress. " +
          "The event goes live straight away with the time it had left then.\n\n" +
          "The current state is saved as a checkpoint first, so you can resume back to it.",
      )
    )
      return;
    setBusy(cp.id);
    setError(null);
    setNotice(null);
    try {
      const res = await post<AdminCheckpointResume>(
        `/api/admin/${challenge.id}/checkpoints/${cp.id}/resume`,
      );
      setNotice(
        `Resumed from ${clock(res.takenAt)}.` +
          (res.endsAt ? ` The event now ends at ${clock(res.endsAt)}.` : "") +
          " Trader screens reload on their own.",
      );
      onChange?.();
    } catch (err) {
      const code =
        err instanceof ApiError
          ? (err.body as { error?: string } | null)?.error
          : undefined;
      setError(
        RESUME_ERRORS[code ?? ""] ??
          "Could not resume. Check whether the event is paused, then try again.",
      );
    } finally {
      setBusy(null);
      refresh();
    }
  }

  return (
    <Panel className="min-w-0 rounded-md backdrop-blur-none">
      <PanelHeader title="Checkpoints">
        {items && (
          <span className="mono text-xs text-muted">{items.length} saved</span>
        )}
      </PanelHeader>
      <p className="border-b border-border px-4 py-2 text-xs leading-relaxed text-muted">
        Saved every 2 minutes while the event is live. Resuming rewinds to
        that moment and moves the end time so the time left is unchanged.
      </p>
      {loadError && (
        <p
          role="alert"
          className="border-b border-border px-4 py-2 text-xs text-down"
        >
          {loadError}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="border-b border-border px-4 py-2 text-xs text-down"
        >
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="border-b border-border px-4 py-2 text-xs text-up"
        >
          {notice}
        </p>
      )}
      {!items ? (
        <div className="p-4" role="status" aria-label="Loading checkpoints">
          <Skeleton className="h-24" />
        </div>
      ) : items.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted">
          The first checkpoint is saved 2 minutes after the event goes live.
        </p>
      ) : (
        <ul
          className="max-h-[24rem] overflow-y-auto"
          aria-label="Checkpoints, newest first"
        >
          {items.map((cp) => (
            <li
              key={cp.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-2 last:border-0"
            >
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="mono text-sm text-text">
                  {clock(cp.takenAt)}
                </span>
                <span className="mono text-xs text-muted" title="Game minute">
                  m{cp.minuteCount}
                </span>
                <span className="text-xs text-faint">
                  {ago(cp.takenAt, now)}
                </span>
                {cp.reason === "before_resume" && (
                  <Badge tone="warning">Before resume</Badge>
                )}
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => resume(cp)}
                disabled={busy !== null}
                loading={busy === cp.id}
                aria-label={`Resume from ${clock(cp.takenAt)}`}
              >
                Resume
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
