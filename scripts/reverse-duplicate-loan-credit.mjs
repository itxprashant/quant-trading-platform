/**
 * Reverse one duplicate pass of first-half loan multiplier credits.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SLUG = "new-eden-exchange";
const DRY_RUN = process.env.DRY_RUN !== "0";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://qtp:qtp@localhost:5432/qtp";

const scriptPath = fileURLToPath(
  new URL("./compensate-eden-early-end.mjs", import.meta.url),
);

const out = execFileSync(process.execPath, [scriptPath], {
  env: { ...process.env, DATABASE_URL, DRY_RUN: "1" },
  encoding: "utf8",
});
const report = JSON.parse(out);
const users = report.users.filter((u) => u.loan > 0);
const totalDebit = users.reduce((s, u) => s + u.loan, 0);
console.log(
  JSON.stringify(
    { dryRun: DRY_RUN, totalDebit, users },
    null,
    2,
  ),
);
if (DRY_RUN) process.exit(0);

const [challengeId] = execFileSync(
  "psql",
  [DATABASE_URL, "-t", "-A", "-c", `SELECT id FROM challenges WHERE slug='${SLUG}';`],
  { encoding: "utf8" },
).trim().split("\n");

for (const row of users) {
  execFileSync(
    "psql",
    [
      DATABASE_URL,
      "-c",
      `UPDATE challenge_participants SET cash = cash - ${row.loan}
       WHERE challenge_id = '${challengeId}' AND user_id = '${row.userId}';`,
    ],
    { stdio: "inherit" },
  );
  console.log(`debited ${row.username}: -$${row.loan}`);
}
