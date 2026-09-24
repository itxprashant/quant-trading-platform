#!/usr/bin/env node
/**
 * Production feature + edge-case suite for Quantstorm.
 *
 * Default target: https://quantstorm-2026.site
 *
 * Creates isolated E2E challenges, exercises trader + admin + New Eden flows,
 * then ends those challenges. Does not reset or trade on existing live events.
 *
 * Env:
 *   API_URL          default https://quantstorm-2026.site
 *   WS_URL           default wss://quantstorm-2026.site
 *   ADMIN_USER       default admin
 *   ADMIN_PASSWORD   default admin1234
 *   TRADER_PASSWORD  default trader1234
 *   SKIP_CLEANUP=1   leave e2e challenges live (not recommended)
 *   SKIP_SCRIPT=1    skip the scripted New Eden timeline (~5.5 min on real clock)
 *   ONLY=a,b         run a subset: public, auth, challenges, trading, realtime,
 *                    admin, eden, edge, post-audit, script (later suites reuse
 *                    fixtures from earlier ones and skip or fail without them)
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
import { startScriptedEden, suiteScriptedEden } from "./suites/09-eden-script.mjs";
import { suitePostAudit } from "./suites/10-post-audit.mjs";

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

  const only = process.env.ONLY?.split(",").map((s) => s.trim());
  const want = (name) => !only || only.includes(name);
  const script = process.env.SKIP_SCRIPT !== "1" && want("script");

  try {
    await setup(ctx);
    if (script) await startScriptedEden(ctx);
    if (want("public")) await suitePublic(t);
    if (want("auth")) await suiteAuth(t, ctx);
    if (want("challenges")) await suiteChallenges(t, ctx);
    if (want("trading")) await suiteTrading(t, ctx);
    if (want("realtime")) await suiteRealtime(t, ctx);
    if (want("admin")) await suiteAdmin(t, ctx);
    if (want("eden")) await suiteNewEden(t, ctx);
    if (want("edge")) await suiteEdge(t, ctx);
    if (want("post-audit")) await suitePostAudit(t, ctx);
    if (script) await suiteScriptedEden(t, ctx);
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
