"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  CalendarClock,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Snowflake,
  Square,
} from "lucide-react";
import type { Challenge, ChallengeStatus } from "@qtp/shared";
import { get, post } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { AdminGuard } from "@/components/AdminGuard";
import { Button } from "@/components/ui/Button";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { Input, Select } from "@/components/ui/Input";

function AdminInner() {
  const [challenges, setChallenges] = useState<Challenge[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setChallenges(await get<Challenge[]>("/api/challenges"));
    } catch {
      setError("Could not load challenges. Refresh to try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function setStatus(id: string, status: ChallengeStatus) {
    setBusy(id + status);
    setError(null);
    try {
      await post(`/api/challenges/${id}/status`, { status });
      await load();
    } catch {
      setError(
        "Could not change challenge status. Refresh to check its current state, then try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function setFrozen(id: string, frozen: boolean) {
    setBusy(id + (frozen ? "freeze" : "unfreeze"));
    setError(null);
    try {
      await post(`/api/admin/${id}/freeze`, { frozen });
      await load();
    } catch {
      setError(
        "Could not update market freeze. Refresh to check its current state, then try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function reset(id: string) {
    if (
      !confirm(
        "Reset all trading state (orders, trades, positions, prices) for this challenge?",
      )
    )
      return;
    setBusy(id + "reset");
    setError(null);
    try {
      await post(`/api/admin/${id}/reset`);
      await load();
    } catch {
      setError(
        "Could not reset the challenge. Refresh to check its current state before retrying.",
      );
    } finally {
      setBusy(null);
    }
  }

  const filtered = challenges?.filter(
    (c) =>
      (statusFilter === "all" || c.status === statusFilter) &&
      c.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div className="min-h-dvh">
      <TopBar />
      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
          <div className="space-y-2">
            <p className="mono text-[11px] uppercase tracking-[0.16em] text-muted">
              Administration / Event operations
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">
              Challenge control
            </h1>
            <p className="text-sm text-muted">
              Configure markets. Manage sessions. Run the exchange.
            </p>
          </div>
          <Link
            href="/admin/new"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-accent px-3.5 text-sm font-semibold text-accent-fg transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            <Plus className="size-4" /> New challenge
          </Link>
        </header>

        {error && (
          <div
            role="alert"
            className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-down/30 bg-surface px-4 py-3 text-sm text-down"
          >
            <p>{error}</p>
            <Button
              size="sm"
              variant="secondary"
              onClick={load}
              disabled={busy !== null}
              loading={loading}
            >
              Retry
            </Button>
          </div>
        )}

        <section
          aria-label="Challenges"
          className="min-w-0 overflow-hidden rounded-md border border-border bg-surface"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
              <h2 className="text-sm font-semibold text-text">
                Event register
              </h2>
              <span>
                <span className="mono text-text">
                  {challenges?.length ?? "-"}
                </span>{" "}
                total
              </span>
              <span>
                <span className="mono text-up">
                  {challenges?.filter((c) => c.status === "live").length ?? "-"}
                </span>{" "}
                live
              </span>
              <span>
                <span className="mono text-text">
                  {challenges?.filter((c) => c.status === "scheduled").length ??
                    "-"}
                </span>{" "}
                scheduled
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={load}
              disabled={busy !== null}
              loading={loading}
            >
              <RotateCcw className="size-3.5" /> Refresh
            </Button>
          </div>
          <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row">
            <Input
              aria-label="Search challenges"
              placeholder="Search challenges..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="sm:max-w-xs"
            />
            <Select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="sm:w-44"
            >
              <option value="all">All statuses</option>
              <option value="draft">Draft</option>
              <option value="scheduled">Scheduled</option>
              <option value="live">Live</option>
              <option value="paused">Paused</option>
              <option value="ended">Ended</option>
            </Select>
          </div>
          <p className="border-b border-border px-4 py-2 text-xs text-muted lg:hidden">
            Scroll horizontally for status and session controls.
          </p>
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="Event register table"
            aria-busy={loading}
          >
            <table className="w-full min-w-[1040px] text-left text-sm">
              <thead className="border-b border-border bg-surface-2 text-[11px] uppercase tracking-wider text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Challenge / Format
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Traders
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Start time <span className="normal-case">(local)</span>
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Session controls
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {!challenges && loading && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-10 text-muted"
                      role="status"
                    >
                      Loading event register...
                    </td>
                  </tr>
                )}
                {!challenges && !loading && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-muted">
                      Event register unavailable. Use Retry above to reconnect.
                    </td>
                  </tr>
                )}
                {filtered?.map((c) => (
                  <tr
                    key={c.id}
                    className="align-middle transition-colors hover:bg-surface-2"
                  >
                    <th scope="row" className="max-w-80 px-4 py-4 font-normal">
                      <Link
                        href={`/admin/${c.id}`}
                        className="break-words font-semibold hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        {c.name}
                      </Link>
                      <div className="mt-1 text-xs text-muted">
                        {c.type === "new_eden"
                          ? "New Eden Exchange"
                          : c.type === "market_making"
                            ? "Market making"
                            : "Directional"}
                        <span className="mx-2 text-faint">/</span>
                        {c.config.symbols.length} instruments
                      </div>
                    </th>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge status={c.status} />
                        {c.frozen && c.status === "live" && (
                          <Badge tone="warning">Frozen</Badge>
                        )}
                      </div>
                    </td>
                    <td className="mono px-4 py-4 text-right">
                      {c.participantCount ?? 0}
                    </td>
                    <td className="whitespace-nowrap px-4 py-4 text-xs text-muted">
                      {c.startsAt ? (
                        <time dateTime={c.startsAt} className="mono">
                          {new Date(c.startsAt).toLocaleString([], {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      ) : (
                        "Manual start"
                      )}
                    </td>

                    <td className="px-4 py-4">
                      <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                        <Link
                          href={`/admin/${c.id}`}
                          className="mr-2 inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-text hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          Edit <ArrowUpRight className="size-3.5" />
                        </Link>
                        {c.status !== "live" &&
                          c.status !== "scheduled" &&
                          c.startsAt &&
                          new Date(c.startsAt).getTime() > Date.now() && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy !== null}
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
                            disabled={busy !== null}
                            loading={busy === c.id + "live"}
                            onClick={() => setStatus(c.id, "live")}
                          >
                            <Play className="size-3.5" />{" "}
                            {c.status === "paused" ? "Resume" : "Start"}
                          </Button>
                        )}
                        {c.status === "live" && (
                          <>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy !== null}
                              loading={
                                busy === c.id + (c.frozen ? "unfreeze" : "freeze")
                              }
                              onClick={() => setFrozen(c.id, !c.frozen)}
                            >
                              <Snowflake className="size-3.5" />{" "}
                              {c.frozen ? "Unfreeze" : "Freeze"}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy !== null}
                              loading={busy === c.id + "paused"}
                              onClick={() => setStatus(c.id, "paused")}
                            >
                              <Pause className="size-3.5" /> Pause
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={busy !== null}
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
                          disabled={busy !== null}
                          className="ml-2 text-muted hover:bg-down-subtle hover:text-down"
                          loading={busy === c.id + "reset"}
                          onClick={() => reset(c.id)}
                          aria-label={`Reset trading state for ${c.name}`}
                        >
                          <RotateCcw className="size-3.5" /> Reset
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered?.length === 0 && (
            <div className="space-y-2 px-4 py-12 text-center">
              <h3 className="text-sm font-semibold">
                {challenges?.length === 0
                  ? "Your first session starts here"
                  : "No matching challenges"}
              </h3>
              <p className="text-sm text-muted">
                {challenges?.length === 0
                  ? "Create a challenge to configure instruments, rules, and the event schedule."
                  : "Try another name or clear the status filter."}
              </p>
              {challenges?.length === 0 ? (
                <Link
                  href="/admin/new"
                  className="inline-block rounded-sm py-2 text-sm font-medium text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Create a challenge
                </Link>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    setStatusFilter("all");
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          )}
          <div className="flex flex-wrap justify-between gap-2 border-t border-border px-4 py-3 text-xs text-muted">
            <span className="mono">
              {filtered?.length ?? 0} / {challenges?.length ?? 0} events shown
            </span>
            <span>Reset clears trading state and requires confirmation.</span>
          </div>
        </section>
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
