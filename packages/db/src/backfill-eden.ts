import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { getDb } from "./client.js";
import {
  challengeNews,
  challenges,
  engineCheckpoints,
  loans,
  participants,
} from "./schema.js";

async function main() {
  const args = process.argv.slice(2);
  const cutoffArgs = args.filter((arg) => arg.startsWith("--legacy-cutoff="));
  if (
    args.some(
      (arg) => arg !== "--apply" && !arg.startsWith("--legacy-cutoff="),
    ) ||
    cutoffArgs.length > 1 ||
    args.filter((arg) => arg === "--apply").length > 1
  ) {
    throw new Error(
      "Usage: db:backfill-eden [--apply] [--legacy-cutoff=<UTC ISO>]",
    );
  }
  let cutoff: Date | undefined;
  if (cutoffArgs.length > 0) {
    const value = cutoffArgs[0]!.slice("--legacy-cutoff=".length);
    cutoff = new Date(value);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) ||
      !Number.isFinite(cutoff.getTime()) ||
      cutoff.getTime() > Date.now() ||
      cutoff.toISOString() !==
        (value.includes(".") ? value : value.replace("Z", ".000Z"))
    ) {
      throw new Error(
        "Legacy cutoff must be a valid, non-future UTC ISO timestamp",
      );
    }
  }
  // Require an explicit target rather than silently falling back to a local DB.
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const minuteMs = Number(process.env.ENGINE_MINUTE_MS ?? 60_000);
  if (!Number.isSafeInteger(minuteMs) || minuteMs <= 0) {
    throw new Error("ENGINE_MINUTE_MS must be a positive integer");
  }
  const apply = args.includes("--apply");
  const db = getDb();
  console.log(`Legacy Eden backfill: ${apply ? "APPLY" : "DRY RUN"}`);
  if (cutoff)
    console.log(
      `Legacy completion cutoff: ${cutoff.toISOString()} (preserve, not replay).`,
    );
  const counts = await db.transaction(
    async (tx) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      // Stop API/engine writers before running: locks cannot refresh their in-memory state.
      // Table locks also prevent new loans/participants from appearing during an apply.
      if (apply) {
        await tx.execute(
          sql`lock table challenges, challenge_participants, loans, challenge_news, engine_checkpoints in share row exclusive mode`,
        );
      }
      const now = Date.now();
      const newsFilter = and(
        isNotNull(challengeNews.publishedAt),
        isNull(challengeNews.effectsAppliedAt),
        cutoff ? lt(challengeNews.publishedAt, cutoff) : undefined,
        cutoff
          ? or(
              isNull(challengeNews.embargoUntil),
              lte(challengeNews.embargoUntil, cutoff),
            )
          : undefined,
      );
      const publishedNews = await tx
        .select({ id: challengeNews.id })
        .from(challengeNews)
        .where(newsFilter);
      const endedFilter = and(
        eq(challenges.status, "ended"),
        isNull(challenges.finalizedAt),
        cutoff ? lt(challenges.createdAt, cutoff) : undefined,
      );
      const ended = await tx
        .select({ id: challenges.id })
        .from(challenges)
        .where(endedFilter);
      const checkpoints =
        ended.length === 0
          ? []
          : await tx
              .select({ challengeId: engineCheckpoints.challengeId })
              .from(engineCheckpoints)
              .where(
                inArray(
                  engineCheckpoints.challengeId,
                  ended.map((row) => row.id),
                ),
              );
      const checkpointed = new Set(checkpoints.map((row) => row.challengeId));
      const legacyEnded = ended.filter((row) => !checkpointed.has(row.id));
      const legacy = and(
        eq(loans.installment, 0),
        isNull(loans.nextPaymentAt),
        isNull(loans.fundedAt),
      );
      const rows = await tx
        .select()
        .from(loans)
        .where(legacy)
        .orderBy(asc(loans.createdAt), asc(loans.id));
      const counts = {
        candidates: rows.length,
        participants: 0,
        active: 0,
        repaid: 0,
        blocked: 0,
        publishedNewsCandidates: publishedNews.length,
        endedChallengeCandidates: ended.length,
        checkpointedChallengesSkipped: checkpointed.size,
        newsCompletions: cutoff ? publishedNews.length : 0,
        challengeCompletions: cutoff ? legacyEnded.length : 0,
      };
      const issues = {
        missingParticipant: 0,
        missingEnd: 0,
        mixedActiveLoans: 0,
        invalidDebtOrRepay: 0,
        allocationMismatch: 0,
      };
      const plans: Array<{
        id: string;
        remaining: number;
        installment: number;
        nextPaymentAt: Date | null;
        status: "active" | "repaid";
      }> = [];
      const groups = new Map<string, typeof rows>();
      for (const loan of rows) {
        const key = `${loan.challengeId}/${loan.userId}`;
        const group = groups.get(key) ?? [];
        group.push(loan);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        const first = group[0]!;
        const [challenge] = await tx
          .select()
          .from(challenges)
          .where(eq(challenges.id, first.challengeId));
        const [participant] = await tx
          .select()
          .from(participants)
          .where(
            and(
              eq(participants.challengeId, first.challengeId),
              eq(participants.userId, first.userId),
            ),
          );
        if (!challenge || !participant) {
          issues.missingParticipant++;
          continue;
        }
        const active = group.filter((loan) => loan.status === "active");
        const end = challenge.endsAt?.getTime();
        if (
          (challenge.status === "live" || active.length > 0) &&
          (end == null || !Number.isFinite(end))
        ) {
          issues.missingEnd++;
          continue;
        }
        const allActive = await tx
          .select({ id: loans.id })
          .from(loans)
          .where(
            and(
              eq(loans.challengeId, first.challengeId),
              eq(loans.userId, first.userId),
              eq(loans.status, "active"),
            ),
          );
        // Never guess which part of aggregate debt belongs to newer funded/pending loans.
        if (active.length > 0 && allActive.length !== active.length) {
          issues.mixedActiveLoans++;
          continue;
        }
        const debt = participant.loanDebt;
        if (
          !Number.isFinite(debt) ||
          debt < 0 ||
          active.some(
            (loan) => !Number.isFinite(loan.totalRepay) || loan.totalRepay < 0,
          )
        ) {
          issues.invalidDebtOrRepay++;
          continue;
        }
        if (allActive.length === 0 && debt !== 0) {
          issues.allocationMismatch++;
          continue;
        }
        const periods =
          end == null ? 1 : Math.max(1, Math.ceil((end - now) / minuteMs));
        let allocated = 0;
        const groupPlans: typeof plans = [];
        for (const loan of group) {
          // Stable FIFO uses totalRepay only as a ceiling; legacy remaining may be stale.
          const remaining =
            loan.status === "active"
              ? Math.min(loan.totalRepay, Math.max(0, debt - allocated))
              : 0;
          allocated += remaining;
          groupPlans.push({
            id: loan.id,
            remaining,
            installment: remaining / periods,
            // Count backwards from the real deadline, never invent a new loan horizon.
            nextPaymentAt:
              remaining > 0 ? new Date(end! - (periods - 1) * minuteMs) : null,
            status: remaining > 0 ? "active" : "repaid",
          });
        }
        if (
          (active.length > 0 && allocated !== debt) ||
          groupPlans.some(
            (plan) =>
              !Number.isFinite(plan.installment) ||
              (plan.remaining > 0 &&
                (plan.installment <= 0 ||
                  !Number.isFinite(plan.nextPaymentAt?.getTime()))),
          )
        ) {
          issues.allocationMismatch++;
          continue;
        }
        counts.participants++;
        plans.push(...groupPlans);
      }
      counts.active = plans.filter((plan) => plan.status === "active").length;
      counts.repaid = plans.length - counts.active;
      counts.blocked = Object.values(issues).reduce(
        (sum, count) => sum + count,
        0,
      );
      console.log(JSON.stringify({ ...counts, issues }));
      if (!cutoff && (publishedNews.length > 0 || legacyEnded.length > 0)) {
        console.log(
          "Completion candidates are not proven legacy. Audit the deployment cutoff; --apply --legacy-cutoff=<UTC ISO> acknowledges preserving old effects/results without replay.",
        );
        if (apply) throw new Error("Legacy completion cutoff required");
      }
      if (counts.blocked > 0) {
        console.error(
          "Resolve blocked records before retrying. Set missing challenge endsAt explicitly; reconcile mixed or invalid ledgers manually. No changes committed.",
        );
        throw new Error("Unsafe legacy loan data");
      }
      if (apply) {
        for (const { id, ...values } of plans) {
          const changed = await tx
            .update(loans)
            .set({ ...values, fundedAt: loans.createdAt })
            .where(and(eq(loans.id, id), legacy))
            .returning({ id: loans.id });
          if (changed.length !== 1)
            throw new Error("Legacy loan changed during backfill");
        }
        if (cutoff) {
          for (const { id } of publishedNews) {
            const changed = await tx
              .update(challengeNews)
              .set({
                // PostgreSQL GREATEST ignores a null embargo and preserves timestamp precision.
                effectsAppliedAt: sql`greatest(${challengeNews.publishedAt}, ${challengeNews.embargoUntil})`,
              })
              .where(and(eq(challengeNews.id, id), newsFilter))
              .returning({ id: challengeNews.id });
            if (changed.length !== 1)
              throw new Error("Legacy news changed during backfill");
          }
          for (const { id } of legacyEnded) {
            // The checkpoint table lock keeps the no-checkpoint check valid until commit.
            const changed = await tx
              .update(challenges)
              .set({ finalizedAt: cutoff })
              .where(and(eq(challenges.id, id), endedFilter))
              .returning({ id: challenges.id });
            if (changed.length !== 1)
              throw new Error("Legacy challenge changed during backfill");
          }
        }
      }
      return counts;
    },
    {
      isolationLevel: apply ? "read committed" : "repeatable read",
      accessMode: apply ? "read write" : "read only",
    },
  );
  console.log(
    `${apply ? "Updated" : "Would update"} ${counts.active + counts.repaid} loans, ${counts.newsCompletions} news markers, ${counts.challengeCompletions} challenge markers; cash/debt, fair values and final results unchanged.`,
  );
  if (!apply)
    console.log("Dry run only. Stop writers and rerun with --apply to commit.");
}

main()
  .then(() => process.exit(0))
  .catch(() => {
    // Database errors can include connection details or row contents; do not log them.
    console.error(
      "Backfill aborted. No changes committed. Check arguments (including a valid non-future UTC --legacy-cutoff), DATABASE_URL, ENGINE_MINUTE_MS, schema push, lock availability, and reported counts.",
    );
    process.exit(1);
  });
