import type { challenges, challengeNews } from "@qtp/db";
import {
  defaultScoringFor,
  type Challenge,
  type NewsItem,
  type ScoringConfig,
} from "@qtp/shared";

export function serializeChallenge(
  c: typeof challenges.$inferSelect,
  participantCount?: number,
): Challenge {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    description: c.description ?? null,
    type: c.type,
    status: c.status,
    config: c.config,
    scoring: (c.scoring as ScoringConfig) ?? defaultScoringFor(c.type),
    startsAt: c.startsAt ? c.startsAt.toISOString() : null,
    endsAt: c.endsAt ? c.endsAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    participantCount,
  };
}

export function serializeNewsItem(
  row: Pick<
    typeof challengeNews.$inferSelect,
    "id" | "challengeId" | "message" | "level" | "createdAt"
  > & { authorDisplayName?: string | null },
): NewsItem {
  return {
    id: row.id,
    challengeId: row.challengeId,
    message: row.message,
    level: row.level,
    createdAt: row.createdAt.toISOString(),
    ...(row.authorDisplayName
      ? { authorDisplayName: row.authorDisplayName }
      : {}),
  };
}
