/**
 * Centralized Redis key / stream / channel naming so every service agrees.
 *
 * Design:
 *  - Each challenge has its own command stream (API -> engine) and event
 *    stream (engine -> consumers), keeping events isolated per event.
 *  - A single pub/sub channel per challenge fans out to gateway nodes.
 */
export const redisKeys = {
  /** Command stream consumed by the matching engine for a challenge. */
  commandStream: (challengeId: string) => `qtp:cmd:${challengeId}`,
  /** Event stream produced by the engine (durable replay/scoring). */
  eventStream: (challengeId: string) => `qtp:evt:${challengeId}`,
  /** Pub/sub channel the gateway subscribes to for real-time fan-out. */
  broadcastChannel: (challengeId: string) => `qtp:bc:${challengeId}`,
  /** Hot current price per symbol. */
  price: (challengeId: string, symbol: string) =>
    `qtp:price:${challengeId}:${symbol}`,
  /** Sorted set of recent price points (score = ts). */
  priceHistory: (challengeId: string, symbol: string) =>
    `qtp:phist:${challengeId}:${symbol}`,
  /** Latest order book snapshot JSON per symbol. */
  bookSnapshot: (challengeId: string, symbol: string) =>
    `qtp:book:${challengeId}:${symbol}`,
  /** Leader-election lock so exactly one engine owns a challenge. */
  engineLock: (challengeId: string) => `qtp:lock:engine:${challengeId}`,
  /** Set of challenge ids the engine pool should be running. */
  activeChallenges: "qtp:active-challenges",
  /** Latest leaderboard JSON per challenge. */
  leaderboard: (challengeId: string) => `qtp:lb:${challengeId}`,
  /** Recent news items JSON array per challenge. */
  newsFeed: (challengeId: string) => `qtp:news:${challengeId}`,
  /** Hash of per-trader metrics (field = userId, value = JSON) per challenge. */
  metrics: (challengeId: string) => `qtp:metrics:${challengeId}`,
  /** Token-bucket rate limit key per user. */
  rateLimit: (userId: string, bucket: string) =>
    `qtp:rl:${bucket}:${userId}`,
} as const;

export const PRICE_HISTORY_MAX = 1000;
export const NEWS_FEED_MAX = 50;
