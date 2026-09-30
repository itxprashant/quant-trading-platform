import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { challenges } from "@qtp/db";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GUARDED_PREFIXES = [
  "/api/challenges",
  "/api/orders",
  "/api/market",
  "/api/portfolio",
  "/api/leaderboard",
  "/api/loans",
  "/api/options",
  "/api/markets",
  "/api/otc",
  "/api/auctions",
  "/api/votes",
];

/** Hide a challenge from every trader route once the caller is known. */
export function registerTraderVisibilityGuard(app: FastifyInstance): void {
  app.addHook("preHandler", async (req, reply) => {
    const url = req.url.split("?")[0] ?? "";
    if (!GUARDED_PREFIXES.some((prefix) => url === prefix || url.startsWith(`${prefix}/`)))
      return;
    const refs = challengeRefs(req);
    if (refs.length === 0) return;
    if ((await callerRole(req)) === "admin") return;
    for (const ref of refs) {
      const row = await app.db.query.challenges.findFirst({
        where: UUID.test(ref)
          ? eq(challenges.id, ref)
          : eq(challenges.slug, ref),
        columns: { hiddenFromTraders: true },
      });
      if (row?.hiddenFromTraders) {
        return reply.code(404).send({ error: "not_found" });
      }
    }
  });
}

async function callerRole(req: FastifyRequest): Promise<string | undefined> {
  try {
    await req.jwtVerify();
    return req.user.role;
  } catch {
    return undefined;
  }
}

function challengeRefs(req: FastifyRequest): string[] {
  const refs: string[] = [];
  const params = req.params as Record<string, unknown> | undefined;
  for (const key of ["challengeId", "id", "idOrSlug"]) {
    const value = params?.[key];
    if (typeof value === "string" && value.length > 0) refs.push(value);
  }
  const body = req.body;
  if (body && typeof body === "object" && "challengeId" in body) {
    const value = (body as { challengeId?: unknown }).challengeId;
    if (typeof value === "string" && value.length > 0) refs.push(value);
  }
  const query = req.query as Record<string, unknown> | undefined;
  if (typeof query?.challengeId === "string" && query.challengeId.length > 0)
    refs.push(query.challengeId);
  return [...new Set(refs)];
}
