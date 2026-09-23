"use client";

import { useEffect, useState } from "react";
import type { Auction, Challenge, OptionContract } from "@qtp/shared";
import { eventTimers, type EventTimer } from "@/lib/eden";
import { clock } from "@/lib/format";
import { cn } from "@/lib/cn";

const toneClass: Record<EventTimer["tone"], string> = {
  neutral: "text-text",
  active: "text-up",
  warning: "text-warning",
};

/**
 * Navbar countdowns for the event clock, auctions, option expiry, ETF windows,
 * and the next scripted headline.
 */
export function EventTimers({
  challenge,
  auction,
  contracts,
  premium,
  onAuctionClick,
}: {
  challenge: Challenge;
  auction: Auction | null;
  contracts: OptionContract[];
  premium: boolean;
  onAuctionClick?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const timers = eventTimers({
    now,
    status: challenge.status,
    startsAt: challenge.startsAt,
    endsAt: challenge.endsAt,
    scripted:
      challenge.type === "new_eden" && !!challenge.config.eden?.eventScript,
    auction,
    contracts,
    exerciseWindowSec: challenge.config.eden?.options?.exerciseWindowSec ?? 15,
    premium,
  });
  if (timers.length === 0) return null;

  return (
    <ul
      aria-label="Event timers"
      className="flex min-w-max items-stretch gap-1.5"
    >
      {timers.map((t) => (
        <li key={t.id}>
          <TimerChip
            timer={t}
            now={now}
            onClick={t.id === "auction" ? onAuctionClick : undefined}
          />
        </li>
      ))}
    </ul>
  );
}

function TimerChip({
  timer,
  now,
  onClick,
}: {
  timer: EventTimer;
  now: number;
  onClick?: () => void;
}) {
  const value = timer.target != null ? clock(timer.target - now) : timer.text;
  const body = (
    <>
      <span className="block text-[10px] uppercase leading-none tracking-wide text-faint">
        {timer.label}
      </span>
      <span className="mt-1 flex items-baseline gap-1 leading-none">
        <span
          className={cn(
            "mono text-[13px] font-medium tabular-nums",
            toneClass[timer.tone],
          )}
        >
          {value}
        </span>
        {timer.suffix && (
          <span className="text-[11px] text-faint">{timer.suffix}</span>
        )}
        {timer.hint && (
          <span className="rounded-sm bg-accent-subtle px-1 text-[10px] font-semibold uppercase tracking-wide text-accent">
            {timer.hint}
          </span>
        )}
      </span>
    </>
  );
  const chip = cn(
    "flex h-full flex-col justify-center rounded-md border px-2.5 py-1.5 text-left",
    timer.tone === "warning"
      ? "border-warning/30 bg-warning/10"
      : timer.tone === "active"
        ? "border-up/30 bg-up-subtle"
        : "border-border bg-surface",
  );
  const label = `${timer.label}${value ? ` ${value}` : ""}${timer.suffix ? ` ${timer.suffix}` : ""}`;
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={`${label}. Show auction`}
        className={cn(
          chip,
          "transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        )}
      >
        {body}
      </button>
    );
  }
  return (
    <div className={chip} aria-label={label} role="timer">
      {body}
    </div>
  );
}
