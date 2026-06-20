import type { FastifyInstance } from "fastify";

/**
 * Minimal, dependency-free Prometheus metrics. Route labels use Fastify's route
 * pattern (e.g. /api/challenges/:idOrSlug) to keep cardinality bounded.
 */
const requestCounts = new Map<string, number>();
let durationSum = 0;
let durationCount = 0;

export function registerMetrics(app: FastifyInstance): void {
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? "unknown";
    const key = `method="${req.method}",route="${route}",status="${reply.statusCode}"`;
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
    const ms = reply.elapsedTime ?? 0;
    durationSum += ms / 1000;
    durationCount += 1;
  });

  app.get("/api/metrics", async (_req, reply) => {
    const mem = process.memoryUsage();
    const lines: string[] = [
      "# HELP qtp_http_requests_total Total HTTP requests handled.",
      "# TYPE qtp_http_requests_total counter",
    ];
    for (const [labels, count] of requestCounts) {
      lines.push(`qtp_http_requests_total{${labels}} ${count}`);
    }
    lines.push(
      "# HELP qtp_http_request_duration_seconds Request duration summary.",
      "# TYPE qtp_http_request_duration_seconds summary",
      `qtp_http_request_duration_seconds_sum ${durationSum}`,
      `qtp_http_request_duration_seconds_count ${durationCount}`,
      "# HELP process_resident_memory_bytes Resident memory size in bytes.",
      "# TYPE process_resident_memory_bytes gauge",
      `process_resident_memory_bytes ${mem.rss}`,
      "# HELP nodejs_heap_used_bytes Node.js heap used in bytes.",
      "# TYPE nodejs_heap_used_bytes gauge",
      `nodejs_heap_used_bytes ${mem.heapUsed}`,
      "# HELP process_uptime_seconds Process uptime in seconds.",
      "# TYPE process_uptime_seconds gauge",
      `process_uptime_seconds ${process.uptime()}`,
    );
    reply.header("content-type", "text/plain; version=0.0.4");
    return lines.join("\n") + "\n";
  });
}
