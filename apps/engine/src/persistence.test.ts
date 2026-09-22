import { describe, expect, it, vi } from "../../../packages/core/node_modules/vitest/dist/index.js";
import type { ChallengeEngine } from "@qtp/core";
import type { Database } from "@qtp/db";
import type { EngineEvent } from "@qtp/shared";
import type { DbTransaction } from "./persistence.js";

vi.doMock("../../../packages/db/dist/index.js", () => {
  const table = (name: string) => ({ name, id: "id", challengeId: "challengeId" });
  return Object.fromEntries(
    ["trades", "orders", "participants", "positions", "engineCheckpoints", "eventActions"]
      .map((name) => [name, table(name)]),
  );
});
vi.doMock("../node_modules/drizzle-orm/index.js", () => ({
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));

const { Persistence } = await import("./persistence.js");

const userId = "00000000-0000-0000-0000-000000000001";
const orderId = "00000000-0000-0000-0000-000000000002";

function events(quantity: number): EngineEvent[] {
  return [
    {
      type: "trade", challengeId: "challenge", symbol: "A", price: 10,
      quantity, takerSide: "buy", buyOrderId: orderId, sellOrderId: "bot-order",
      buyerId: userId, sellerId: "bot", ts: quantity,
    },
    {
      type: "order_update", challengeId: "challenge", userId, orderId,
      status: quantity === 1 ? "partially_filled" : "filled",
      remainingQuantity: quantity === 1 ? 1 : 0, ts: quantity,
    },
  ] as EngineEvent[];
}

interface Write {
  table: string;
  values: any;
  conflict?: any;
}

function fixture() {
  const state = {
    version: 1,
    config: { startingCash: 5000 },
    accounts: [{ userId, cash: 4000, loanDebt: 100,
      positions: [{ symbol: "A", quantity: 2, avgPrice: 10 }] }],
    symbols: [{ symbol: "A", orders: [{ id: orderId }] }],
    options: [{ symbol: "A-CALL" }],
    prices: { A: 10 }, fairValues: { A: 11 }, frozen: true,
    seq: 9, bookSequence: 4, closedSymbols: ["OLD"], cancelledIds: ["cancelled"],
    volatilityMultiplier: 2,
  };
  const engine = {
    exportState: vi.fn(() => structuredClone(state)),
    cashOf: () => state.accounts[0]!.cash,
    loanDebtOf: () => state.accounts[0]!.loanDebt,
    allPositions: () => structuredClone(state.accounts[0]!.positions),
  };
  const committed: Write[][] = [];
  let beforeTransaction: (() => Promise<void>) | undefined;
  const transaction = vi.fn(async (run: (tx: DbTransaction) => Promise<void>) => {
    await beforeTransaction?.();
    const writes: Write[] = [];
    const tx = {
      insert: (table: { name: string }) => ({
        values: (values: unknown) => {
          const write: Write = { table: table.name, values: structuredClone(values) };
          writes.push(write);
          return {
            onConflictDoUpdate: (conflict: unknown) => { write.conflict = conflict; },
            onConflictDoNothing: () => { write.conflict = "nothing"; },
          };
        },
      }),
      update: (table: { name: string }) => ({
        set: (values: unknown) => ({
          where: () => { writes.push({ table: table.name, values }); },
        }),
      }),
    } as unknown as DbTransaction;
    await run(tx);
    committed.push(writes);
  });
  const persistence = new Persistence(
    { transaction } as unknown as Database,
    "challenge",
    engine as unknown as ChallengeEngine,
  );
  return { persistence, engine, state, committed, transaction,
    before: (callback: () => Promise<void>) => { beforeTransaction = callback; } };
}

describe("Persistence", () => {
  it.each(["before", "during"])("rejects and rolls back when ownership is lost %s the transaction", async (when: string) => {
    const f = fixture();
    let held = true;
    const guard = vi.fn(() => { if (!held) throw new Error("lease lost"); });
    f.persistence.setCommitGuard(guard);
    f.persistence.collect(events(1));
    if (when === "before") f.before(async () => { held = false; });
    const write = vi.fn(async () => { if (when === "during") held = false; });
    f.persistence.queueWrite(write);
    await expect(f.persistence.flush({ cursor: "1-0", receipt: "action" })).rejects.toThrow("lease lost");
    expect(f.committed).toEqual([]);
    expect(write).toHaveBeenCalledTimes(when === "during" ? 1 : 0);
    expect(guard).toHaveBeenCalledTimes(when === "during" ? 2 : 1);
    // A second flush must still consult ownership, not commit restored buffers.
    await expect(f.persistence.flush({ cursor: "2-0" })).rejects.toThrow("lease lost");
    expect(f.committed).toEqual([]);
    expect(write).toHaveBeenCalledTimes(when === "during" ? 1 : 0);
  });

  it("always checkpoints the complete state and only updates supplied metadata", async () => {
    const f = fixture();
    await f.persistence.flush({ cursor: "10-0", minuteCount: 0, receipt: "action" });
    const checkpoint = f.committed[0]!.find((w) => w.table === "engineCheckpoints")!;
    expect(checkpoint.values.state).toEqual(f.state);
    expect(checkpoint.conflict.set).toMatchObject({ cursor: "10-0", minuteCount: 0 });
    expect(f.committed[0]!.find((w) => w.table === "eventActions")).toMatchObject({
      values: { challengeId: "challenge", actionId: "action" }, conflict: "nothing",
    });
    await f.persistence.flush();
    const next = f.committed[1]![0]!;
    expect(next.table).toBe("engineCheckpoints");
    expect(next.values.state).toEqual(f.state);
    expect(next.conflict.set).not.toHaveProperty("cursor");
    expect(next.conflict.set).not.toHaveProperty("minuteCount");
    await f.persistence.flush({ minuteCount: 2 });
    expect(f.committed[2]![0]!.conflict.set).toHaveProperty("minuteCount", 2);
    expect(f.committed[2]![0]!.conflict.set).not.toHaveProperty("cursor");
  });

  it("snapshots account values and checkpoint before asynchronous transaction work", async () => {
    const f = fixture();
    const snapshot = structuredClone(f.state);
    f.persistence.collect(events(1));
    f.before(async () => {
      f.state.accounts[0]!.cash = 50;
      f.state.accounts[0]!.loanDebt = 900;
      f.state.accounts[0]!.positions[0]!.quantity = 99;
      f.state.prices.A = 100;
    });
    const queued = vi.fn(async (_tx: DbTransaction) => {});
    const custom = vi.fn(async (_tx: DbTransaction) => {});
    f.persistence.queueWrite(queued);
    await f.persistence.flush({ write: custom });
    const writes = f.committed[0]!;
    expect(writes.find((w) => w.table === "participants")!.values).toMatchObject({
      userId, startingCash: 5000, cash: 4000, loanDebt: 100,
    });
    expect(writes.find((w) => w.table === "positions")!.values.quantity).toBe(2);
    expect(writes.find((w) => w.table === "engineCheckpoints")!.values.state).toEqual(snapshot);
    expect(queued.mock.calls[0]![0]).toBe(custom.mock.calls[0]![0]);
    expect(writes.find((w) => w.table === "trades")!.values[0].sellerId).toBeNull();
  });

  it("restores trades, latest orders, users, and callbacks in order after rollback", async () => {
    const f = fixture();
    const calls: string[] = [];
    f.persistence.collect(events(1));
    f.persistence.queueWrite(async () => { calls.push("first"); });
    let fail = true;
    await expect(f.persistence.flush({ write: async () => {
      calls.push("second");
      if (fail) {
        fail = false;
        f.persistence.collect(events(2));
        f.persistence.queueWrite(async () => { calls.push("third"); });
        throw new Error("rollback");
      }
    } })).rejects.toThrow("rollback");
    expect(f.committed).toEqual([]);
    await f.persistence.flush();
    expect(calls).toEqual(["first", "second", "first", "second", "third"]);
    const writes = f.committed[0]!;
    expect(writes.find((w) => w.table === "trades")!.values.map((t: any) => t.quantity))
      .toEqual([1, 2]);
    expect(writes.filter((w) => w.table === "orders").map((w) => w.values))
      .toEqual([{ status: "filled", remainingQuantity: 0 }]);
    expect(writes.filter((w) => w.table === "participants")).toHaveLength(1);
    await f.persistence.flush();
    expect(f.committed[1]!.map((w) => w.table)).toEqual(["engineCheckpoints"]);
  });

  it("serializes concurrent flushes and continues after a rejected transaction", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.before(() => gate);
    const first = f.persistence.flush({ cursor: "1-0", write: async () => {
      throw new Error("failed");
    } });
    const rejected = expect(first).rejects.toThrow("failed");
    const second = f.persistence.flush({ cursor: "2-0" });
    const alsoRejected = expect(second).rejects.toThrow("failed");
    await Promise.resolve();
    expect(f.transaction).toHaveBeenCalledTimes(1);
    release();
    await rejected;
    await alsoRejected;
    expect(f.transaction).toHaveBeenCalledTimes(2);
    expect(f.committed).toEqual([]);
  });

  it("retains buffers if exporting the checkpoint throws", async () => {
    const f = fixture();
    f.persistence.collect(events(1));
    f.engine.exportState.mockImplementationOnce(() => { throw new Error("snapshot"); });
    const write = vi.fn(async () => {});
    await expect(f.persistence.flush({ write })).rejects.toThrow("snapshot");
    expect(f.transaction).not.toHaveBeenCalled();
    await f.persistence.flush();
    expect(write).toHaveBeenCalledTimes(1);
    expect(f.committed[0]!.map((w) => w.table))
      .toEqual(["trades", "orders", "participants", "positions", "engineCheckpoints"]);
  });
});
