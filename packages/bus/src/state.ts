import {
  NEWS_FEED_MAX,
  PRICE_HISTORY_MAX,
  redisKeys,
  type LeaderboardEntry,
  type NewsItem,
  type OrderBookSnapshot,
  type PricePoint,
  type TraderMetrics,
} from "@qtp/shared";
import type { Redis } from "ioredis";

/* ---- Prices ---- */
export async function setPrice(
  redis: Redis,
  challengeId: string,
  symbol: string,
  price: number,
  ts: number,
): Promise<void> {
  const histKey = redisKeys.priceHistory(challengeId, symbol);
  await redis
    .pipeline()
    .set(redisKeys.price(challengeId, symbol), String(price))
    .zadd(histKey, ts, JSON.stringify({ price, ts }))
    .zremrangebyrank(histKey, 0, -(PRICE_HISTORY_MAX + 1))
    .exec();
}

export async function getPrice(
  redis: Redis,
  challengeId: string,
  symbol: string,
): Promise<number | null> {
  const v = await redis.get(redisKeys.price(challengeId, symbol));
  return v == null ? null : Number(v);
}

export async function getPriceHistory(
  redis: Redis,
  challengeId: string,
  symbol: string,
  limit = 200,
): Promise<PricePoint[]> {
  const raw = await redis.zrange(
    redisKeys.priceHistory(challengeId, symbol),
    -limit,
    -1,
  );
  return raw.map((s) => {
    const { price, ts } = JSON.parse(s) as { price: number; ts: number };
    return { symbol, price, change: 0, timestamp: ts };
  });
}

export async function setMidPrice(
  redis: Redis,
  challengeId: string,
  symbol: string,
  mid: number,
  ts: number,
): Promise<void> {
  const histKey = redisKeys.priceHistoryMid(challengeId, symbol);
  await redis
    .pipeline()
    .zadd(histKey, ts, JSON.stringify({ price: mid, ts }))
    .zremrangebyrank(histKey, 0, -(PRICE_HISTORY_MAX + 1))
    .exec();
}

export async function getMidPriceHistory(
  redis: Redis,
  challengeId: string,
  symbol: string,
  limit = 200,
): Promise<PricePoint[]> {
  const raw = await redis.zrange(
    redisKeys.priceHistoryMid(challengeId, symbol),
    -limit,
    -1,
  );
  return raw.map((s) => {
    const { price, ts } = JSON.parse(s) as { price: number; ts: number };
    return { symbol, price, change: 0, timestamp: ts };
  });
}

/* ---- Order book snapshots ---- */
export async function setBookSnapshot(
  redis: Redis,
  challengeId: string,
  snap: OrderBookSnapshot,
): Promise<void> {
  await redis.set(
    redisKeys.bookSnapshot(challengeId, snap.symbol),
    JSON.stringify(snap),
  );
}

export async function getBookSnapshot(
  redis: Redis,
  challengeId: string,
  symbol: string,
): Promise<OrderBookSnapshot | null> {
  const v = await redis.get(redisKeys.bookSnapshot(challengeId, symbol));
  return v ? (JSON.parse(v) as OrderBookSnapshot) : null;
}

/* ---- Leaderboard ---- */
export async function setLeaderboard(
  redis: Redis,
  challengeId: string,
  entries: LeaderboardEntry[],
): Promise<void> {
  await redis.set(redisKeys.leaderboard(challengeId), JSON.stringify(entries));
}

export async function getLeaderboard(
  redis: Redis,
  challengeId: string,
): Promise<LeaderboardEntry[]> {
  const v = await redis.get(redisKeys.leaderboard(challengeId));
  return v ? (JSON.parse(v) as LeaderboardEntry[]) : [];
}

/* ---- News feed ---- */
export async function pushNews(
  redis: Redis,
  challengeId: string,
  item: NewsItem,
): Promise<void> {
  const key = redisKeys.newsFeed(challengeId);
  const existing = await redis.get(key);
  const items: NewsItem[] = existing ? (JSON.parse(existing) as NewsItem[]) : [];
  items.unshift(item);
  if (items.length > NEWS_FEED_MAX) items.length = NEWS_FEED_MAX;
  await redis.set(key, JSON.stringify(items));
}

export async function getNewsFeed(
  redis: Redis,
  challengeId: string,
  limit = 20,
): Promise<NewsItem[]> {
  const v = await redis.get(redisKeys.newsFeed(challengeId));
  const items = v ? (JSON.parse(v) as NewsItem[]) : [];
  return items.slice(0, limit);
}

export async function setNewsFeed(
  redis: Redis,
  challengeId: string,
  items: NewsItem[],
): Promise<void> {
  await redis.set(
    redisKeys.newsFeed(challengeId),
    JSON.stringify(items.slice(0, NEWS_FEED_MAX)),
  );
}

