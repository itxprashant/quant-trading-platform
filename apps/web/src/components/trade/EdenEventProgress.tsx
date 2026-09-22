"use client";

import { useEffect, useState } from "react";
import { EDEN_EVENT_DURATION_MINUTES } from "@qtp/shared";
import { eventProgress } from "@/lib/eden";

export function EdenEventProgress({ startsAt }: { startsAt: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const progress = eventProgress(startsAt, now);
  if (!progress)
    return (
      <p className="text-xs text-muted">Playbook awaiting a scheduled start.</p>
    );
  const labels = {
    pending: "Before open",
    session_one: "Session 1",
    halftime: "Halftime, inventory retained",
    session_two: "Session 2",
    ended: "Event complete",
  };
  const seconds = Math.floor(progress.elapsedSeconds);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border py-2 text-xs text-muted">
      <span>{labels[progress.phase]}</span>
      <span className="mono">
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} /{" "}
        {EDEN_EVENT_DURATION_MINUTES}:00
      </span>
      <progress
        aria-label="New Eden event elapsed time"
        max={EDEN_EVENT_DURATION_MINUTES * 60}
        value={seconds}
        className="h-1.5 w-32 accent-accent"
      />
      {progress.phase === "ended" && (
        <span>
          Trading window closed; final results follow server settlement.
        </span>
      )}
    </div>
  );
}
