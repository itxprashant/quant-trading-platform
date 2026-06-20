import type { challenges } from "@qtp/db";
import {
  defaultScoringFor,
  type Challenge,
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
