import assert from "node:assert/strict";
import test from "node:test";
import { getTableName } from "drizzle-orm";
import { type Redis } from "@qtp/bus";
import {
  bondHoldings,
  challenges,
  engineCheckpoints,
  getChallengeValuation,
  optionContracts,
  participants,
  positions,
  loans,
  scoreSnapshots,
  type Challenge,
  type Database,
} from "@qtp/db";
import { redisKeys, type LeaderboardEntry } from "@qtp/shared";
import { scoreChallenge } from "./scoring.js";

// Runtime import keeps the engine's separately built source outside scoring's rootDir.
const finalizerPath = new URL(
  "../../engine/src/final-scoring.ts",
  import.meta.url,
).href;
const { finalizeScores } = (await import(finalizerPath)) as {
  finalizeScores: (
    db: Database,
    redis: Redis,
    challengeId: string,
  ) => Promise<void>;
};

function fixture() {
  const challenge = {
    id: "challenge",
    type: "new_eden",
    status: "live",
    frozen: false,
    finalizedAt: null,
    finalResults: null,
    config: {
      symbols: [{ symbol: "SPOT", initialPrice: 100, volatility: 2 }],
      eden: {
        etfs: [{ symbol: "ETF", basket: [{ symbol: "SPOT", weight: 2 }] }],
      },
    },
    scoring: { kind: "directional", pnlWeight: 1 },
  } as unknown as Challenge;
  const part = {
    userId: "trader",
    cash: 1000,
    startingCash: 1000,
    loanDebt: 200,
    username: "trader",
    displayName: "Trader",
    role: "trader",
  };
  const rows = new Map<string, unknown[]>([
    [getTableName(challenges), [challenge]],
    [getTableName(participants), [part]],
    [getTableName(positions), []],
    [getTableName(bondHoldings), []],
    [getTableName(optionContracts), []],
    [getTableName(loans), []],
  ]);
  const checkpoint = {
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    state: {
      version: 1,
      config: { challengeId: "challenge" },
      prices: { SPOT: 100 } as Record<string, number>,
      accounts: [
        {
          userId: "trader",
          cash: 1000,
          loanDebt: 200,
          positions: [] as Array<{
            symbol: string;
            quantity: number;
            avgPrice: number;
          }>,
          metrics: {
            realizedPnl: 0,
            volume: 0,
            trades: 0,
            spreadCapture: 0,
            quoteUptimeMs: 0,
          },
        },
      ],
    },
  };
  rows.set(getTableName(engineCheckpoints), [checkpoint]);
  const snapshots: Array<{
    userId: string;
    pnl: number;
    score: number;
    capturedAt: Date;
  }> = [];
  const events: string[] = [];
  const state = {
    beforeLock: () => {},
    beforeEval: () => {},
    failSnapshot: false,
    failPublish: false,
    failFinalWrite: false,
    failReads: false,
  };
  const query = (table: Parameters<typeof getTableName>[0]) => ({
    innerJoin: () => query(table),
    where: () =>
      Object.assign(Promise.resolve(rows.get(getTableName(table)) ?? []), {
        for: async (mode: string) => {
          state.beforeLock();
          events.push(`lock:${mode}`);
          return rows.get(getTableName(table)) ?? [];
        },
        orderBy: () => ({
          limit: async () => rows.get(getTableName(table)) ?? [],
        }),
      }),
  });
  const dbMock = {
    query: {
      challenges: {
        findFirst: async () => rows.get(getTableName(challenges))?.[0],
      },
      participants: {
        findFirst: async () => rows.get(getTableName(participants))?.[0],
      },
      engineCheckpoints: {
        findFirst: async () => rows.get(getTableName(engineCheckpoints))?.[0],
      },
      scoreSnapshots: { findFirst: async () => snapshots.at(-1) },
    },
    select: () => ({ from: query }),
    insert: () => ({
      values: async (values: typeof snapshots) => {
        if (state.failSnapshot) throw new Error("snapshot failure");
        snapshots.push(...values);
        events.push("snapshot");
      },
    }),
    update: () => ({
      set: (values: Partial<Challenge>) => ({
        where: async () => {
          if (state.failFinalWrite) throw new Error("final result failure");
          Object.assign(challenge, values);
          events.push("finalResults");
        },
      }),
    }),
    transaction: async (fn: (tx: Database) => Promise<unknown>) => {
      const length = snapshots.length;
      const finalResults = challenge.finalResults;
      try {
        const result = await fn(dbMock as unknown as Database);
        events.push("commit");
        return result;
      } catch (error) {
        snapshots.length = length;
        challenge.finalResults = finalResults;
        throw error;
      }
    },
  };
  const cache = new Map<string, string>();
  const priceReads: string[] = [];
  const broadcasts: unknown[] = [];
  const metrics: Record<string, string> = {};
  const redisMock = {
    get: async (key: string) => {
      if (state.failReads) throw new Error("Redis read unavailable");
      priceReads.push(key);
      return cache.get(key) ?? null;
    },
    exists: async (key: string) => Number(cache.has(key)),
    set: async (key: string, value: string) => {
      cache.set(key, value);
      events.push("barrier");
      return "OK";
    },
    hgetall: async () => {
      if (state.failReads) throw new Error("Redis read unavailable");
      return metrics;
    },
    eval: async (script: string, keyCount: number, ...args: string[]) => {
      state.beforeEval();
      if (state.failPublish) throw new Error("publish failure");
      const keys = args.slice(0, keyCount);
      const values = args.slice(keyCount);
      assert.match(script, /redis.call\('SET'/);
      assert.match(script, /redis.call\('PUBLISH'/);
      if (keyCount === 3) {
        assert.match(script, /redis.call\('EXISTS', KEYS\[1\]\)/);
        if (cache.has(keys[0]!)) return 0;
      }
      cache.set(keys[keyCount - 2]!, values[0]!);
      broadcasts.push(JSON.parse(values[1]!));
      events.push("publish");
      return 1;
    },
  };
  return {
    challenge,
    part,
    checkpoint,
    rows,
    snapshots,
    events,
    state,
    cache,
    priceReads,
    broadcasts,
    metrics,
    db: dbMock as unknown as Database,
    redis: redisMock as unknown as Redis,
    leaderboard: () =>
      JSON.parse(
        cache.get(redisKeys.leaderboard(challenge.id))!,
      ) as LeaderboardEntry[],
  };
}

test("valuation includes dynamic long/short marks, ETF NAV, remaining bond principal and debt without double-counting coupons", async () => {
  const f = fixture();
  f.rows.set(getTableName(positions), [
    { userId: "trader", symbol: "SPOT", quantity: 2 },
    { userId: "trader", symbol: "DYNAMIC", quantity: -3 },
    { userId: "trader", symbol: "ETF", quantity: 1 },
  ]);
  f.rows.set(getTableName(bondHoldings), [
    {
      userId: "trader",
      quantity: 1,
      faceValue: 900,
      price: 450,
      couponsPaid: 180,
    },
  ]);
  const reads: string[] = [];
  const valuation = await getChallengeValuation(
    f.db,
    "challenge",
    async (symbol) => {
      reads.push(symbol);
      return symbol === "DYNAMIC" ? 20 : undefined;
    },
  );
  const account = valuation!.accounts[0]!;
  assert.equal(account.positionValue, 340);
  assert.equal(account.bondValue, 360);
  assert.equal(account.marketValue, 700);
  assert.equal(account.equity, 1500);
  assert.equal(account.absInventory, 6);
  assert.equal(account.loanDebt, 200);
  assert.equal(account.displayName, "Trader");
  assert.equal(valuation!.prices.get("ETF"), 200);
  assert.equal(reads.filter((symbol) => symbol === "SPOT").length, 1);
});

test("option marks respect expired/exercise-window state, time premium and valid zero marks", async () => {
  const f = fixture();
  const now = Date.now();
  f.rows.set(getTableName(optionContracts), [
    { symbol: "EXPIRED", status: "expired", underlying: "SPOT" },
    {
      symbol: "CALL",
      status: "exercise_window",
      underlying: "SPOT",
      optionType: "call",
      strike: 90,
    },
    {
      symbol: "PUT",
      status: "open",
      underlying: "SPOT",
      optionType: "put",
      strike: 110,
      createdAt: new Date(now - 100000),
      expiresAt: new Date(now + 100000),
    },
    {
      symbol: "OVERDUE",
      status: "open",
      underlying: "SPOT",
      optionType: "put",
      strike: 110,
      createdAt: new Date(now - 200000),
      expiresAt: new Date(now - 100000),
    },
  ]);
  f.rows.set(
    getTableName(positions),
    ["EXPIRED", "CALL", "PUT", "OVERDUE", "ZERO"].map((symbol) => ({
      userId: "trader",
      symbol,
      quantity: 1,
    })),
  );
  const valuation = await getChallengeValuation(
    f.db,
    "challenge",
    async (symbol) =>
      symbol === "ZERO"
        ? 0
        : ["EXPIRED", "CALL", "OVERDUE"].includes(symbol)
          ? 99
          : null,
  );
  assert.equal(valuation!.prices.get("EXPIRED"), 0);
  assert.equal(valuation!.prices.get("CALL"), 10);
  assert.equal(valuation!.prices.get("OVERDUE"), 10);
  assert.ok(Math.abs(valuation!.prices.get("PUT")! - 14) < 0.1);
  assert.equal(valuation!.prices.get("ZERO"), 0);
});

test("valuation fails closed on missing or invalid marks rather than erasing a liability", async () => {
  const f = fixture();
  f.rows.set(getTableName(positions), [
    { userId: "trader", symbol: "UNKNOWN", quantity: -5 },
  ]);
  await assert.rejects(
    getChallengeValuation(f.db, "challenge", async () => null),
    /UNKNOWN/,
  );
  await assert.rejects(
    getChallengeValuation(f.db, "challenge", async () => NaN),
    /invalid valuation/,
  );
});

test("non-Eden balances do not subtract Eden loan debt; missing challenges return undefined", async () => {
  const f = fixture();
  f.challenge.type = "directional";
  const valuation = await getChallengeValuation(
    f.db,
    "challenge",
    async () => null,
  );
  assert.equal(valuation!.accounts[0]!.equity, 1000);
  f.rows.set(getTableName(challenges), []);
  assert.equal(
    await getChallengeValuation(f.db, "challenge", async () => null),
    undefined,
  );
});

test("worker and finalizer rank identical balances, exclude admins, and use durable inventory", async () => {
  const f = fixture();
  f.rows.set(getTableName(participants), [
    f.part,
    { ...f.part, userId: "admin", role: "admin", cash: 999999 },
  ]);
  f.rows.set(getTableName(positions), [
    { userId: "trader", symbol: "SPOT", quantity: -2 },
  ]);
  f.challenge.scoring = {
    kind: "market_making",
    pnlWeight: 1,
    spreadCaptureWeight: 2,
    quoteUptimeWeight: 1,
    inventoryPenaltyWeight: 3,
    maxSpread: 1,
    minQuoteSize: 1,
  };
  f.metrics.trader = JSON.stringify({
    realizedPnl: 0,
    volume: 0,
    trades: 0,
    inventory: 999,
    spreadCapture: 10,
    quoteUptime: 5,
  });
  await scoreChallenge(f.db, f.redis, "challenge", { snapshotMs: 0 });
  const live = f.leaderboard();
  assert.equal(live.length, 1);
  assert.equal(live[0]!.pnl, -400);
  assert.equal(live[0]!.score, -381);
  f.challenge.frozen = true;
  Object.assign(f.checkpoint.state.accounts[0]!.metrics, {
    spreadCapture: 10,
    quoteUptimeMs: 5000,
  });
  await finalizeScores(f.db, f.redis, "challenge");
  assert.deepEqual(
    f.leaderboard(),
    live.map((entry) => ({
      ...entry,
      metrics: { ...entry.metrics, inventory: 2 },
    })),
  );
  assert.equal(f.snapshots.length, 2);
  assert.equal(f.cache.get("qtp:final:challenge"), "1");
  assert.deepEqual(f.events.slice(-6), [
    "barrier",
    "lock:update",
    "snapshot",
    "finalResults",
    "commit",
    "publish",
  ]);
});

test("worker rechecks frozen, ended and finalized state before publishing or snapshotting", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.challenge.frozen = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.challenge.status = "ended";
    },
    (f: ReturnType<typeof fixture>) => {
      f.challenge.finalizedAt = new Date();
    },
    (f: ReturnType<typeof fixture>) => {
      f.challenge.finalResults = [];
    },
  ]) {
    const f = fixture();
    f.state.beforeLock = () => change(f);
    await scoreChallenge(f.db, f.redis, "challenge", { snapshotMs: 0 });
    assert.equal(f.broadcasts.length, 0);
    assert.equal(f.snapshots.length, 0);
  }
});

