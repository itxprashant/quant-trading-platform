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
  /** Sorted set of recent mid-price points (score = ts). */
  priceHistoryMid: (challengeId: string, symbol: string) =>
    `qtp:phist-mid:${challengeId}:${symbol}`,
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
  /** Rolling order-quantity sum per user per challenge. */
  volumeLimit: (userId: string, challengeId: string) =>
    `qtp:rl:${userId}:vol:${challengeId}`,

  /* ---- New Eden ---- */
  /** Hot fair value per symbol. */
  fairValue: (challengeId: string, symbol: string) =>
    `qtp:fv:${challengeId}:${symbol}`,
  /** Set of all symbols that currently have a fair value (for scans). */
  fairValueSet: (challengeId: string) => `qtp:fvset:${challengeId}`,
  /** Premium news access flag per user (TTL-bounded). */
  premiumAccess: (challengeId: string, userId: string) =>
    `qtp:premium:${challengeId}:${userId}`,
  /** Set of symbols disabled for trading (dynamic asset lock). */
  lockedSymbols: (challengeId: string) => `qtp:locked:${challengeId}`,
  /** Latest fair-value snapshot JSON (all symbols) for quick reads. */
  fairValueSnapshot: (challengeId: string) => `qtp:fvsnap:${challengeId}`,
  /** Set of dynamically-listed tradeable symbols (options, ETFs). */
  listedSymbols: (challengeId: string) => `qtp:listed:${challengeId}`,
  /** Open ETF create/redeem windows (set of ETF symbols). */
  etfWindows: (challengeId: string) => `qtp:etfwin:${challengeId}`,
  /** Latest option contracts JSON for a challenge (host + trader UI). */
  optionContracts: (challengeId: string) => `qtp:opts:${challengeId}`,
} as const;

export const PRICE_HISTORY_MAX = 1000;
export const NEWS_FEED_MAX = 50;
