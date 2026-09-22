import { afterEach, beforeEach, describe, expect, it, vi } from "../../../packages/core/node_modules/vitest/dist/index.js";

type Row = {
  id: string;
  status: string;
  startsAt: Date | null;
  endsAt: Date | null;
  finalizedAt: Date | null;
};
type Predicate = (row: Row) => boolean;

const now = new Date("2026-09-22T12:00:00Z");
let rows: Row[];
let instances: FakeRunner[];
let start: (runner: FakeRunner) => Promise<void>;
let finish: (runner: FakeRunner) => Promise<void>;
let stop: (runner: FakeRunner) => Promise<void>;
let locks: Map<string, string>;
let active: Set<string>;
let calls: string[];
let failRefresh: boolean;

class FakeRunner {
  healthy = true;
  invalidateLease = vi.fn(() => {
    calls.push(`invalidate:${this.row.id}`);
    this.healthy = false;
  });
  start = vi.fn(async () => { calls.push(`start:${this.row.id}`); await start(this); });
  finish = vi.fn(async () => { calls.push(`finish:${this.row.id}`); await finish(this); });
  stop = vi.fn(async (persist: boolean) => {
    calls.push(`stop:${this.row.id}:${persist}`);
    await stop(this);
  });
  constructor(_redis: unknown, _db: unknown, readonly row: Row) { instances.push(this); }
}