test("Lua barrier prevents a late periodic write AND broadcast from replacing final results", async () => {
  const f = fixture();
  f.state.beforeEval = () => {
    f.cache.set("qtp:final:challenge", "1");
    f.cache.set(redisKeys.leaderboard("challenge"), "[]");
  };
  await scoreChallenge(f.db, f.redis, "challenge", { snapshotMs: 0 });
  assert.deepEqual(f.leaderboard(), []);
  assert.equal(f.broadcasts.length, 0);
});

test("finalizer uses balances at call time and retains results unchanged on retry", async () => {
  const f = fixture();
  f.part.cash = 1700;
  f.challenge.status = "ended";
  await finalizeScores(f.db, f.redis, "challenge");
  assert.equal(f.leaderboard()[0]!.pnl, 500);
  f.rows.set(getTableName(participants), []);
  await finalizeScores(f.db, f.redis, "challenge");
  assert.equal(f.leaderboard()[0]!.pnl, 500);
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.broadcasts.length, 2);
});

test("failed final snapshots keep the barrier, do not publish, and permit retry", async () => {
  const f = fixture();
  f.challenge.frozen = true;
  f.state.failSnapshot = true;
  await assert.rejects(
    finalizeScores(f.db, f.redis, "challenge"),
    /snapshot failure/,
  );
  assert.equal(f.broadcasts.length, 0);
  assert.equal(f.cache.get("qtp:final:challenge"), "1");
  f.state.failSnapshot = false;
  await scoreChallenge(f.db, f.redis, "challenge");
  assert.equal(f.snapshots.length, 0);
  await finalizeScores(f.db, f.redis, "challenge");
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.broadcasts.length, 1);
});

