import { Redis, type RedisOptions } from "ioredis";

export function createRedis(url?: string, opts: RedisOptions = {}): Redis {
  const connectionString =
    url ?? process.env.REDIS_URL ?? "redis://localhost:6379";
  return new Redis(connectionString, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...opts,
  });
}

export type { Redis };
