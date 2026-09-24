import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChallengeEngine } from "@qtp/core";
import type { Challenge, Database } from "@qtp/db";
import {
  EDEN_EVENT_ACTIONS,
  zEdenRules,
  type EngineCommand,
  type EngineEvent,
} from "@qtp/shared";
import type { Redis } from "@qtp/bus";
import { Persistence, type DbTransaction } from "./persistence.js";
import { ChallengeRunner } from "./runner.js";
import { EventTimeline, type EventActionContext } from "./event-timeline.js";

const bus = vi.hoisted(() => ({
  createRedis: vi.fn(),
  readCommands: vi.fn(),
  appendEvents: vi.fn(async (..._args: unknown[]) => {}),
  publishBroadcast: vi.fn(async (..._args: unknown[]) => {}),
  getTraderMetricsMap: vi.fn(async () => new Map()),
  getPrice: vi.fn(async () => null),
  getFairValue: vi.fn(async () => null),
  setPrice: vi.fn(async () => {}),
  setFairValue: vi.fn(async () => {}),
  setMidPrice: vi.fn(async () => {}),
  setBookSnapshot: vi.fn(async () => {}),
  setMarketFrozen: vi.fn(async () => {}),
  setTraderMetrics: vi.fn(async () => {}),
  addListedSymbol: vi.fn(),
  setSymbolTradeable: vi.fn(),
  pushNews: vi.fn(),
}));
vi.mock("@qtp/bus", () => bus);
vi.mock("@qtp/db", () =>
  Object.fromEntries(
    [
      "challenges",
      "challengeNews",
      "engineCheckpoints",
      "eventActions",
      "fairValues",
      "grantMissions",
      "orders",
      "participants",
      "positions",
      "trades",
    ].map((name) => [
      name,
      new Proxy(
        { name },
        {
          get: (target, key) => (key === "name" ? target.name : String(key)),
        },
      ),
    ]),
  ),
);
vi.mock("drizzle-orm", () => ({
  eq: (key: string, value: unknown) => (row: Row) => row[key] === value,
  and:
    (...filters: Filter[]) =>
    (row: Row) =>
      filters.every((f) => f(row)),
  or:
    (...filters: Filter[]) =>
    (row: Row) =>
      filters.some((f) => f(row)),
  inArray: (key: string, values: unknown[]) => (row: Row) =>
    values.includes(row[key]),
  isNull: (key: string) => (row: Row) => row[key] == null,
  isNotNull: (key: string) => (row: Row) => row[key] != null,
  lte: vi.fn(),
  asc: (key: string) => key,
}));
vi.mock("./env.js", () => ({
  env: {
    redisUrl: "redis://test",
    minuteMs: 60_000,
    tickMs: 1000,
    botMs: 1200,
    flushMs: 250,
    metricsMs: 1000,
  },
}));
vi.mock("./bots.js", () => ({
  BotEngine: class {
    enabled = false;
  },
}));
vi.mock("./eden-bots.js", () => ({ EdenBotEngine: class {} }));
vi.mock("./options-manager.js", () => ({ OptionsManager: class {} }));
vi.mock("./markets-manager.js", () => ({ MarketsManager: class {} }));
vi.mock("./eden-settlements.js", () => ({
  EdenSettlements: class {
    reserveOtc = vi.fn(async (_now: number) => {});
    repayLoans = vi.fn(async () => {});
    recover = vi.fn(async () => {});
  },
}));
const executor = vi.hoisted(() => ({
  execute: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock("./event-executor.js", () => ({
  EventExecutor: class {
    execute = executor.execute;
  },
}));
vi.mock("./final-scoring.js", () => ({ finalizeScores: vi.fn() }));

type Row = Record<string, any>;
type Filter = (row: Row) => boolean;
type Checkpoint = {
  state: ReturnType<ChallengeEngine["exportState"]>;
  cursor: string;
  minuteCount: number;
};
// Private methods are runtime-accessible; keep the production API unchanged.
type Runtime = {
  engine: ChallengeEngine;
  persistence: Persistence;
  settlements: { reserveOtc: ReturnType<typeof vi.fn> };
  running: boolean;
  lastId: string;
  minuteCount: number;
  commandWork?: Promise<void>;
  options?: { stop: ReturnType<typeof vi.fn> };
  markets?: {
    stop: ReturnType<typeof vi.fn>;
    payCoupons: ReturnType<typeof vi.fn>;
    bondValueOf: () => number;
  };
  timeline?: Pick<EventTimeline, "tick">;
  enqueue(task: () => Promise<void>): Promise<void>;
  dispatch(task: () => Promise<void>): void;
  commandLoop(): Promise<void>;
  advanceClock(now: number): Promise<void>;
  minuteTick(now: number): Promise<void>;
  process(command: EngineCommand): Promise<EngineEvent[]>;
  emit(events: EngineEvent[]): Promise<void>;
  enforceMargins(now: number): EngineEvent[];
};
const START = 1_800_000_000_000;
const USER = "00000000-0000-4000-a000-000000000001";
const ORDER = "00000000-0000-4000-a000-000000000002";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(eden = false, frozen = false) {
  const tables: Record<string, Row[]> = Object.fromEntries(
    [
      "participants",
      "positions",
      "orders",
      "fairValues",
      "eventActions",
      "engineCheckpoints",
    ].map((name) => [name, []]),
  );
  const commits: Checkpoint[] = [];
  let beforeCommit: (() => Promise<void>) | undefined;
  const from = vi.fn((table: { name: string }) => ({
    where: (filter: Filter) => {
      const rows = tables[table.name]!.filter(filter);
      return Object.assign(Promise.resolve(rows), {
        orderBy: () => Promise.resolve(rows),
      });
    },
  }));
  // Transaction-local copies model receipt/checkpoint atomicity, not SQL locking.
  const transaction = vi.fn(
    async (run: (tx: DbTransaction) => Promise<void>) => {
      const staged = structuredClone(tables);
      const tx = {
        insert: (table: { name: string }) => ({
          values: (value: Row | Row[]) => {
            const rows = (staged[table.name] ??= []);
            const values = Array.isArray(value) ? value : [value];
            const keys =
              table.name === "engineCheckpoints"
                ? ["challengeId"]
                : table.name === "eventActions"
                  ? ["challengeId", "actionId"]
                  : table.name === "participants"
                    ? ["challengeId", "userId"]
                    : ["challengeId", "userId", "symbol"];
            const insert = (set?: Row) => {
              for (const item of values) {
                const existing = rows.find((row) =>
                  keys.every((key) => row[key] === item[key]),
                );
                if (existing) {
                  if (set) Object.assign(existing, structuredClone(set));
                } else rows.push(structuredClone(item));
              }
            };
            return {
              onConflictDoUpdate: async ({ set }: { set: Row }) => insert(set),
              onConflictDoNothing: async () => insert(),
              then: (resolve: (value: void) => unknown) => {
                rows.push(...structuredClone(values));
                return Promise.resolve().then(resolve);
              },
            };
          },
        }),
        update: () => ({ set: () => ({ where: async () => {} }) }),
      } as unknown as DbTransaction;
      await run(tx);
      await beforeCommit?.();
      Object.assign(tables, staged);
      const checkpoint = tables.engineCheckpoints!.at(-1) as Checkpoint;
      if (checkpoint) commits.push(structuredClone(checkpoint));
    },
  );
  const db = {
    select: () => ({ from }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
    transaction,
    query: {
      engineCheckpoints: {
        findFirst: vi.fn(async () => tables.engineCheckpoints!.at(-1)),
      },
    },
  } as unknown as Database;
  const redis = {
    get: vi.fn(async () => null),
    xlen: vi.fn(async () => 0),
    set: vi.fn(async () => "OK"),
  };
  const reader = { disconnect: vi.fn() };
  bus.createRedis.mockReturnValue(reader);
  const challenge = {
    id: "challenge",
    slug: "runner-test",
    type: eden ? "new_eden" : "directional",
    status: "live",
    startsAt: new Date(START),
    endsAt: null,
    frozen,
    config: {
      symbols: [{ symbol: "A", initialPrice: 100, volatility: 0, tickSize: 1 }],
      startingCash: 1000,
      minPosition: -100,
      maxPosition: 100,
      maxOrderQuantity: 100,
      allowMargin: true,
      autonomousPrice: false,
      ...(eden
        ? {
            eden: {
              rules: zEdenRules.parse({ enabled: true }),
              eventScript: false,
            },
          }
        : {}),
    },
    scoring: { kind: "directional" },
  } as unknown as Challenge;
  const runner = new ChallengeRunner(redis as unknown as Redis, db, challenge);
  const runtime = runner as unknown as Runtime;
  runtime.running = true;
  return {
    runner,
    runtime,
    engine: runtime.engine,
    tables,
    commits,
    transaction,
    from,
    redis,
    reader,
    beforeCommit: (fn?: () => Promise<void>) => {
      beforeCommit = fn;
    },
  };
}

function order(orderId = ORDER, price = 90): EngineCommand {
  return {
    type: "place_order",
    challengeId: "challenge",
    orderId,
    userId: USER,
    symbol: "A",
    side: "buy",
    orderType: "limit",
    quantity: 1,
    price,
    ts: START,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChallengeRunner integration boundaries", () => {
  it("awaits OTC reservation before matching a new order against remaining capacity", async () => {
    const f = fixture(true);
    const reserving = deferred();
    const entered = deferred();
    f.runtime.settlements.reserveOtc.mockImplementation(async () => {
      entered.resolve();
      await reserving.promise;
      expect(
        f.engine.reserveSettlement("accepted-deal", USER, [
          { symbol: "A", quantity: 100, price: 100 },
        ]),
      ).toBe(true);
    });
    const process = vi.spyOn(f.runtime, "process");
    let events: EngineEvent[] = [];
    const work = f.runtime.enqueue(async () => {
      events = await f.runtime.process(order());
      await f.runtime.emit(events);
    });
    await entered.promise;
    expect(f.runtime.settlements.reserveOtc).toHaveBeenCalledWith(START);
    expect(process).not.toHaveBeenCalled();
    reserving.resolve();
    await work;
    expect(process).toHaveBeenCalledOnce();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "order_update",
          orderId: ORDER,
          status: "rejected",
        }),
      ]),
    );
    expect(f.engine.snapshot("A").bids).toEqual([]);
    expect(f.engine.positionOf(USER, "A")).toBe(0);
  });

  it("serializes manager callbacks behind both mutation work and its commit", async () => {
    const f = fixture();
    const applying = deferred();
    const committing = deferred();
    const commitEntered = deferred();
    const trace: string[] = [];
    f.beforeCommit(async () => {
      commitEntered.resolve();
      await committing.promise;
    });
    const first = f.runtime.enqueue(async () => {
      trace.push("command");
      await applying.promise;
    });
    f.runtime.dispatch(async () => {
      trace.push("manager");
    });
    const drained = f.runtime.enqueue(async () => {
      trace.push("drained");
    });
    await Promise.resolve();
    expect(trace).toEqual(["command"]);
    applying.resolve();
    await commitEntered.promise;
    expect(trace).toEqual(["command"]);
    expect(f.commits).toHaveLength(0);
    committing.resolve();
    await first;
    await drained;
    expect(trace).toEqual(["command", "manager", "drained"]);
  });

  it("poisons the writer on commit failure and skips already queued mutations", async () => {
    const f = fixture();
    f.runtime.options = { stop: vi.fn() };
    f.runtime.markets = {
      stop: vi.fn(),
      payCoupons: vi.fn(),
      bondValueOf: () => 0,
    };
    f.beforeCommit(async () => {
      throw new Error("commit failed");
    });
    const first = f.runtime.enqueue(async () => {});
    const later = vi.fn(async () => {});
    const second = f.runtime.enqueue(later);
    await expect(first).rejects.toThrow("commit failed");
    await second;
    expect(later).not.toHaveBeenCalled();
    expect(f.runner.healthy).toBe(false);
    expect(f.runtime.options.stop).toHaveBeenCalledOnce();
    expect(f.runtime.markets.stop).toHaveBeenCalledOnce();
    await f.runner.stop();
    expect(f.transaction).toHaveBeenCalledOnce();
  });

  it("starts at cursor zero without hydrating API orders still pending in the stream", async () => {
    const f = fixture();
    f.tables.orders!.push({
      id: ORDER,
      challengeId: "challenge",
      userId: USER,
      symbol: "A",
      side: "buy",
      type: "limit",
      price: 90,
      remainingQuantity: 1,
      status: "open",
    });
    const lateRead = deferred<{ nextId: string; messages: [] }>();
    bus.readCommands.mockReturnValueOnce(lateRead.promise);
    try {
      await f.runner.start();
      expect(bus.readCommands).toHaveBeenCalledWith(
        f.reader,
        "challenge",
        "0-0",
        1000,
      );
      expect(f.engine.snapshot("A").bids).toEqual([]);
      expect(
        f.from.mock.calls.some(
          ([table]: [{ name: string }]) => table.name === "orders",
        ),
      ).toBe(false);
      expect(f.commits[0]!.cursor).toBe("0-0");
      await f.runtime.emit(await f.runtime.process(order()));
      expect(f.engine.snapshot("A").bids).toEqual([
        { price: 90, quantity: 1, orders: 1 },
      ]);
    } finally {
      const stopping = f.runner.stop();
      lateRead.resolve({ nextId: "0-0", messages: [] });
      await stopping;
    }
  });

  it("commits each command's cursor and state before publication or the next command", async () => {
    const f = fixture();
    const nextRead = deferred();
    bus.readCommands
      .mockResolvedValueOnce({
        nextId: "2-0",
        messages: [
          { id: "1-0", data: order() },
          {
            id: "2-0",
            data: order("00000000-0000-4000-a000-000000000003", 80),
          },
        ],
      })
      .mockImplementationOnce(async () => {
        f.runtime.running = false;
        nextRead.resolve();
        return { nextId: "2-0", messages: [] };
      });
    const process = vi.spyOn(f.runtime, "process");
    const committing = deferred();
    const entered = deferred();
    f.beforeCommit(async () => {
      entered.resolve();
      await committing.promise;
    });
    f.runtime.commandWork = f.runtime.commandLoop();
    await entered.promise;
    expect(process).toHaveBeenCalledOnce();
    expect(f.runtime.lastId).toBe("0-0");
    expect(bus.appendEvents).not.toHaveBeenCalled();
    expect(bus.publishBroadcast).not.toHaveBeenCalled();
    expect(f.redis.set).not.toHaveBeenCalled();
    committing.resolve();
    await nextRead.promise;
    await f.runtime.commandWork;
    const first = f.commits.find((c) => c.cursor === "1-0")!;
    const second = f.commits.find((c) => c.cursor === "2-0")!;
    f.engine.restoreState(first.state);
    expect(f.engine.snapshot("A").bids).toEqual([
      { price: 90, quantity: 1, orders: 1 },
    ]);
    f.engine.restoreState(second.state);
    expect(f.engine.snapshot("A").bids).toEqual([
      { price: 90, quantity: 1, orders: 1 },
      { price: 80, quantity: 1, orders: 1 },
    ]);
    expect(f.runtime.lastId).toBe("2-0");
    expect(f.redis.set).toHaveBeenCalledWith(expect.any(String), "2-0");
  });

  it("does not acknowledge or process a later command after a failed commit", async () => {
    const f = fixture();
    bus.readCommands.mockResolvedValueOnce({
      nextId: "2-0",
      messages: [
        { id: "1-0", data: order() },
        { id: "2-0", data: order("later", 80) },
      ],
    });
    f.beforeCommit(async () => {
      throw new Error("rollback");
    });
    const process = vi.spyOn(f.runtime, "process");
    await f.runtime.commandLoop();
    expect(process).toHaveBeenCalledOnce();
    expect(f.commits).toEqual([]);
    expect(f.runtime.lastId).toBe("0-0");
    expect(f.redis.set).not.toHaveBeenCalled();
    expect(bus.appendEvents).not.toHaveBeenCalled();
    expect(f.runner.healthy).toBe(false);
  });

  it.each([false, true])(
    "retries minute receipts after restart, coupon already committed=%s",
    async (couponCommitted: boolean) => {
      const f = fixture(true);
      f.runtime.minuteCount = 4;
      f.engine.restoreAccount(USER, {
        cash: 1000,
        positions: [{ symbol: "A", quantity: 2, avgPrice: 100 }],
      });
      const coupon = vi.fn(async () => {
        if (couponCommitted) {
          f.engine.adjustCash(USER, 50);
          f.runtime.persistence.markUsers([USER]);
          await f.runtime.persistence.flush();
        }
        throw new Error("coupon unavailable");
      });
      f.runtime.markets = {
        stop: vi.fn(),
        payCoupons: coupon,
        bondValueOf: () => 0,
      };
      await expect(
        f.runtime.enqueue(() => f.runtime.minuteTick(START + 300_000)),
      ).rejects.toThrow("coupon unavailable");
      expect(f.tables.eventActions!.map((r) => r.actionId)).toEqual(
        couponCommitted
          ? ["minute:5:carry", "minute:5:coupons"]
          : ["minute:5:carry"],
      );
      expect(f.engine.cashOf(USER)).toBe(couponCommitted ? 1048 : 998);
      const saved = f.commits.at(-1)!;
      const recovered = fixture(true);
      Object.assign(recovered.tables, structuredClone(f.tables));
      recovered.engine.restoreState(saved.state);
      recovered.runtime.minuteCount = saved.minuteCount;
      const payCoupons = vi.fn(async () => {
        recovered.engine.adjustCash(USER, 50);
        recovered.runtime.persistence.markUsers([USER]);
        // Managers can commit inside a substep, before minuteCount advances.
        await recovered.runtime.persistence.flush();
      });
      recovered.runtime.markets = {
        stop: vi.fn(),
        payCoupons,
        bondValueOf: () => 0,
      };
      await recovered.runtime.minuteTick(START + 300_000);
      await recovered.runtime.minuteTick(START + 300_000);
      expect(recovered.engine.cashOf(USER)).toBe(1048);
      expect(payCoupons).toHaveBeenCalledTimes(couponCommitted ? 0 : 1);
      expect(recovered.tables.eventActions!.map((r) => r.actionId)).toEqual([
        "minute:5:carry",
        "minute:5:coupons",
      ]);
    },
  );

  it("catches up before each payment, then runs exact-boundary transitions with actual time", async () => {
    const f = fixture(true);
    const now = START + 125_000;
    const trace: string[] = [];
    vi.spyOn(f.runtime, "minuteTick").mockImplementation(async (at: number) => {
      trace.push(`carry:${at}`);
    });
    const tick = vi.fn(async (_now: number, through?: number) => {
      expect(f.commits.at(-1)?.minuteCount ?? 0).toBe(f.runtime.minuteCount);
      trace.push(`timeline:${through ?? "now"}`);
      return [];
    });
    f.runtime.timeline = { tick };
    await f.runtime.advanceClock(now);
    expect(trace).toEqual([
      `timeline:${START + 60_000 - 0.001}`,
      `carry:${START + 60_000}`,
      `timeline:${START + 60_000}`,
      `timeline:${START + 120_000 - 0.001}`,
      `carry:${START + 120_000}`,
      `timeline:${START + 120_000}`,
      "timeline:now",
    ]);
    expect(tick.mock.calls).toEqual([
      [now, START + 60_000 - 0.001],
      [now, START + 60_000],
      [now, START + 120_000 - 0.001],
      [now, START + 120_000],
      [now],
    ]);
  });

  it("replays pending news before auctions without using later prices or charging later carry first", async () => {
    const f = fixture(true);
    f.runtime.minuteCount = 5;
    f.engine.restoreAccount(USER, {
      cash: 1000,
      positions: [{ symbol: "A", quantity: 2, avgPrice: 100 }],
    });
    const now = START + 15 * 60_000 + 5000;
    const observed: Array<{
      kind: string;
      price: number | undefined;
      cash: number;
    }> = [];
    f.runtime.timeline = new EventTimeline({
      challengeId: "challenge",
      enabled: true,
      startsAt: START,
      // The minute checkpoint can precede the action receipt at that boundary.
      loadCompletedActionIds: async () =>
        EDEN_EVENT_ACTIONS.filter((action) => action.atSecond < 5 * 60).map(
          (action) => action.id,
        ),
      execute: async (action, context) => {
        expect(context.now).toBe(now);
        expect(context.lateByMs).toBe(now - context.scheduledAt);
        if (action.id === "eden-v1/news/5/public")
          f.engine.restorePrice("A", 110);
        if (action.id === "eden-v1/auction/15/resolve") {
          observed.push({
            kind: "auction",
            price: f.engine.getPrice("A"),
            cash: f.engine.cashOf(USER),
          });
        }
        if (action.id === "eden-v1/news/15/public") {
          observed.push({
            kind: "boundary",
            price: f.engine.getPrice("A"),
            cash: f.engine.cashOf(USER),
          });
          f.engine.restorePrice("A", 120);
        }
      },
    });
    const minuteTick = f.runtime.minuteTick.bind(f.runtime);
    vi.spyOn(f.runtime, "minuteTick").mockImplementation(async (at: number) => {
      expect(f.engine.getPrice("A")).toBe(110);
      await minuteTick(at);
    });
    await f.runtime.advanceClock(now);
    expect(observed).toEqual([
      { kind: "auction", price: 110, cash: 982 },
      { kind: "boundary", price: 110, cash: 980 },
    ]);
    expect(f.engine.getPrice("A")).toBe(120);
    expect(f.runtime.minuteCount).toBe(15);
  });

  it("invalidates ownership immediately, skips queued/new tasks, and forbids checkpoint writes", async () => {
    const f = fixture();
    const entered = deferred();
    const blocked = deferred();
    f.runtime.options = { stop: vi.fn() };
    f.runtime.markets = {
      stop: vi.fn(),
      payCoupons: vi.fn(),
      bondValueOf: () => 0,
    };
    const freeze = vi.spyOn(f.engine, "setFrozen");
    const active = f.runtime.enqueue(async () => {
      entered.resolve();
      await blocked.promise;
    });
    const rejected = expect(active).rejects.toThrow("Engine lease lost");
    const later = vi.fn(async () => {});
    const queued = f.runtime.enqueue(later);
    await entered.promise;
    f.runner.invalidateLease();
    expect(f.runner.healthy).toBe(false);
    expect(f.runtime.running).toBe(false);
    expect(freeze).toHaveBeenCalledWith(true);
    expect(f.reader.disconnect).toHaveBeenCalledOnce();
    expect(f.runtime.options.stop).toHaveBeenCalledOnce();
    expect(f.runtime.markets.stop).toHaveBeenCalledOnce();
    f.runtime.dispatch(later);
    const newWork = f.runtime.enqueue(later);
    await expect(f.runtime.persistence.flush()).rejects.toThrow(
      "Engine lease lost before checkpoint commit",
    );
    blocked.resolve();
    await rejected;
    await queued;
    await newWork;
    await f.runner.stop();
    expect(later).not.toHaveBeenCalled();
    expect(f.commits).toEqual([]);
    expect(f.transaction).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "enforces exhausted cash immediately in emit, frozen=%s",
    async (frozen: boolean) => {
      const f = fixture(true, frozen);
      f.engine.restoreAccount(USER, {
        cash: 1,
        positions: [{ symbol: "A", quantity: 2, avgPrice: 100 }],
      });
      f.engine.restoreRestingOrder("A", {
        id: "liquidity",
        userId: "bot:buyer",
        side: "buy",
        price: 100,
        remaining: 2,
        seq: 1,
      });
      f.engine.adjustCash(USER, -1);
      const place = vi.spyOn(f.engine, "placeOrder");
      const cancel = vi.spyOn(f.engine, "cancelUserOrders");
      const events: EngineEvent[] = [];
      await f.runtime.emit(events);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "margin_call", userId: USER }),
        ]),
      );
      if (frozen) {
        expect(place).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(events.some((e) => e.type === "trade")).toBe(false);
        expect(f.engine.positionOf(USER, "A")).toBe(2);
        expect(
          await f.runtime.process({
            type: "force_liquidate",
            challengeId: "challenge",
            userId: USER,
            reason: "test",
            ts: START,
          }),
        ).toEqual([]);
        expect(place).not.toHaveBeenCalled();
      } else {
        expect(events.some((e) => e.type === "trade")).toBe(true);
        expect(f.engine.positionOf(USER, "A")).toBe(0);
        expect(f.engine.cashOf(USER)).toBe(200);
      }
      expect(bus.publishBroadcast).toHaveBeenCalled();
    },
  );

  it("disconnects the blocking reader on stop and discards a late command batch", async () => {
    const f = fixture();
    const lateRead = deferred<{
      nextId: string;
      messages: { id: string; data: EngineCommand }[];
    }>();
    bus.readCommands.mockReturnValueOnce(lateRead.promise);
    const process = vi.spyOn(f.runtime, "process");
    f.runtime.commandWork = f.runtime.commandLoop();
    const stopped = f.runner.stop();
    expect(f.reader.disconnect).toHaveBeenCalledOnce();
    lateRead.resolve({
      nextId: "1-0",
      messages: [{ id: "1-0", data: order() }],
    });
    await stopped;
    expect(process).not.toHaveBeenCalled();
    expect(f.engine.snapshot("A").bids).toEqual([]);
    expect(f.runtime.lastId).toBe("0-0");
    expect(f.redis.set).not.toHaveBeenCalled();
    expect(f.transaction).toHaveBeenCalledOnce();
  });

  it("persists a host account edit in the checkpoint and notifies the trader", async () => {
    const f = fixture();
    let events: EngineEvent[] = [];
    await f.runtime.enqueue(async () => {
      events = await f.runtime.process({
        type: "admin_set_account",
        challengeId: "challenge",
        userId: USER,
        cash: 2500,
        positions: [{ symbol: "A", quantity: 7 }],
        ts: START,
      });
    });
    expect(f.tables.participants).toEqual([
      expect.objectContaining({ userId: USER, cash: 2500 }),
    ]);
    expect(f.tables.positions).toEqual([
      expect.objectContaining({ userId: USER, symbol: "A", quantity: 7, avgPrice: 100 }),
    ]);
    expect(f.commits.at(-1)!.state.accounts).toEqual([
      expect.objectContaining({ userId: USER, cash: 2500 }),
    ]);
    expect(bus.publishBroadcast).toHaveBeenCalledWith(f.redis, "challenge", [
      expect.objectContaining({
        target: USER,
        msg: expect.objectContaining({ type: "portfolio" }),
      }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "alert",
        userId: USER,
        message: "The host adjusted your account: cash 2500.00, A 7.",
      }),
    ]);
  });

  it("applies a delta account edit to the live account and reports signed changes", async () => {
    const f = fixture();
    let events: EngineEvent[] = [];
    await f.runtime.enqueue(async () => {
      await f.runtime.process({
        type: "admin_set_account",
        challengeId: "challenge",
        userId: USER,
        cash: 2500,
        positions: [{ symbol: "A", quantity: 7 }],
        ts: START,
      });
      events = await f.runtime.process({
        type: "admin_set_account",
        challengeId: "challenge",
        userId: USER,
        cashDelta: -500,
        positions: [{ symbol: "A", delta: 3 }],
        ts: START + 1,
      });
    });
    expect(f.tables.participants).toEqual([
      expect.objectContaining({ userId: USER, cash: 2000 }),
    ]);
    expect(f.tables.positions).toEqual([
      expect.objectContaining({ userId: USER, symbol: "A", quantity: 10 }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "alert",
        userId: USER,
        message: "The host adjusted your account: cash -500.00, A +3.",
      }),
    ]);
  });

  it("drops an account edit for an unknown symbol without changing the account", async () => {
    const f = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = await f.runtime.process({
      type: "admin_set_account",
      challengeId: "challenge",
      userId: USER,
      cash: 1,
      positions: [{ symbol: "NOPE", quantity: 1 }],
      ts: START,
    });
    expect(events).toEqual([]);
    expect(f.engine.accountIds()).not.toContain(USER);
    expect(f.transaction).not.toHaveBeenCalled();
  });
});

