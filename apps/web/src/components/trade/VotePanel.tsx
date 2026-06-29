"use client";

import { useCallback, useEffect, useState } from "react";
import { Vote as VoteIcon } from "lucide-react";
import type { VoteProposal } from "@qtp/shared";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { ApiError, get, post } from "@/lib/api";
import { cn } from "@/lib/cn";

interface VoteView {
  proposal: VoteProposal | null;
  myVote: "yes" | "no" | null;
}

function secsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

/**
 * Policy vote panel (Solidarity Tax, comp_desc). Traders vote yes/no on a
 * proposal; a passing wealth-tax vote redistributes cash from the richest to
 * the poorest cohort.
 */
export function VotePanel({
  challengeId,
  liveVote,
}: {
  challengeId: string;
  liveVote: VoteProposal | null;
}) {
  const [view, setView] = useState<VoteView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const r = await get<{ proposal: VoteProposal | null; myVote: "yes" | "no" | null }>(
        `/api/votes/${challengeId}`,
      );
      setView({ proposal: r.proposal, myVote: r.myVote });
    } catch {
      /* ignore */
    }
  }, [challengeId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (liveVote) load();
  }, [liveVote?.id, liveVote?.status, load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const proposal = liveVote ?? view?.proposal ?? null;
  const myVote = view?.myVote ?? null;

  if (!proposal) return null;

  const open = proposal.status === "open" && secsLeft(proposal.expiresAt) > 0;
  const total = proposal.yes + proposal.no;
  const yesPct = total > 0 ? Math.round((proposal.yes / total) * 100) : 0;

  async function cast(choice: "yes" | "no") {
    if (!proposal) return;
    setError(null);
    setBusy(true);
    try {
      await post(`/api/votes/${proposal.id}/vote`, { choice });
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? ((err.body as { error?: string })?.error ?? "Vote failed")
          : "Vote failed",
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
            <VoteIcon className="size-3.5" /> Policy vote
          </span>
        }
      >
        {open ? (
          <span className="mono text-xs text-warning">
            {secsLeft(proposal.expiresAt)}s
          </span>
        ) : (
          <span
            className={cn(
              "rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              proposal.status === "passed"
                ? "bg-up-subtle text-up"
                : "bg-down-subtle text-down",
            )}
          >
            {proposal.status}
          </span>
        )}
      </PanelHeader>

      <div className="space-y-3 p-3">
        <div>
          <p className="text-sm font-medium">{proposal.title}</p>
          <p className="mt-0.5 text-xs text-muted">{proposal.description}</p>
        </div>

        <div className="space-y-1">
          <div className="h-2 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full bg-up" style={{ width: `${yesPct}%` }} />
          </div>
          <div className="flex justify-between text-[11px] text-faint">
            <span>Yes {proposal.yes}</span>
            <span>No {proposal.no}</span>
          </div>
        </div>

        {open ? (
          <div className="flex gap-2">
            <Button
              variant={myVote === "yes" ? "buy" : "secondary"}
              className="flex-1"
              loading={busy}
              onClick={() => cast("yes")}
            >
              Yes
            </Button>
            <Button
              variant={myVote === "no" ? "sell" : "secondary"}
              className="flex-1"
              loading={busy}
              onClick={() => cast("no")}
            >
              No
            </Button>
          </div>
        ) : (
          <p className="text-xs text-faint">
            Voting closed.{" "}
            {proposal.status === "passed"
              ? "The tax was enacted."
              : "The proposal did not pass."}
          </p>
        )}
        {myVote && open && (
          <p className="text-[11px] text-faint">You voted {myVote}.</p>
        )}
        {error && <p className="text-xs text-down">{error}</p>}
      </div>
    </Panel>
  );
}