function row(overrides: Partial<Row> = {}): Row {
  return { id: "challenge", status: "live", startsAt: now, endsAt: null, finalizedAt: null, ...overrides };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function boot() {
  await import("./index.js");
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "on").mockImplementation(() => process);
  vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("unexpected exit"); });
  rows = [row()];
  instances = [];
  locks = new Map();
  active = new Set();
  calls = [];
  failRefresh = false;
  start = async () => {};
  stop = async () => {};
  finish = async (runner) => {
    Object.assign(rows.find((r) => r.id === runner.row.id)!, { status: "ended", finalizedAt: new Date() });
    calls.push(`finalized:${runner.row.id}`);
  };
  vi.doMock("./env.js", () => ({ env: { redisUrl: "redis://unused", instanceId: "owner" } }));
  vi.doMock("./runner.js", () => ({ ChallengeRunner: FakeRunner }));
  vi.doMock("../node_modules/drizzle-orm/index.js", () => ({
    eq: (column: keyof Row, value: unknown): Predicate => (r) => r[column] === value,
    and: (...predicates: Predicate[]): Predicate => (r) => predicates.every((p) => p(r)),
  }));
  vi.doMock("../../../packages/db/dist/index.js", () => ({
    challenges: { id: "id", status: "status" },
    getDb: () => ({
      select: () => ({ from: () => {
        const result = Promise.resolve(structuredClone(rows));
        return Object.assign(result, {
          where: async (predicate: Predicate) => structuredClone(rows.filter(predicate)),
        });
      } }),
      update: () => ({ set: (values: Partial<Row>) => ({ where: (predicate: Predicate) => ({
        returning: async () => rows.filter(predicate).map((r) => {
          calls.push(`status:${values.status}`);
          Object.assign(r, values);
          return structuredClone(r);
        }),
      }) }) }),
    }),
  }));
  vi.doMock("../../../packages/bus/dist/index.js", () => ({
    createRedis: () => ({
      eval: vi.fn(async (script: string, count: number, key: string, owner: string) => {
        expect(script).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
        expect(count).toBe(1);
        const id = key.replace("qtp:lock:engine:", "");
        calls.push(`release:${id}`);
        if (locks.get(id) === owner) locks.delete(id);
      }),
      quit: vi.fn(),
    }),
    acquireEngineLock: async (_redis: unknown, id: string, owner: string) => {
      if (locks.has(id)) return false;
      locks.set(id, owner);
      return true;
    },
    refreshEngineLock: async (_redis: unknown, id: string, owner: string) => {
      if (failRefresh) throw new Error("redis unavailable");
      calls.push(`refresh:${id}`);
      return locks.get(id) === owner;
    },
    markChallengeActive: async (_redis: unknown, id: string) => { active.add(id); },
    markChallengeInactive: async (_redis: unknown, id: string) => {
      calls.push(`inactive:${id}`);
      active.delete(id);
    },
  }));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("engine reconciliation", () => {
  it("starts expired live challenges before finalizing and removing active scoring", async () => {
    rows = [row({ endsAt: new Date(now.getTime() - 1000) })];
    await boot();
    expect(calls.filter((call) => !call.startsWith("refresh:") && !call.startsWith("release:")))
      .toEqual(["start:challenge", "finish:challenge", "finalized:challenge", "stop:challenge:true", "inactive:challenge"]);
    expect(rows[0]!.finalizedAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(6000);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.finish).toHaveBeenCalledTimes(1);
  });

  it("lets start catch up an elapsed schedule and does not reactivate its final result", async () => {
    rows = [row({ status: "scheduled", endsAt: new Date(now.getTime() - 1000) })];
    start = async (runner) => { await finish(runner); };
    await boot();
    expect(calls[0]).toBe("status:live");
    expect(instances).toHaveLength(1);
    expect(instances[0]!.finish).not.toHaveBeenCalled();
    expect(active.size).toBe(0);
  });

  it("does not start schedules whose start time is still in the future", async () => {
    rows = [row({ status: "scheduled", startsAt: new Date(now.getTime() + 60_000) })];
    await boot();
    expect(instances).toHaveLength(0);
    expect(rows[0]!.status).toBe("scheduled");
  });

  it("finishes quiet live runners when their deadline passes", async () => {
    rows = [row({ endsAt: new Date(now.getTime() + 1000) })];
    await boot();
    expect(active.has("challenge")).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(instances[0]!.finish).toHaveBeenCalledOnce();
    expect(active.size).toBe(0);
  });

  it("finalizes an admin-ended runner before stopping it", async () => {
    await boot();
    rows[0]!.status = "ended";
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.indexOf("finalized:challenge")).toBeLessThan(calls.indexOf("stop:challenge:true"));
    expect(active.size).toBe(0);
  });

  it("recovers ended rows with no previous runner and retries failed finalization", async () => {
    rows = [row({ status: "ended" })];
    active.add("challenge");
    const succeed = finish;
    finish = async (runner) => {
      if (instances.length === 1) { runner.healthy = false; throw new Error("score write failed"); }
      await succeed(runner);
    };
    await boot();
    expect(instances[0]!.stop).toHaveBeenCalledWith(false);
    expect(active.has("challenge")).toBe(true);
    expect(rows[0]!.finalizedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(instances).toHaveLength(2);
    expect(rows[0]!.finalizedAt).not.toBeNull();
    expect(active.size).toBe(0);
  });

  it("does not construct runners for finalized rows", async () => {
    rows = [row({ status: "ended", finalizedAt: now })];
    active.add("challenge");
    await boot();
    expect(instances).toHaveLength(0);
    expect(active.size).toBe(0);
  });

  it("stops paused runners without finalizing", async () => {
    await boot();
    rows[0]!.status = "paused";
    await vi.advanceTimersByTimeAsync(3000);
    expect(instances[0]!.finish).not.toHaveBeenCalled();
    expect(instances[0]!.stop).toHaveBeenCalledOnce();
    expect(instances[0]!.stop).toHaveBeenCalledWith(true);
    expect(active.size).toBe(0);
  });

  it("replaces unhealthy runners only after a non-persisting stop", async () => {
    await boot();
    instances[0]!.healthy = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(instances).toHaveLength(2);
    expect(instances[0]!.stop).toHaveBeenCalledWith(false);
    expect(calls.indexOf("stop:challenge:false")).toBeLessThan(calls.lastIndexOf("start:challenge"));
  });

  it("cleans up failed starts without flushing or marking inactive", async () => {
    start = async () => { throw new Error("restore failed"); };
    await boot();
    expect(instances[0]!.stop).toHaveBeenCalledWith(false);
    expect(locks.size).toBe(0);
    expect(calls).not.toContain("inactive:challenge");
  });

  it("renews during long starts without overlapping reconciliation", async () => {
    const pending = deferred();
    start = () => pending.promise;
    await boot();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(instances).toHaveLength(1);
    expect(calls.filter((call) => call === "refresh:challenge")).toHaveLength(4);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(active.has("challenge")).toBe(true);
  });

  it("does not release another owner's lock or replace a runner before its lost-lock stop drains", async () => {
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    const pending = deferred();
    stop = () => pending.promise;
    locks.set("challenge", "other-owner");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.stop).toHaveBeenCalledOnce();
    expect(instances[0]!.stop).toHaveBeenCalledWith(false);
    expect(locks.get("challenge")).toBe("other-owner");
    expect(instances[0]!.invalidateLease).toHaveBeenCalledOnce();
    expect(calls.indexOf("invalidate:challenge")).toBeLessThan(calls.indexOf("stop:challenge:false"));
    expect(active.has("challenge")).toBe(true);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(locks.get("challenge")).toBe("other-owner");
    expect(instances).toHaveLength(1);
  });

  it.each([false, true])("invalidates immediately during blocked startup, refresh throws=%s", async (throws: boolean) => {
    const pending = deferred();
    start = () => pending.promise;
    await boot();
    if (throws) failRefresh = true;
    else locks.set("challenge", "other-owner");
    await vi.advanceTimersByTimeAsync(4000);
    expect(instances[0]!.invalidateLease).toHaveBeenCalledOnce();
    expect(instances[0]!.healthy).toBe(false);
    expect(instances[0]!.stop).not.toHaveBeenCalled();
    expect(active.size).toBe(0);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(instances[0]!.stop).toHaveBeenCalledWith(false);
    expect(instances[0]!.finish).not.toHaveBeenCalled();
    expect(active.size).toBe(0);
    expect(locks.get("challenge")).toBe(throws ? undefined : "other-owner");
    expect(calls.indexOf("invalidate:challenge")).toBeLessThan(calls.indexOf("stop:challenge:false"));
  });

  it("retains failed drains and retries stopping before allowing replacement", async () => {
    await boot();
    instances[0]!.healthy = false;
    stop = async () => { throw new Error("drain failed"); };
    await vi.advanceTimersByTimeAsync(6000);
    expect(instances).toHaveLength(1);
    expect(locks.get("challenge")).toBe("owner");
    stop = async () => {};
    await vi.advanceTimersByTimeAsync(3000);
    expect(instances).toHaveLength(2);
  });

  it("does not start or finalize challenges owned by another engine", async () => {
    rows = [row({ status: "ended" })];
    locks.set("challenge", "other-owner");
    active.add("challenge");
    await boot();
    expect(instances).toHaveLength(0);
    expect(active.has("challenge")).toBe(true);
    expect(locks.get("challenge")).toBe("other-owner");
  });

  it("treats refresh errors as uncertain ownership and skips flushing", async () => {
    await boot();
    await vi.advanceTimersByTimeAsync(3000);
    failRefresh = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(instances[0]!.invalidateLease).toHaveBeenCalledOnce();
    expect(instances[0]!.stop).toHaveBeenCalledWith(false);
    expect(instances[0]!.finish).not.toHaveBeenCalled();
    expect(calls.indexOf("invalidate:challenge")).toBeLessThan(calls.indexOf("stop:challenge:false"));
  });
});