test("finalizer propagates publish failures after committing snapshots; retry restores the leaderboard", async () => {
  const f = fixture();
  f.challenge.frozen = true;
  f.state.failPublish = true;
  await assert.rejects(
    finalizeScores(f.db, f.redis, "challenge"),
    /publish failure/,
  );
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.cache.get("qtp:final:challenge"), "1");
  f.state.failPublish = false;
  f.part.cash = 999999;
  f.checkpoint.state.prices.SPOT = 999999;
  f.rows.set(getTableName(engineCheckpoints), []);
  await finalizeScores(f.db, f.redis, "challenge");
  assert.equal(f.leaderboard()[0]!.pnl, -200);
  assert.equal(f.snapshots.length, 1);
});

test("authoritative marks bypass caches, initial prices and option expiry recalculation", async () => {
  const f = fixture();
  f.rows.set(getTableName(positions), [
    { userId: "trader", symbol: "OLD_OPTION", quantity: 2 },
  ]);
  f.rows.set(getTableName(optionContracts), [
    { symbol: "OLD_OPTION", status: "expired" },
  ]);
  const valuation = await getChallengeValuation(
    f.db,
    "challenge",
    async () => {
      throw new Error("must not read live prices");
    },
    { now: 0, marks: { SPOT: 150, OLD_OPTION: 17 } },
  );
  assert.equal(valuation!.accounts[0]!.marketValue, 34);
  await assert.rejects(
    getChallengeValuation(f.db, "challenge", async () => 100, {
      marks: { SPOT: 150 },
    }),
    /OLD_OPTION/,
  );
  await assert.rejects(
    getChallengeValuation(f.db, "challenge", async () => 100, { marks: {} }),
    /SPOT/,
  );
});

