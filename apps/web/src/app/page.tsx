"use client";

import { useEffect, useState } from "react";
import type { Challenge } from "@qtp/shared";
import { get } from "@/lib/api";
import { TopBar } from "@/components/TopBar";
import { ChallengeCard } from "@/components/ChallengeCard";
import { Panel } from "@/components/ui/Panel";
import { Skeleton } from "@/components/ui/Skeleton";

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

  return (
    <div className="min-h-dvh">
      <TopBar />
      <main id="main" className="mx-auto max-w-6xl px-4 py-10">
        <section className="mb-10">
          <h1 className="text-2xl font-semibold tracking-tight">Trading challenges</h1>
          <p className="mt-1 max-w-2xl text-muted">
            Compete in real-time quant trading events. Provide liquidity, trade
            direction, and climb the live leaderboard.
          </p>
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
