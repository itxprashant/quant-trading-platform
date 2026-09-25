import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { challenges, loans, participants } from "@qtp/db";
import {
  edenEventFlow,
  edenLoansClosed,
  zRequestLoanInput,
  type EngineCommand,
  type Loan,
} from "@qtp/shared";
import { publishCommand } from "@qtp/bus";
import { rateLimit } from "../ratelimit.js";
import { validate } from "../util.js";

const MAX_PRINCIPAL = 1_000_000;

/** Eden loans: traders borrow from the bank; admins can lend on their behalf. */
export async function loanRoutes(app: FastifyInstance): Promise<void> {
  async function disburse(
    challengeId: string,
    userId: string,
    principal: number,
  ): Promise<Loan> {
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, challengeId),
    });
    if (!challenge) throw new HttpError(404, "challenge_not_found");
    if (challenge.type !== "new_eden") throw new HttpError(409, "not_eden");
    if (challenge.status !== "live")
      throw new HttpError(409, "challenge_not_live");
    const now = Date.now();
    if (!challenge.endsAt || challenge.endsAt.getTime() <= now) {
      throw new HttpError(409, "invalid_loan_deadline");
    }
    if (
      edenLoansClosed(
        now,
        challenge.endsAt,
        challenge.startsAt,
        edenEventFlow(challenge.config?.eden) !== "host",
      )
    ) {
      throw new HttpError(409, "loan_window_closed");
    }
    if (
      !Number.isFinite(principal) ||
      principal <= 0 ||
      principal > MAX_PRINCIPAL
    ) {
      throw new HttpError(400, "invalid_principal");
    }
    const participant = await app.db.query.participants.findFirst({
      where: and(
        eq(participants.challengeId, challengeId),
        eq(participants.userId, userId),
      ),
    });
    if (!participant) throw new HttpError(403, "not_enrolled");
    const totalRepay = principal * 2;
    const installment =
      totalRepay / Math.ceil((challenge.endsAt.getTime() - now) / 60_000);

    const loanId = randomUUID();
    const [row] = await app.db
      .insert(loans)
      .values({
        id: loanId,
        challengeId,
        userId,
        principal,
        totalRepay,
        remaining: totalRepay,
        installment,
        nextPaymentAt: new Date(
          Math.min(now + 60_000, challenge.endsAt.getTime()),
        ),
        fundedAt: null,
        status: "active",
      })
      .returning();

    const cmd: EngineCommand = {
      type: "issue_loan",
      challengeId,
      userId,
      loanId,
      principal,
      ts: Date.now(),
    };
    await publishCommand(app.redis, challengeId, cmd);

    return {
      id: row!.id,
      challengeId,
      userId,
      principal,
      totalRepay,
      remaining: totalRepay,
      status: "active",
      installment: row!.installment,
      nextPaymentAt: row!.nextPaymentAt?.toISOString() ?? null,
      fundedAt: row!.fundedAt?.toISOString() ?? null,
      createdAt: row!.createdAt.toISOString(),
    };
  }

  // Trader requests a loan for themselves.
  app.post(
    "/request",
    {
      preHandler: [
        app.authenticate,
        rateLimit({ bucket: "loans", limit: 5, windowMs: 60_000, by: "user" }),
      ],
    },
    async (req, reply) => {
      const input = validate(zRequestLoanInput, req.body, reply);
      if (!input) return;
      if (input.principal > MAX_PRINCIPAL) {
        return reply.code(400).send({ error: "principal_too_large" });
      }
      try {
        const loan = await disburse(
          input.challengeId,
          req.user.sub,
          input.principal,
        );
        return reply.code(202).send({ loan });
      } catch (err) {
        if (err instanceof HttpError)
          return reply.code(err.code).send({ error: err.msg });
        throw err;
      }
    },
  );

  // Admin issues a loan on behalf of a trader (e.g. halftime rescue / trap).
  app.post(
    "/:challengeId/issue",
    { preHandler: [app.requireAdmin] },
    async (req, reply) => {
      const { challengeId } = req.params as { challengeId: string };
      const body = validate(
        z.object({
          userId: z.string().uuid(),
          principal: z.number().positive().max(MAX_PRINCIPAL),
        }),
        req.body,
        reply,
      );
      if (!body) return;
      try {
        const loan = await disburse(challengeId, body.userId, body.principal);
        return reply.code(202).send({ loan });
      } catch (err) {
        if (err instanceof HttpError)
          return reply.code(err.code).send({ error: err.msg });
        throw err;
      }
    },
  );

  // List the caller's loans for a challenge.
  app.get("/:challengeId", { preHandler: [app.authenticate] }, async (req) => {
    const { challengeId } = req.params as { challengeId: string };
    const rows = await app.db
      .select()
      .from(loans)
      .where(
        and(eq(loans.challengeId, challengeId), eq(loans.userId, req.user.sub)),
      )
      .orderBy(desc(loans.createdAt))
      .limit(50);
    return rows.map((l) => ({
      id: l.id,
      challengeId: l.challengeId,
      userId: l.userId,
      principal: l.principal,
      totalRepay: l.totalRepay,
      remaining: l.remaining,
      status: l.status,
      installment: l.installment,
      nextPaymentAt: l.nextPaymentAt?.toISOString() ?? null,
      fundedAt: l.fundedAt?.toISOString() ?? null,
      createdAt: l.createdAt.toISOString(),
    }));
  });
}

class HttpError extends Error {
  constructor(
    readonly code: number,
    readonly msg: string,
  ) {
    super(msg);
  }
}
