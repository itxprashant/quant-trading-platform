import Link from "next/link";
import { ArrowRight, TrendingUp, Layers, Users } from "lucide-react";
import type { Challenge } from "@qtp/shared";
import { Panel } from "@/components/ui/Panel";
import { Badge, StatusBadge } from "@/components/ui/Badge";

export function ChallengeCard({ challenge }: { challenge: Challenge }) {
  const isMM = challenge.type === "market_making";
  return (
    <Link href={`/challenges/${challenge.id}`} className="group block">
      <Panel className="h-full p-4 transition-colors hover:border-border-strong">
        <div className="flex items-start justify-between gap-2">
          <Badge tone={isMM ? "info" : "accent"}>
            {isMM ? <Layers className="size-3" /> : <TrendingUp className="size-3" />}
            {isMM ? "Market Making" : "Directional"}
          </Badge>
          <StatusBadge status={challenge.status} />
        </div>

        <h3 className="mt-3 text-md font-semibold leading-snug">{challenge.name}</h3>
        {challenge.description && (
          <p className="mt-1 line-clamp-2 text-sm text-muted">{challenge.description}</p>
        )}

        <div className="mt-4 flex flex-wrap gap-1.5">
          {challenge.config.symbols.slice(0, 6).map((s) => (
            <span
              key={s.symbol}
              className="mono rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 text-xs text-muted"
            >
              {s.symbol}
            </span>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-sm">
          <span className="flex items-center gap-1.5 text-muted">
            <Users className="size-3.5" />
            {challenge.participantCount ?? 0} traders
          </span>
          <span className="flex items-center gap-1 font-medium text-accent opacity-0 transition-opacity group-hover:opacity-100">
            Enter <ArrowRight className="size-3.5" />
          </span>
        </div>
      </Panel>
    </Link>
  );
}