describe("playbook cue mode", () => {
  const cueMode = (receipts: string[] = []) => {
    const f = fixture(true);
    const runtime = f.runtime as unknown as {
      eden: { playbookCues?: boolean };
      configureTimeline(): Promise<void>;
    };
    runtime.eden.playbookCues = true;
    f.tables.eventActions!.push(
      ...receipts.map((actionId) => ({
        challengeId: "challenge",
        actionId,
        completedAt: new Date(START),
      })),
    );
    return { ...f, configure: () => runtime.configureTimeline() };
  };
  const runCue = (cueId: string): EngineCommand => ({
    type: "run_cue",
    challengeId: "challenge",
    cueId,
    ts: START,
  });

  it("holds the market shut until the open cue runs, and runs a cue once", async () => {
    const f = cueMode();
    await f.configure();
    expect(f.engine.exportState().frozen).toBe(true);
    await f.runtime.process(runCue("open"));
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: "eden-v1/open" }),
      expect.objectContaining({ scheduledAt: START, now: START }),
    );
    expect(f.tables.eventActions!.map((r) => r.actionId)).toEqual([
      "eden-v1/cue/open",
      "eden-v1/open",
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await f.runtime.process(runCue("open"));
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("does not re-freeze a market whose open cue already ran", async () => {
    const f = cueMode(["eden-v1/cue/open", "eden-v1/open"]);
    await f.configure();
    expect(f.engine.exportState().frozen).toBe(false);
  });
});

describe("EventTimeline catch-up boundary", () => {
  it("limits actions with through without replacing context.now with the historical boundary", async () => {
    const contexts: EventActionContext[] = [];
    const executed: string[] = [];
    const minuteMs = 1000;
    const now = START + 100 * minuteMs;
    const through = START + 15 * minuteMs;
    const timeline = new EventTimeline({
      challengeId: "challenge",
      enabled: true,
      startsAt: START,
      minuteMs,
      loadCompletedActionIds: async () => [],
      execute: async (action, context) => {
        executed.push(action.id);
        contexts.push(context);
      },
    });
    const due = EDEN_EVENT_ACTIONS.filter((a) => a.atSecond <= 15 * 60);
    expect(await timeline.tick(now, through)).toEqual(due.map((a) => a.id));
    expect(contexts.length).toBeGreaterThan(0);
    for (const [index, context] of contexts.entries()) {
      expect(context.now).toBe(now);
      expect(context.scheduledAt).toBe(
        START + due[index]!.atSecond * (minuteMs / 60),
      );
      expect(context.lateByMs).toBe(now - context.scheduledAt);
    }
    expect(await timeline.tick(now, through)).toEqual([]);
    await timeline.tick(now);
    expect(executed).toEqual(
      EDEN_EVENT_ACTIONS.filter((a) => a.atSecond <= 100 * 60).map((a) => a.id),
    );
  });
});
