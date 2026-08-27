#!/usr/bin/env node
/**
 * Production feature + edge-case suite for Quanta.
 *
 * Default target: https://quanta.devclub.in
 *
 * Creates isolated E2E challenges, exercises trader + admin + New Eden flows,
 * then ends those challenges. Does not reset or trade on existing live events.
 *
 * Env:
 *   API_URL          default https://quanta.devclub.in
 *   WS_URL           default wss://quanta.devclub.in
 *   ADMIN_USER       default admin
 *   ADMIN_PASSWORD   default admin1234
 *   TRADER_PASSWORD  default trader1234
 *   SKIP_CLEANUP=1   leave e2e challenges live (not recommended)
 */

import { API, WS, createHarness, http, login } from "./lib.mjs";
import { suitePublic } from "./suites/01-public.mjs";
import { suiteAuth } from "./suites/02-auth.mjs";
import { suiteChallenges } from "./suites/03-challenges.mjs";
import { suiteTrading } from "./suites/04-trading.mjs";
import { suiteRealtime } from "./suites/05-realtime.mjs";
import { suiteAdmin } from "./suites/06-admin.mjs";
import { suiteNewEden } from "./suites/07-new-eden.mjs";
import { suiteEdge } from "./suites/08-edge.mjs";

const ADMIN_USER = process.env.ADMIN_USER ?? "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "admin1234";
const TRADER_PASSWORD = process.env.TRADER_PASSWORD ?? "trader1234";

async function setup(ctx) {
  console.log(`Target  API=${API}  WS=${WS}`);
  console.log("Logging in admin + trader1/2/3 (seed accounts)…");
  ctx.admin = await login(ADMIN_USER, ADMIN_PASSWORD);
  ctx.t1 = await login("trader1", TRADER_PASSWORD);
  ctx.t2 = await login("trader2", TRADER_PASSWORD);
  ctx.t3 = await login("trader3", TRADER_PASSWORD);
  const list = await http.get("/api/challenges");
  ctx.existingEnded = list.find((c) => c.status === "ended") ?? null;
  ctx.existingLive = list.filter((c) => c.status === "live");
  console.log(
    `Existing live events (left untouched): ${
      ctx.existingLive.map((c) => c.name).join(", ") || "(none)"
    }`,
  );
}

async function cleanup(ctx) {
  for (const ws of ctx.sockets) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  if (process.env.SKIP_CLEANUP === "1") {
    console.log("SKIP_CLEANUP=1 — leaving e2e challenges as-is.");
    return;
  }
  console.log("\nEnding isolated e2e challenges…");
  for (const id of ctx.createdIds) {
    try {
      await http.post(
        `/api/challenges/${id}/status`,
        { status: "ended" },
        { token: ctx.admin.token },
      );
      console.log(`  ended ${id}`);
    } catch (err) {
      console.log(`  could not end ${id}: ${err.message}`);
    }
  }
}

async function main() {
  const t = createHarness();
  const ctx = {
    adminUser: ADMIN_USER,
    createdIds: [],
    sockets: [],
    findings: [],
  };

  try {
    await setup(ctx);
    await suitePublic(t);
    await suiteAuth(t, ctx);
    await suiteChallenges(t, ctx);
    await suiteTrading(t, ctx);
    await suiteRealtime(t, ctx);
    await suiteAdmin(t, ctx);
    await suiteNewEden(t, ctx);
    await suiteEdge(t, ctx);
  } catch (err) {
    console.error("\nSuite aborted:", err);
    t.results.push({
      suite: "runner",
      name: "uncaught",
      status: "fail",
      detail: err.message ?? String(err),
      ms: 0,
    });
  } finally {
    try {
      await cleanup(ctx);
    } catch (err) {
      console.error("cleanup error:", err.message);
    }
  }

  const summary = t.report();

  if (ctx.findings.length) {
    console.log("Logic / edge findings (see also failing tests):\n");
    for (const f of ctx.findings) {
      console.log(`  [${f.severity}] ${f.area}: ${f.title}`);
      console.log(`      ${f.detail}\n`);
    }
  }

  process.exit(summary.fail > 0 ? 1 : 0);
}

main();