test("finalization uses checkpoint prices and metrics without Redis reads", async () => {
  const f = fixture();
  f.challenge.frozen = true;
  f.state.failReads = true;
  f.checkpoint.state.prices.SPOT = 175;
  f.checkpoint.state.accounts[0]!.metrics.quoteUptimeMs = 7500;
  f.rows.set(getTableName(positions), [
    { userId: "trader", symbol: "SPOT", quantity: 2 },
  ]);
  await finalizeScores(f.db, f.redis, "challenge");
  assert.equal(f.challenge.finalResults![0]!.pnl, 150);
  assert.equal(f.challenge.finalResults![0]!.metrics!.quoteUptime, 7.5);
  assert.deepEqual(f.challenge.finalResults, f.leaderboard());
  assert.equal(f.priceReads.length, 0);
});

test("missing or unsupported checkpoints and missing marks cannot produce final results", async () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) =>
      f.rows.set(getTableName(engineCheckpoints), []),
    (f: ReturnType<typeof fixture>) => {
      f.checkpoint.state.version = 99;
    },
    (f: ReturnType<typeof fixture>) => {
      f.checkpoint.state.prices = {};
    },
  ]) {
    const f = fixture();
    f.challenge.frozen = true;
    invalidate(f);
    await assert.rejects(
      finalizeScores(f.db, f.redis, "challenge"),
      /checkpoint|valuation/,
    );
    assert.equal(f.challenge.finalResults, null);
    assert.equal(f.snapshots.length, 0);
    assert.equal(f.broadcasts.length, 0);
  }
});

