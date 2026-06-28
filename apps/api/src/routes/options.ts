import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { challenges } from "@qtp/db";
import { getOptionContracts, getPrice, publishCommand } from "@qtp/bus";
import { intrinsicValue, type OptionType } from "@qtp/core";
import { zExerciseOptionInput, type EngineCommand } from "@qtp/shared";
import { validate } from "../util.js";
import { rateLimit } from "../ratelimit.js";

/**
 * Trader-facing options market: list the live contracts (with marks and
 * intrinsic value) and exercise in-the-money series during the window.
 */
export async function optionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/:challengeId", async (req) => {
    const { challengeId } = req.params as { challengeId: string };
    const contracts = await getOptionContracts(app.redis, challengeId);
    const enriched = [];
    for (const c of contracts) {
      const price = await getPrice(app.redis, challengeId, c.symbol);
      const underlyingPrice = await getPrice(app.redis, challengeId, c.underlying);
      enriched.push({
        ...c,
        price: price ?? null,
        underlyingPrice: underlyingPrice ?? null,
        intrinsic:
          underlyingPrice != null
            ? intrinsicValue(c.optionType as OptionType, underlyingPrice, c.strike)
            : null,
      });
    }
    return { contracts: enriched };
  });

  app.post(
    "/exercise",
    {
      preHandler: [
        app.authenticate,
        rateLimit({ bucket: "exercise", limit: 10, windowMs: 10_000, by: "user" }),
      ],
    },
    async (req, reply) => {
      const input = validate(zExerciseOptionInput, req.body, reply);
      if (!input) return;
      const challenge = await app.db.query.challenges.findFirst({
        where: eq(challenges.id, input.challengeId),
      });
      if (!challenge) return reply.code(404).send({ error: "challenge_not_found" });
      if (challenge.status !== "live") {
        return reply.code(409).send({ error: "challenge_not_live" });
      }
      const cmd: EngineCommand = {
        type: "exercise_option",
        challengeId: input.challengeId,
        userId: req.user.sub,
        symbol: input.symbol,
        quantity: input.quantity,
        ts: Date.now(),
      };
      await publishCommand(app.redis, input.challengeId, cmd);
      return reply.code(202).send({ status: "accepted" });
    },
  );
}
