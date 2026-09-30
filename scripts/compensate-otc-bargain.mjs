/**
 * One-shot: credit traders who bargained a unit price but were charged the
 * original offer price (cash adjustment was applied once, not per unit).
 *
 * Usage:
 *   DATABASE_URL=... REDIS_URL=... node scripts/compensate-otc-bargain.mjs
 * Dry run:
 *   DRY_RUN=1 node scripts/compensate-otc-bargain.mjs
 */
import { execFileSync } from "node:child_process";
import { createRedis, publishCommand } from "../packages/bus/dist/index.js";

const SLUG = process.env.CHALLENGE_SLUG ?? "new-eden-exchange";
const DRY_RUN = process.env.DRY_RUN === "1";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://qtp:qtp@localhost:5432/qtp";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/** Recommended credits: typed unit price vs qty × original price. */
const CREDITS = [
  {
    username: "hrishikeshpingle",
    userId: "fb270443-114e-4b69-938b-53b83b092782",
    extra: 5540,
    note: "Deal Desk #5 typed 2000",
  },
  {
    username: "anshtiwari",
    userId: "940b5b66-962a-48d4-9150-fe6878f256f5",
    extra: 4440,
    note: "Deal Desk #5 typed 2100",
  },
  {
    username: "pulkit",
    userId: "ec7d37c6-2f78-43ed-9964-e84aff06280a",
    extra: 3340,
    note: "Deal Desk #5 typed 2200",
  },
  {
    username: "sanjibanpaul",
    userId: "2df96d93-6589-44c2-9c9a-0c5f5f72e25c",
    extra: 3340,
    note: "Deal Desk #5 typed 2200",
  },
  {
    username: "joelbansal",
    userId: "2ca56fe8-5e9a-42f4-8ebb-a0a7c76a8d63",
    extra: 2240,
    note: "Deal Desk #5 typed 2300",
  },
  {
    username: "vineelreddy",
    userId: "8e46f1cb-dc41-49d5-920e-db4f6463180d",
    extra: 2240,
    note: "Deal Desk #5 typed 2300",
  },
  {
    username: "pritvikpremkumarshanmuga",
    userId: "8a1f677a-c4f7-4284-97e0-bfd9bbe6612e",
    extra: 5265,
    note: "Deal Desk #5 typed 2400 (+1140); #6 typed 1179 (+4125)",
  },
];

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
  const [meta] = query(
    `SELECT c.id FROM challenges c WHERE c.slug = '${SLUG}' LIMIT 1;`,
  );
  if (!meta?.[0]) throw new Error(`Challenge ${SLUG} not found`);
  const challengeId = meta[0];

  const ids = CREDITS.map((c) => `'${c.userId}'`).join(",");
  const cashRows = query(`
    SELECT u.username, p.user_id, p.cash
    FROM challenge_participants p
    JOIN users u ON u.id = p.user_id
    WHERE p.challenge_id = '${challengeId}' AND p.user_id IN (${ids});
  `);
  const cashByUser = new Map(
    cashRows.map(([username, userId, cash]) => [userId, { username, cash: Number(cash) }]),
  );

  const users = CREDITS.map((row) => {
    const held = cashByUser.get(row.userId);
    if (!held) throw new Error(`Not enrolled: ${row.username} ${row.userId}`);
    return { ...row, cashBefore: held.cash };
  });

  console.log(
    JSON.stringify(
      {
        challenge: SLUG,
        challengeId,
        dryRun: DRY_RUN,
        users,
        totalCredit: users.reduce((s, u) => s + u.extra, 0),
      },
      null,
      2,
    ),
  );

  if (DRY_RUN) return;

  const redis = createRedis(REDIS_URL);
  try {
    for (const row of users) {
      await publishCommand(redis, challengeId, {
        type: "admin_set_account",
        challengeId,
        userId: row.userId,
        cashDelta: row.extra,
        ts: Date.now(),
      });
      console.log(`credited ${row.username}: +$${row.extra} (${row.note})`);
    }
  } finally {
    await redis.quit();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