test("final result and snapshot writes roll back together", async () => {
  const f = fixture();
  f.challenge.frozen = true;
  f.state.failFinalWrite = true;
  await assert.rejects(
    finalizeScores(f.db, f.redis, "challenge"),
    /final result failure/,
  );
  assert.equal(f.challenge.finalResults, null);
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.broadcasts.length, 0);
});

test("empty final results are persisted and remain authoritative on retry", async () => {
  const f = fixture();
  f.challenge.frozen = true;
  f.rows.set(getTableName(participants), []);
  await finalizeScores(f.db, f.redis, "challenge");
  assert.deepEqual(f.challenge.finalResults, []);
  f.rows.set(getTableName(participants), [f.part]);
  await finalizeScores(f.db, f.redis, "challenge");
  assert.deepEqual(f.leaderboard(), []);
  assert.equal(f.snapshots.length, 0);
});

async function apiHandler(
  route: "leaderboard" | "portfolio",
  f: ReturnType<typeof fixture>,
) {
  const path = new URL(`../../api/src/routes/${route}.ts`, import.meta.url)
    .href;
  const routes = await import(path);
  type Handler = (
    req: { params: { challengeId: string }; user: { sub: string } },
    reply: unknown,
  ) => Promise<unknown>;
  let handler: Handler;
  await routes[`${route}Routes`]({
    db: f.db,
    redis: f.redis,
    authenticate: () => {},
    get: (_path: string, ...args: unknown[]) => {
      handler = args.at(-1) as Handler;
    },
  });
  let status = 200;
  let error: unknown;
  const reply = {
    code: (code: number) => {
      status = code;
      return reply;
    },
    send: (body: unknown) => {
      error = body;
      return body;
    },
  };
  const body = await handler!(
    { params: { challengeId: "challenge" }, user: { sub: "trader" } },
    reply,
  );
  return { status, body: body ?? error };
}

