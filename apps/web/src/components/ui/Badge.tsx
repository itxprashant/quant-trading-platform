import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { ChallengeStatus } from "@qtp/shared";

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "up" | "down" | "warning" | "info";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-surface-2 text-muted border-border",
    accent: "bg-accent-subtle text-accent border-accent/30",
    up: "bg-up-subtle text-up border-up/30",
    down: "bg-down-subtle text-down border-down/30",
    warning: "bg-warning/15 text-warning border-warning/30",
    info: "bg-info/15 text-info border-info/30",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: ChallengeStatus }) {
  const map: Record<ChallengeStatus, { tone: "neutral" | "up" | "warning" | "info" | "accent"; label: string; dot?: boolean }> = {
    draft: { tone: "neutral", label: "Draft" },
    scheduled: { tone: "info", label: "Scheduled" },
    live: { tone: "up", label: "Live", dot: true },
    paused: { tone: "warning", label: "Paused" },
    ended: { tone: "neutral", label: "Ended" },
  };
  const s = map[status];
  return (
    <Badge tone={s.tone}>
      {s.dot && <span className="size-1.5 rounded-full bg-up animate-pulse" />}
      {s.label}
    </Badge>
  );
}
