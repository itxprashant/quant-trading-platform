import type { challenges, challengeNews } from "@qtp/db";
import {
  defaultScoringFor,
  traderVisibilityOf,
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
    frozen: c.frozen ?? false,
    leaderboardHidden: c.leaderboardHidden ?? false,
    traderVisibility: traderVisibilityOf(c.traderVisibility),
  };
}

export function serializeNewsItem(
  row: Pick<
    typeof challengeNews.$inferSelect,
    "id" | "challengeId" | "message" | "level" | "feed" | "createdAt"
  > & {
    authorDisplayName?: string | null;
    embargoUntil?: Date | null;
  },
): NewsItem {
  return {
    id: row.id,
    challengeId: row.challengeId,
    message: row.message,
    level: row.level,
    feed: row.feed,
    createdAt: row.createdAt.toISOString(),
    embargoUntil: row.embargoUntil ? row.embargoUntil.toISOString() : null,
    ...(row.authorDisplayName
      ? { authorDisplayName: row.authorDisplayName }
      : {}),
  };
}