export async function clearNewsFeed(
  redis: Redis,
  challengeId: string,
): Promise<void> {
  await redis.del(redisKeys.newsFeed(challengeId));
}

/* ---- Per-trader metrics ---- */
export async function setTraderMetrics(
  redis: Redis,
  challengeId: string,
  entries: Array<{ userId: string; metrics: TraderMetrics }>,
): Promise<void> {
  if (entries.length === 0) return;
  const flat: string[] = [];
  for (const e of entries) {
    flat.push(e.userId, JSON.stringify(e.metrics));
  }
  await redis.hset(redisKeys.metrics(challengeId), ...flat);
}

export async function getTraderMetricsMap(
  redis: Redis,
  challengeId: string,
): Promise<Map<string, TraderMetrics>> {
  const raw = await redis.hgetall(redisKeys.metrics(challengeId));
  const out = new Map<string, TraderMetrics>();
  for (const [userId, json] of Object.entries(raw)) {
    try {
      out.set(userId, JSON.parse(json) as TraderMetrics);
    } catch {
      // ignore malformed entries
    }
  }
  return out;
}

export async function getTraderMetrics(
  redis: Redis,
  challengeId: string,
  userId: string,
): Promise<TraderMetrics | null> {
  const v = await redis.hget(redisKeys.metrics(challengeId), userId);
  if (!v) return null;
  try {
    return JSON.parse(v) as TraderMetrics;
  } catch {
    return null;
  }
}

export async function clearTraderMetrics(
  redis: Redis,
  challengeId: string,
): Promise<void> {
  await redis.del(redisKeys.metrics(challengeId));
}

/* ---- Active challenge registry ---- */
export async function markChallengeActive(
  redis: Redis,
  challengeId: string,
): Promise<void> {
  await redis.sadd(redisKeys.activeChallenges, challengeId);
}

export async function markChallengeInactive(
  redis: Redis,
  challengeId: string,
): Promise<void> {
  await redis.srem(redisKeys.activeChallenges, challengeId);
}

export async function listActiveChallenges(redis: Redis): Promise<string[]> {
  return redis.smembers(redisKeys.activeChallenges);
}

/* ---- Rate limiting (fixed window) ---- */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

/**
 * Fixed-window rate limiter backed by Redis. Atomic via a tiny Lua script so it
 * is correct under concurrency and across horizontally-scaled API nodes.
 */
export async function checkRateLimit(
  redis: Redis,
  userId: string,
  bucket: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const key = redisKeys.rateLimit(userId, bucket);
  const script = `
    local current = redis.call('INCR', KEYS[1])
    if current == 1 then
      redis.call('PEXPIRE', KEYS[1], ARGV[1])
    end
    local ttl = redis.call('PTTL', KEYS[1])
    return {current, ttl}`;
  const [current, ttl] = (await redis.eval(
    script,
    1,
    key,
    String(windowMs),
  )) as [number, number];
  return {
    allowed: current <= limit,
    remaining: Math.max(0, limit - current),
    resetMs: ttl < 0 ? windowMs : ttl,
  };
}

export interface VolumeLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

/**
 * Fixed-window volume limiter: sums order quantities per user per challenge.
 */
export async function checkVolumeLimit(
  redis: Redis,
  userId: string,
  challengeId: string,
  quantity: number,
  limit: number,
  windowMs: number,
): Promise<VolumeLimitResult> {
  const key = redisKeys.volumeLimit(userId, challengeId);
  const script = `
    local current = redis.call('INCRBY', KEYS[1], ARGV[2])
    if tonumber(current) == tonumber(ARGV[2]) then
      redis.call('PEXPIRE', KEYS[1], ARGV[1])
    end
    local ttl = redis.call('PTTL', KEYS[1])
    return {current, ttl}`;
  const [current, ttl] = (await redis.eval(
    script,
    1,
    key,
    String(windowMs),
    String(quantity),
  )) as [number, number];
  return {
    allowed: current <= limit,
    remaining: Math.max(0, limit - current),
    resetMs: ttl < 0 ? windowMs : ttl,
  };
}

/* ---- Engine leader election ---- */
export async function acquireEngineLock(
  redis: Redis,
  challengeId: string,
  owner: string,
  ttlMs = 10000,
): Promise<boolean> {
  const res = await redis.set(
    redisKeys.engineLock(challengeId),
    owner,
    "PX",
    ttlMs,
    "NX",
  );
  return res === "OK";
}

export async function refreshEngineLock(
  redis: Redis,
  challengeId: string,
  owner: string,
  ttlMs = 10000,
): Promise<boolean> {
  // Refresh only if we still own it (atomic check-and-set).
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('PEXPIRE', KEYS[1], ARGV[2])
    else
      return 0
    end`;
  const res = (await redis.eval(
    script,
    1,
    redisKeys.engineLock(challengeId),
    owner,
    String(ttlMs),
  )) as number;
  return res === 1;
}
