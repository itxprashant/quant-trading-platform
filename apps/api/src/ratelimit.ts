import { checkRateLimit } from "@qtp/bus";
import type { FastifyReply, FastifyRequest } from "fastify";

interface RateLimitOptions {
  /** Bucket name, used in the Redis key. */
  bucket: string;
  /** Max requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Identity source: authenticated user id, else client IP. */
  by?: "user" | "ip";
}

/**
 * Build a Fastify preHandler enforcing a Redis-backed fixed-window rate limit.
 * Scales horizontally because the counter lives in Redis, shared across nodes.
 */
export function rateLimit(opts: RateLimitOptions) {
  const by = opts.by ?? "user";
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const identity =
      by === "user" && req.user?.sub
        ? req.user.sub
        : (req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ??
          req.ip);

    const res = await checkRateLimit(
      req.server.redis,
      identity,
      opts.bucket,
      opts.limit,
      opts.windowMs,
    );

    reply.header("x-ratelimit-limit", String(opts.limit));
    reply.header("x-ratelimit-remaining", String(res.remaining));

    if (!res.allowed) {
      reply.header("retry-after", String(Math.ceil(res.resetMs / 1000)));
      return reply.code(429).send({
        error: "rate_limited",
        retryAfterMs: res.resetMs,
      });
    }
  };
}
