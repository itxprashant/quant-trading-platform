/**
 * One-shot: credit traders for loan installment overcharges when loans used 2×
 * but challenge config had a lower loanRepayMultiplier (e.g. 1.5×).
 *
 * Extra cash taken ≈ (installments paid in first 90 game minutes) × (1 − Ms/Mw).
 *
 * Usage (local):
 *   API_URL=http://localhost:8000 node scripts/compensate-eden-loan-overcharge.mjs
 *
 * Dry run:
 *   DRY_RUN=1 node scripts/compensate-eden-loan-overcharge.mjs
 */
import { execFileSync } from "node:child_process";
import {
  createRedis,
  publishCommand,
} from "../packages/bus/dist/index.js";

const EDEN_EVENT_DURATION_MINUTES = 210;

const SLUG = process.env.CHALLENGE_SLUG ?? "new-eden-exchange";
const GAME_HALF_MINUTES = Number(process.env.GAME_HALF_MINUTES ?? 90);
const DRY_RUN = process.env.DRY_RUN === "1";
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
  nowMs,
}) {
  const firstDue = fundedAtMs + minuteMs;
  if (firstDue >= cutoffMs) return 0;
  const through = Math.min(cutoffMs, nowMs);
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

async function main() {
  const [meta] = query(`
    SELECT c.id,
           EXTRACT(EPOCH FROM c.starts_at) * 1000,
           EXTRACT(EPOCH FROM c.ends_at) * 1000,
           COALESCE((c.config->'eden'->'rules'->>'loanRepayMultiplier')::float, 2)
    FROM challenges c WHERE c.slug = '${SLUG}' LIMIT 1;
  `);
  if (!meta?.[0]) throw new Error(`Challenge ${SLUG} not found`);
  const challengeId = meta[0];
  const startsMs = Number(meta[1]);
  const endsMs = Number(meta[2]);
  const configuredMs = Number(meta[3]);
  const minuteMs = (endsMs - startsMs) / EDEN_EVENT_DURATION_MINUTES;
  const cutoffMs = startsMs + GAME_HALF_MINUTES * minuteMs;
  const nowMs = Date.now();

  const loanRows = query(`
    SELECT l.id, l.user_id, u.username, l.principal, l.total_repay, l.installment,
           EXTRACT(EPOCH FROM l.funded_at) * 1000
    FROM loans l
    JOIN users u ON u.id = l.user_id
    WHERE l.challenge_id = '${challengeId}' AND l.funded_at IS NOT NULL
    ORDER BY l.funded_at;
  `);

  const byUser = new Map();

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
      nowMs,
    });
    if (paidInHalf <= 0) continue;

    const extra = roundMoney(paidInHalf * (1 - configuredMs / actualMw));
    if (extra <= 0) continue;

    const prev = byUser.get(userId) ?? { userId, username, extra: 0 };
    prev.extra = roundMoney(prev.extra + extra);
    byUser.set(userId, prev);
  }

  const users = [...byUser.values()].sort((a, b) => b.extra - a.extra);
  console.log(
    JSON.stringify(
      {
        challenge: SLUG,
        configuredMultiplier: configuredMs,
        gameHalfMinutes: GAME_HALF_MINUTES,
        minuteMs: roundMoney(minuteMs),
        cutoffIso: new Date(cutoffMs).toISOString(),
        dryRun: DRY_RUN,
        users,
        totalCredit: roundMoney(users.reduce((s, u) => s + u.extra, 0)),
      },
      null,
      2,
    ),
  );

  if (DRY_RUN) return;

  const redis = createRedis(REDIS_URL);
  try {
    for (const row of users) {
      if (row.extra <= 0) continue;
      await publishCommand(redis, challengeId, {
        type: "admin_set_account",
        challengeId,
        userId: row.userId,
        cashDelta: row.extra,
        ts: Date.now(),
      });
      console.log(`credited ${row.username}: +$${row.extra}`);
    }
  } finally {
    await redis.quit();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
