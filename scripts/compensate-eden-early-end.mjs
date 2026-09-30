/**
 * Post-event fixes for New Eden when the session finalized before endsAt:
 * 1. Bond holders: lump-sum credit for unpaid coupons (faceValue − couponsPaid).
 * 2. Loans (optional): first-half 2× vs configured multiplier (see compensate-eden-loan-overcharge.mjs).
 *
 * For ended challenges, credits Postgres directly and can recompute finalResults.
 *
 * Usage:
 *   DATABASE_URL=... REDIS_URL=... node scripts/compensate-eden-early-end.mjs
 * Dry run:
 *   DRY_RUN=1 node scripts/compensate-eden-early-end.mjs
 * Skip loan multiplier pass:
 *   SKIP_LOANS=1 node scripts/compensate-eden-early-end.mjs
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EDEN_EVENT_DURATION_MINUTES = 210;

const SLUG = process.env.CHALLENGE_SLUG ?? "new-eden-exchange";
const GAME_HALF_MINUTES = Number(process.env.GAME_HALF_MINUTES ?? 90);
const DRY_RUN = process.env.DRY_RUN === "1";
const SKIP_LOANS = process.env.SKIP_LOANS === "1";
const RECOMPUTE_FINAL = process.env.RECOMPUTE_FINAL !== "0";
const FORCE = process.env.FORCE === "1";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://qtp:qtp@localhost:5432/qtp";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

function roundMoney(n) {
  return Math.round(n * 100) / 100;
}

function installmentsPaidBefore({
  cutoffMs,
  fundedAtMs,
  minuteMs,
  installment,
  totalRepay,
  throughMs,
}) {
  const firstDue = fundedAtMs + minuteMs;
  if (firstDue >= cutoffMs) return 0;
  const through = Math.min(cutoffMs, throughMs);
  if (through < firstDue) return 0;
  const count = Math.floor((through - firstDue) / minuteMs) + 1;
  if (count <= 0) return 0;
  return Math.min(totalRepay, count * installment);
}

function query(sql) {
  const out = execFileSync(
    "psql",
    [DATABASE_URL, "-t", "-A", "-F", "\t", "-c", sql],
    { encoding: "utf8" },
  );
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function computeCredits(meta, bondRows, loanRows) {
  const challengeId = meta[0];
  const startsMs = Number(meta[1]);
  const endsMs = Number(meta[2]);
  const finalizedMs = Number(meta[3]);
  const configuredMs = Number(meta[4]);
  const minuteMs = (endsMs - startsMs) / EDEN_EVENT_DURATION_MINUTES;
  const cutoffMs = startsMs + GAME_HALF_MINUTES * minuteMs;

  const byUser = new Map();

  for (const row of bondRows) {
    const [, userId, username, faceValue, couponsPaid] = row;
    const remaining = roundMoney(Number(faceValue) - Number(couponsPaid));
    if (!(remaining > 0)) continue;
    const prev = byUser.get(userId) ?? {
      userId,
      username,
      bond: 0,
      loan: 0,
    };
    prev.bond = roundMoney(prev.bond + remaining);
    byUser.set(userId, prev);
  }

  if (!SKIP_LOANS) {
    for (const row of loanRows) {
      const [
        ,
        userId,
        username,
        principal,
        totalRepay,
        installment,
        fundedAtMs,
      ] = row.map((v, i) => (i >= 3 ? Number(v) : v));
      if (!(principal > 0) || !(totalRepay > 0) || !(installment > 0)) continue;
      const actualMw = totalRepay / principal;
      if (!(actualMw > configuredMs + 1e-6)) continue;
      const paidInHalf = installmentsPaidBefore({
        cutoffMs,
        fundedAtMs,
        minuteMs,
        installment,
        totalRepay,
        throughMs: finalizedMs,
      });
      if (paidInHalf <= 0) continue;
      const extra = roundMoney(paidInHalf * (1 - configuredMs / actualMw));
      if (extra <= 0) continue;
      const prev = byUser.get(userId) ?? {
        userId,
        username,
        bond: 0,
        loan: 0,
      };
      prev.loan = roundMoney(prev.loan + extra);
      if (!prev.username) prev.username = username;
      byUser.set(userId, prev);
    }
  }

  const users = [...byUser.values()]
    .map((u) => ({
      ...u,
      extra: roundMoney(u.bond + u.loan),
    }))
    .filter((u) => u.extra > 0)
    .sort((a, b) => b.extra - a.extra);

  return {
    challengeId,
    startsMs,
    endsMs,
    finalizedMs,
    configuredMs,
    minuteMs,
    secEarly: roundMoney((endsMs - finalizedMs) / 1000),
    gameMinutesEarly: roundMoney((endsMs - finalizedMs) / minuteMs),
    users,
    totalBond: roundMoney(users.reduce((s, u) => s + u.bond, 0)),
    totalLoan: roundMoney(users.reduce((s, u) => s + u.loan, 0)),
    totalCredit: roundMoney(users.reduce((s, u) => s + u.extra, 0)),
  };
}

async function applyCredits(report) {
  const { challengeId, users } = report;
  for (const row of users) {
    if (row.bond > 0) {
      execFileSync(
        "psql",
        [
          DATABASE_URL,
          "-c",
          `UPDATE bond_holdings SET coupons_paid = face_value
           WHERE challenge_id = '${challengeId}' AND user_id = '${row.userId}'
             AND quantity > 0 AND face_value > coupons_paid;`,
        ],
        { stdio: "inherit" },
      );
    }
    execFileSync(
      "psql",
      [
        DATABASE_URL,
        "-c",
        `UPDATE challenge_participants SET cash = cash + ${row.extra}
         WHERE challenge_id = '${challengeId}' AND user_id = '${row.userId}';`,
      ],
      { stdio: "inherit" },
    );
    console.log(
      `credited ${row.username}: +$${row.extra} (bond $${row.bond}, loan $${row.loan})`,
    );
  }

  if (!RECOMPUTE_FINAL) return;

  execFileSync(
    "pnpm",
    ["exec", "tsx", "scripts/recompute-final.mjs", challengeId],
    {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL, REDIS_URL },
      cwd: fileURLToPath(new URL("../apps/engine", import.meta.url)),
    },
  );
}

async function main() {
  const [meta] = query(`
    SELECT c.id,
           EXTRACT(EPOCH FROM c.starts_at) * 1000,
           EXTRACT(EPOCH FROM c.ends_at) * 1000,
           EXTRACT(EPOCH FROM c.finalized_at) * 1000,
           COALESCE((c.config->'eden'->'rules'->>'loanRepayMultiplier')::float, 2),
           c.config->'edenPostCompensation'
    FROM challenges c WHERE c.slug = '${SLUG}' LIMIT 1;
  `);
  if (!meta?.[0]) throw new Error(`Challenge ${SLUG} not found`);
  const challengeId = meta[0];
  const priorComp = meta[5] && meta[5] !== "null" ? JSON.parse(meta[5]) : null;
  if (priorComp && !FORCE) {
    console.log(
      JSON.stringify(
        {
          challenge: SLUG,
          skipped: true,
          reason: "edenPostCompensation already recorded (set FORCE=1 to rerun)",
          priorComp,
        },
        null,
        2,
      ),
    );
    return;
  }

  const bondRows = query(`
    SELECT bh.id, bh.user_id, u.username, bh.face_value, bh.coupons_paid
    FROM bond_holdings bh
    JOIN users u ON u.id = bh.user_id
    WHERE bh.challenge_id = '${challengeId}' AND bh.quantity > 0
      AND bh.face_value > bh.coupons_paid + 1e-9;
  `);

  const loanRows = query(`
    SELECT l.id, l.user_id, u.username, l.principal, l.total_repay, l.installment,
           EXTRACT(EPOCH FROM l.funded_at) * 1000
    FROM loans l
    JOIN users u ON u.id = l.user_id
    WHERE l.challenge_id = '${challengeId}' AND l.funded_at IS NOT NULL
    ORDER BY l.funded_at;
  `);

  const report = computeCredits(meta, bondRows, loanRows);
  console.log(
    JSON.stringify(
      {
        challenge: SLUG,
        dryRun: DRY_RUN,
        skipLoans: SKIP_LOANS,
        recomputeFinal: RECOMPUTE_FINAL,
        scheduledEnd: new Date(report.endsMs).toISOString(),
        finalizedAt: new Date(report.finalizedMs).toISOString(),
        endedEarlySec: report.secEarly,
        endedEarlyGameMinutes: report.gameMinutesEarly,
        configuredLoanMultiplier: report.configuredMs,
        totalBondCredit: report.totalBond,
        totalLoanCredit: report.totalLoan,
        totalCredit: report.totalCredit,
        users: report.users,
      },
      null,
      2,
    ),
  );

  if (DRY_RUN) return;
  await applyCredits(report);
  execFileSync(
    "psql",
    [
      DATABASE_URL,
      "-c",
      `UPDATE challenges SET config = jsonb_set(
         config,
         '{edenPostCompensation}',
         '${JSON.stringify({
           bondEarlyEnd: {
             appliedAt: new Date().toISOString(),
             totalCredit: report.totalBond,
           },
           loanMultiplierFirstHalf: {
             appliedAt: new Date().toISOString(),
             totalCredit: report.totalLoan,
           },
         })}'::jsonb,
         true
       ) WHERE id = '${challengeId}';`,
    ],
    { stdio: "inherit" },
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
