"use client";

import { useEffect, useState } from "react";
import type { Challenge } from "@qtp/shared";
import { get } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { ChallengeCard } from "@/components/ChallengeCard";
import { Panel } from "@/components/ui/Panel";
import { Skeleton } from "@/components/ui/Skeleton";

function Stat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col items-start sm:items-end">
      <dd className="flex items-center gap-1.5">
        {accent && (
          <span className="size-1.5 rounded-full bg-up motion-safe:animate-pulse" />
        )}
        <span className="mono text-xl font-semibold tabular-nums">
          {value.toLocaleString("en-US")}
        </span>
      </dd>
      <dt className="text-[10px] font-medium uppercase tracking-wide text-faint">
        {label}
      </dt>
    </div>
  );
}

export default function HomePage() {
  const [challenges, setChallenges] = useState<Challenge[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    get<Challenge[]>("/api/challenges")
      .then(setChallenges)
      .catch(() => setError(true));
  }, []);

  const live = challenges?.filter((c) => c.status === "live") ?? [];
  const others = challenges?.filter((c) => c.status !== "live") ?? [];
  const traderCount =
    challenges?.reduce((sum, c) => sum + (c.participantCount ?? 0), 0) ?? 0;

  return (
    <div className="min-h-dvh">
      <TopBar />
      <main id="main" className="mx-auto max-w-6xl px-4 py-10">
        <section className="mb-10 flex flex-col gap-6 border-b border-border pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Trading challenges</h1>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted">
              Real-time market-making and directional contests. Provide
              liquidity, trade the move, and climb the live leaderboard.
            </p>
          </div>
          {challenges && challenges.length > 0 && (
            <dl className="flex shrink-0 items-end gap-6 sm:gap-8">
              <Stat label="Live" value={live.length} accent={live.length > 0} />
              <Stat label="Events" value={challenges.length} />
              <Stat label="Traders" value={traderCount} />
            </dl>
          )}
        </section>

        {error && (
          <Panel className="p-8 text-center text-muted">
            Couldn&apos;t reach the server. Make sure the API is running.
          </Panel>
        )}

        {!challenges && !error && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-48" />
            ))}
          </div>
        )}

        {challenges && challenges.length === 0 && (
          <Panel className="p-12 text-center">
            <p className="text-muted">No challenges yet.</p>
            <p className="mt-1 text-sm text-faint">
              An organizer needs to create and launch a challenge.
            </p>
          </Panel>
        )}

        {live.length > 0 && (
          <div className="mb-10">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
              <span className="size-2 rounded-full bg-up animate-pulse" /> Live now
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {live.map((c) => (
                <ChallengeCard key={c.id} challenge={c} />
              ))}
            </div>
          </div>
        )}

        {others.length > 0 && (
          <div>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
              Upcoming &amp; past
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {others.map((c) => (
                <ChallengeCard key={c.id} challenge={c} />
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
