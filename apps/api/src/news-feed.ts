import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { challengeNews, users, type Database } from "@qtp/db";
import type { NewsItem } from "@qtp/shared";
import { serializeNewsItem } from "./serialize.js";

/**
 * Published headlines, newest first, in the shape the Redis feed caches.
 * Dormant scheduled items are never part of the feed.
 */
export async function loadNewsFeed(
  db: Database,
  challengeId: string,
): Promise<NewsItem[]> {
  const rows = await db
    .select({
      id: challengeNews.id,
      challengeId: challengeNews.challengeId,
      message: challengeNews.message,
      level: challengeNews.level,
      feed: challengeNews.feed,
      createdAt: challengeNews.createdAt,
      embargoUntil: challengeNews.embargoUntil,
      authorDisplayName: users.displayName,
    })
    .from(challengeNews)
    .leftJoin(users, eq(challengeNews.createdBy, users.id))
    .where(
      and(
        eq(challengeNews.challengeId, challengeId),
        or(isNull(challengeNews.publishAt), isNotNull(challengeNews.publishedAt)),
      ),
    )
    .orderBy(desc(challengeNews.createdAt))
    .limit(50);
  return rows.map((r) => serializeNewsItem(r));
}
