"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, Pause, Play, Plus, RotateCcw, Square } from "lucide-react";
import type { Challenge, ChallengeStatus } from "@qtp/shared";
import { get, post } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { AdminGuard } from "@/components/AdminGuard";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Badge, StatusBadge } from "@/components/ui/Badge";

function AdminInner() {
  const [challenges, setChallenges] = useState<Challenge[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    get<Challenge[]>("/api/challenges").then(setChallenges).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function setStatus(id: string, status: ChallengeStatus) {
    setBusy(id + status);
    try {
      await post(`/api/challenges/${id}/status`, { status });
      load();
    } finally {
      setBusy(null);
    }
  }

  async function reset(id: string) {
    if (!confirm("Reset all trading state (orders, trades, positions, prices) for this challenge?")) return;
    setBusy(id + "reset");
    try {
      await post(`/api/admin/${id}/reset`);
      load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-dvh">
      <TopBar />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Admin console</h1>
            <p className="text-sm text-muted">Create, configure, and run challenges.</p>
          </div>
          <Link href="/admin/new">
            <Button>
              <Plus className="size-4" /> New challenge
            </Button>
          </Link>
        </div>

        <Panel>
          <PanelHeader title={`Challenges (${challenges?.length ?? 0})`} />
          <div className="divide-y divide-border">
            {!challenges && <div className="p-6 text-sm text-muted">Loading…</div>}
            {challenges?.length === 0 && (
              <div className="p-8 text-center text-sm text-muted">No challenges yet.</div>
            )}
            {challenges?.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link href={`/admin/${c.id}`} className="font-medium hover:text-accent">
                      {c.name}
                    </Link>
                    <StatusBadge status={c.status} />
                    <Badge tone={c.type === "market_making" ? "info" : "accent"}>
                      {c.type === "market_making" ? "MM" : "Directional"}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-faint">
                    {c.config.symbols.length} symbols · {c.participantCount ?? 0} traders
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  {c.status !== "live" &&
                    c.status !== "scheduled" &&
                    c.startsAt &&
                    new Date(c.startsAt).getTime() > Date.now() && (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === c.id + "scheduled"}
                        onClick={() => setStatus(c.id, "scheduled")}
                      >
                        <CalendarClock className="size-3.5" /> Schedule
                      </Button>
                    )}
                  {c.status !== "live" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === c.id + "live"}
                      onClick={() => setStatus(c.id, "live")}
                    >
                      <Play className="size-3.5" /> Start
                    </Button>
                  )}
                  {c.status === "live" && (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busy === c.id + "paused"}
                        onClick={() => setStatus(c.id, "paused")}
                      >
                        <Pause className="size-3.5" /> Pause
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busy === c.id + "ended"}
                        onClick={() => setStatus(c.id, "ended")}
                      >
                        <Square className="size-3.5" /> End
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === c.id + "reset"}
                    onClick={() => reset(c.id)}
                    aria-label="Reset challenge"
                  >
                    <RotateCcw className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </main>
    </div>
  );
}

export default function AdminPage() {
  return (
    <AdminGuard>
      <AdminInner />
    </AdminGuard>
  );
}
