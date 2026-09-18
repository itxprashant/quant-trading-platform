import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { Challenge } from "@qtp/shared";
import { cn } from "@/lib/cn";

export function ChallengeCard({ challenge }: { challenge: Challenge }) {
  const format =
    challenge.type === "market_making"
      ? "Market making"
      : challenge.type === "new_eden"
        ? "New Eden"
        : "Directional";
  const isLive = challenge.status === "live";
  const isEnded = challenge.status === "ended";
  const timestamp = isLive || isEnded ? challenge.endsAt : challenge.startsAt;
  const date = timestamp ? new Date(timestamp) : null;
  const validDate = date && !Number.isNaN(date.getTime());
  const participants = challenge.participantCount ?? 0;

  return (
    <Link
      href={`/challenges/${challenge.id}`}
      className="group grid gap-5 bg-surface px-4 py-5 transition-colors hover:bg-surface-2 focus-visible:relative focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:grid-cols-[minmax(0,1fr)_150px] sm:gap-6 sm:px-5 lg:grid-cols-[minmax(0,1fr)_150px_100px]"
    >
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 font-medium capitalize",
              isLive ? "text-up" : "text-muted",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                isLive ? "bg-up" : "bg-faint",
              )}
            />
            {challenge.status}
          </span>
          <span aria-hidden="true" className="text-faint">
            /
          </span>
          <span className="text-muted">{format}</span>
        </div>
        <h3 className="break-words text-lg font-semibold tracking-tight transition-colors group-hover:text-accent">
          {challenge.name}
        </h3>
        {challenge.description && (
          <p className="mt-1 line-clamp-2 break-words text-sm leading-relaxed text-muted">
            {challenge.description}
          </p>
        )}
        <div
          className="mono mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted"
          aria-label="Instruments"
        >
          {challenge.config.symbols.slice(0, 6).map((symbol) => (
            <span className="break-all" key={symbol.symbol}>
              {symbol.symbol}
            </span>
          ))}
          {challenge.config.symbols.length > 6 && (
            <span>+{challenge.config.symbols.length - 6} more</span>
          )}
        </div>
      </div>
      <div className="flex items-end justify-between gap-4 sm:flex-col sm:items-start sm:justify-center sm:gap-2">
        <div>
          <p className="mb-1 text-xs text-muted">
            {isEnded
              ? "Ended"
              : isLive
                ? "Ends"
                : challenge.status === "paused"
                  ? "Started"
                  : "Starts"}
          </p>
          {validDate ? (
            <time
              dateTime={timestamp!}
              className="mono text-xs leading-relaxed"
            >
              {date.toLocaleDateString("en-GB", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                timeZone: "UTC",
              })}
              <span className="block text-muted">
                {date.toLocaleTimeString("en-GB", {
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: "UTC",
                })}{" "}
                UTC
              </span>
            </time>
          ) : (
            <p className="text-xs text-muted">
              {isLive
                ? "Open session"
                : isEnded
                  ? "Time not recorded"
                  : "Not scheduled"}
            </p>
          )}
        </div>
        <p className="text-xs text-muted">
          <span className="mono text-text">
            {participants.toLocaleString("en-US")}
          </span>{" "}
          {participants === 1 ? "trader" : "traders"}
        </p>
      </div>
      <span className="flex min-h-8 items-center justify-between gap-2 border-t border-border pt-3 text-xs font-medium text-accent sm:col-span-2 lg:col-span-1 lg:justify-end lg:border-0 lg:pt-0">
        {isLive ? "Open desk" : "View event"}
        <ArrowRight aria-hidden="true" className="size-4 shrink-0" />
      </span>
    </Link>
  );
}