test("leaderboard API serves durable final results, including empty results, with Redis unavailable", async () => {
  const f = fixture();
  f.challenge.frozen = true;
  await finalizeScores(f.db, f.redis, "challenge");
  f.state.failReads = true;
  assert.deepEqual(
    (await apiHandler("leaderboard", f)).body,
    f.challenge.finalResults,
  );
  f.challenge.finalResults = [];
  assert.deepEqual((await apiHandler("leaderboard", f)).body, []);
});

test("legacy ended leaderboards recover the latest historical snapshot batch when Redis is lost", async () => {
  const f = fixture();
  f.challenge.status = "ended";
  f.challenge.finalizedAt = new Date();
  f.state.failReads = true;
  const snapshot = {
    userId: "trader",
    username: "trader",
    displayName: "Trader",
    pnl: 400,
    score: 400,
    capturedAt: new Date(),
  };
  f.snapshots.push(snapshot);
  f.rows.set(getTableName(scoreSnapshots), [snapshot]);
  const result = await apiHandler("leaderboard", f);
  assert.equal((result.body as LeaderboardEntry[])[0]!.score, 400);
  assert.equal(f.challenge.finalResults, null);
});

test("final portfolio uses checkpoint balances and marks plus stored results, not Redis or today's option clock", async () => {
  const f = fixture();
  f.challenge.frozen = true;
  f.rows.set(getTableName(positions), [
    { userId: "trader", symbol: "SPOT", quantity: 2, avgPrice: 100 },
  ]);
  f.checkpoint.state.accounts[0]!.positions = [
    { symbol: "SPOT", quantity: 2, avgPrice: 100 },
  ];
  f.checkpoint.state.prices.SPOT = 175;
  await finalizeScores(f.db, f.redis, "challenge");
  f.part.cash = 999999;
  f.part.loanDebt = 999999;
  f.state.failReads = true;
  const result = await apiHandler("portfolio", f);
  assert.equal(result.status, 200);
  const portfolio = result.body as {
    cash: number;
    pnl: number;
    score: number;
    marketValue: number;
    loanDebt: number;
    premium: boolean;
  };
  assert.equal(portfolio.cash, 1000);
  assert.equal(portfolio.loanDebt, 200);
  assert.equal(portfolio.marketValue, 350);
  assert.equal(portfolio.pnl, 150);
  assert.equal(portfolio.score, 150);
  assert.equal(portfolio.premium, false);
});

test("legacy final portfolios recover aggregate value from snapshots without inventing missing marks", async () => {
  const f = fixture();
  f.challenge.status = "ended";
  f.rows.set(getTableName(engineCheckpoints), []);
  f.snapshots.push({
    userId: "trader",
    pnl: 300,
    score: 600,
    capturedAt: new Date(),
  });
  f.state.failReads = true;
  const result = await apiHandler("portfolio", f);
  assert.equal(result.status, 200);
  const portfolio = result.body as {
    pnl: number;
    score: number;
    marketValue: number;
  };
  assert.equal(portfolio.pnl, 300);
  assert.equal(portfolio.score, 600);
  assert.equal(portfolio.marketValue, 500);
});

test("ended portfolios with a checkpoint do not reuse a stale periodic snapshot before finalResults commits", async () => {
  const f = fixture();
  f.challenge.status = "ended";
  f.snapshots.push({
    userId: "trader",
    pnl: 9999,
    score: 9999,
    capturedAt: new Date(),
  });
  f.state.failReads = true;
  const result = await apiHandler("portfolio", f);
  assert.equal(result.status, 200);
  assert.equal((result.body as { pnl: number }).pnl, -200);
});

test("new final portfolios fail closed without the checkpoint or a held symbol mark", async () => {
  const f = fixture();
  f.challenge.finalResults = [];
  f.rows.set(getTableName(engineCheckpoints), []);
  assert.equal((await apiHandler("portfolio", f)).status, 503);
  f.rows.set(getTableName(engineCheckpoints), [f.checkpoint]);
  f.checkpoint.state.accounts[0]!.positions = [
    { symbol: "MISSING", quantity: 1, avgPrice: 10 },
  ];
  assert.equal((await apiHandler("portfolio", f)).status, 503);
});
