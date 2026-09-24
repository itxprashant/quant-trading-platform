import { afterEach, describe, expect, it, vi } from "vitest";
import { ChallengeEngine } from "./engine.js";
import { OptionsManager } from "../../../apps/engine/src/options-manager.js";
import { MarketsManager } from "../../../apps/engine/src/markets-manager.js";
import { EdenBotEngine } from "../../../apps/engine/src/eden-bots.js";
import {
  setBookSnapshot,
  setEtfWindow,
  setPrice,
} from "../../bus/dist/index.js";

vi.mock("../../bus/dist/index.js", () => ({
  addListedSymbol: vi.fn(),
  publishBroadcast: vi.fn(),
  removeListedSymbol: vi.fn(),
  setBookSnapshot: vi.fn(),
  setFairValue: vi.fn(),
  setOptionContracts: vi.fn(),
  setPrice: vi.fn(),
  getEtfWindows: vi.fn(),
  isEtfWindowOpen: vi.fn(async () => true),
  setEtfWindow: vi.fn(),
}));
vi.mock("../../db/dist/index.js", () => ({
  optionCycles: {
    name: "cycles",
    id: "id",
    challengeId: "challengeId",
    status: "status",
  },
  optionContracts: { name: "contracts", cycleId: "cycleId" },
  bondHoldings: {
    name: "holdings",
    id: "id",
    challengeId: "challengeId",
    userId: "userId",
    bondId: "bondId",
  },
}));
vi.mock("../../../apps/engine/node_modules/drizzle-orm/index.js", () => ({
  eq: (key: string, value: unknown) => (row: any) => row[key] === value,
  inArray: (key: string, values: unknown[]) => (row: any) =>
    values.includes(row[key]),
  and:
    (...filters: any[]) =>
    (row: any) =>
      filters.every((f) => f(row)),
}));

const symbols = [
  { symbol: "A", initialPrice: 100, volatility: 2, tickSize: 1 },
];
function makeEngine() {
  return new ChallengeEngine({
    challengeId: "eden",
    symbols,
    startingCash: 10000,
    minPosition: -10000,
    maxPosition: 10000,
    positionCap: 100,
    maxOrderQuantity: 50,
    allowMargin: true,
  });
}
function fixtures() {
  const tables: Record<string, any[]> = {
    cycles: [],
    contracts: [],
    holdings: [],
  };
  let seq = 0;
  const db = {
    transaction: async (write: (tx: any) => Promise<void>) => {
      const before = structuredClone(tables);
      try {
        await write(db);
      } catch (error) {
        for (const key of Object.keys(tables)) tables[key] = before[key]!;
        throw error;
      }
    },
    select: () => ({
      from: (table: any) => ({
        where: async (filter: any) =>
          tables[table.name]!.filter(filter).map((r) => ({ ...r })),
      }),
    }),
    insert: (table: any) => ({
      values: async (rows: any) => {
        for (const row of Array.isArray(rows) ? rows : [rows])
          tables[table.name]!.push({
            id: `row${++seq}`,
            createdAt: new Date(),
            ...row,
          });
      },
    }),
    update: (table: any) => ({
      set: (values: any) => ({
        where: async (filter: any) => {
          for (const row of tables[table.name]!.filter(filter))
            Object.assign(row, values);
        },
      }),
    }),
  };
  const hashes = new Map<string, Record<string, string>>();
  const redis = {
    hgetall: async (key: string) => hashes.get(key) ?? {},
    hset: async (key: string, field: string, value: string) => {
      hashes.set(key, { ...hashes.get(key), [field]: value });
    },
    hdel: async (key: string, field: string) => {
      const hash = hashes.get(key);
      if (hash) delete hash[field];
    },
    del: vi.fn(),
    srem: vi.fn(),
  };
  const challenge = {
    id: "eden",
    type: "new_eden",
    endsAt: new Date(Date.now() + 10 * 60_000),
    config: {
      symbols,
      eden: {
        rules: {
          enabled: true,
          loanRepayMultiplier: 2,
          marginCallThreshold: 0,
          forcedLiquidation: true,
          costOfCarryPerUnitPerMinute: 1,
          positionCap: 100,
        },
      },
    },
  };
  const emit = vi.fn(async () => {});
  const refresh = vi.fn(async () => {});
  const engine = makeEngine();
  const opts = {
    enabled: true,
    underlyings: ["A"],
    cycleMinutes: 5,
    exerciseWindowSec: 999,
    autoCycle: false,
    strikeSteps: 1,
  };
  const rules = {
    enabled: true,
    positionCap: 100,
    costOfCarryPerUnitPerMinute: 1,
    loanRepayMultiplier: 2,
    marginCallThreshold: 0,
    forcedLiquidation: true,
  };
  const manager = (autoCycle = false) =>
    new OptionsManager(
      engine,
      redis as any,
      db as any,
      challenge as any,
      { ...opts, autoCycle },
      rules,
      60_000,
      emit,
      refresh,
    );
  return {
    tables,
    db,
    redis,
    hashes,
    challenge,
    emit,
    refresh,
    engine,
    manager,
  };
}
afterEach(() => vi.useRealTimers());

function queuedPersistence(f: ReturnType<typeof fixtures>) {
  const writes: Array<(tx: any) => Promise<void>> = [];
  const users = new Set<string>();
  const commits: Array<{
    state: ReturnType<ChallengeEngine["exportState"]>;
    users: string[];
    tables: Record<string, any[]>;
  }> = [];
  const beforeCommit = vi.fn(async () => {});
  const beforeEmit = vi.fn();
  const flush = async () => {
    const state = f.engine.exportState();
    const marked = [...users];
    await f.db.transaction(async (tx) => {
      for (const write of writes) await write(tx);
      await beforeCommit();
    });
    commits.push({ state, users: marked, tables: structuredClone(f.tables) });
    writes.length = 0;
    users.clear();
  };
  f.emit.mockImplementation(async () => {
    beforeEmit();
    await flush();
  });
  return {
    hook: {
      queueWrite: (write: (tx: any) => Promise<void>) => {
        writes.push(write);
      },
      markUsers: (ids: string[]) => {
        for (const id of ids) users.add(id);
      },
    },
    writes,
    users,
    commits,
    beforeCommit,
    beforeEmit,
    flush,
  };
}

describe("manager checkpoint transactions", () => {
  const standard = {
    id: "standard",
    name: "Standard",
    price: 1000,
    faceValue: 2000,
    maxPerUser: 1,
    payoutMultiplier: 2,
  };
  const PRICE = 10_001;

  it("queues a once-only purchase and marks the buyer before the first alert checkpoint", async () => {
    const f = fixtures();
    const p = queuedPersistence(f);
    const manager = new MarketsManager(
      f.engine,
      f.redis as any,
      f.db as any,
      f.challenge as any,
      [standard],
      [],
      60000,
      f.emit,
      f.refresh,
    );
    manager.setPersistence(p.hook);
    await manager.start();
    p.beforeEmit.mockImplementationOnce(() => {
      expect(f.tables.holdings).toHaveLength(0);
      expect(p.writes).toHaveLength(1);
      expect([...p.users]).toEqual(["buyer"]);
      expect(f.engine.cashOf("buyer")).toBe(10000 - PRICE);
    });
    await manager.purchaseBond("buyer", "standard", PRICE, 1);
    expect(p.commits[0]!.tables.holdings![0]).toMatchObject({
      quantity: 1,
      price: PRICE,
      faceValue: PRICE * 2,
    });
    expect(
      p.commits[0]!.state.accounts.find((a) => a.userId === "buyer")!.cash,
    ).toBe(10000 - PRICE);
    await manager.purchaseBond("buyer", "standard", PRICE + 1, 2);
    expect(p.commits).toHaveLength(2);
    expect(f.tables.holdings).toHaveLength(1);
    expect(f.engine.cashOf("buyer")).toBe(10000 - PRICE);
    manager.stop();
  });

  it("rolls back a failed purchase commit and retries the queued write without charging twice", async () => {
    const f = fixtures();
    const p = queuedPersistence(f);
    const manager = new MarketsManager(
      f.engine,
      f.redis as any,
      f.db as any,
      f.challenge as any,
      [standard],
      [],
      60000,
      f.emit,
      f.refresh,
    );
    manager.setPersistence(p.hook);
    await manager.start();
    p.beforeCommit.mockRejectedValueOnce(new Error("checkpoint write failed"));
    await expect(
      manager.purchaseBond("buyer", "standard", PRICE, 1),
    ).rejects.toThrow("checkpoint write failed");
    expect(f.tables.holdings).toHaveLength(0);
    expect(p.commits).toHaveLength(0);
    expect(p.writes).toHaveLength(1);
    expect(p.users.has("buyer")).toBe(true);
    expect(f.engine.cashOf("buyer")).toBe(10000 - PRICE);
    await p.flush();
    expect(p.commits[0]!.tables.holdings![0].quantity).toBe(1);
    expect(
      p.commits[0]!.state.accounts.find((a) => a.userId === "buyer")!.cash,
    ).toBe(10000 - PRICE);
    expect(manager.bondValueOf("buyer")).toBe(PRICE);
    manager.stop();
  });

  it("refuses a price that does not exceed free cash", async () => {
    const f = fixtures();
    const manager = new MarketsManager(
      f.engine,
      f.redis as any,
      f.db as any,
      f.challenge as any,
      [standard],
      [],
      60000,
      f.emit,
      f.refresh,
    );
    await manager.start();
    await manager.purchaseBond("buyer", "standard", 10_000, 1);
    expect(f.engine.cashOf("buyer")).toBe(10000);
    expect(f.tables.holdings).toHaveLength(0);
    expect(manager.bondValueOf("buyer")).toBe(0);
    expect(f.emit).toHaveBeenCalledWith([
      expect.objectContaining({
        type: "alert",
        userId: "buyer",
        message: expect.stringContaining("Price must exceed free cash"),
      }),
    ]);
    manager.stop();
  });

  it("queues all payout rows and marks every recipient before the first emit", async () => {
    const f = fixtures();
    const p = queuedPersistence(f);
    const now = Date.now();
    f.challenge.endsAt = new Date(now + 10 * 60_000);
    f.tables.holdings!.push(
      {
        id: "h1",
        challengeId: "eden",
        userId: "one",
        bondId: "standard",
        name: "Standard",
        quantity: 1,
        price: 1000,
        faceValue: 2000,
        couponsPaid: 0,
      },
      {
        id: "h2",
        challengeId: "eden",
        userId: "two",
        bondId: "standard",
        name: "Standard",
        quantity: 1,
        price: 1000,
        faceValue: 2000,
        couponsPaid: 0,
      },
    );
    const manager = new MarketsManager(
      f.engine,
      f.redis as any,
      f.db as any,
      f.challenge as any,
      [standard],
      [],
      60000,
      f.emit,
      f.refresh,
    );
    manager.setPersistence(p.hook);
    await manager.start();
    p.beforeEmit.mockImplementation(() => {
      expect(f.tables.holdings!.map((r) => r.couponsPaid)).toEqual([0, 0]);
      expect([...p.users].sort()).toEqual(["one", "two"]);
      expect(f.engine.cashOf("one")).toBe(10200);
      expect(f.engine.cashOf("two")).toBe(10200);
    });
    await manager.payCoupons(now);
    expect(p.commits).toHaveLength(1);
    expect(p.commits[0]!.tables.holdings!.map((r) => r.couponsPaid)).toEqual([
      200, 200,
    ]);
    expect(p.commits[0]!.users.sort()).toEqual(["one", "two"]);
    manager.stop();
  });

  it("does not mutate standalone balances if its direct DB transaction fails", async () => {
    const f = fixtures();
    const manager = new MarketsManager(
      f.engine,
      f.redis as any,
      f.db as any,
      f.challenge as any,
      [standard],
      [],
      60000,
      f.emit,
      f.refresh,
    );
    await manager.start();
    vi.spyOn(f.db, "transaction").mockRejectedValueOnce(
      new Error("DB unavailable"),
    );
    await expect(
      manager.purchaseBond("buyer", "standard", PRICE, 1),
    ).rejects.toThrow("DB unavailable");
    expect(f.engine.cashOf("buyer")).toBe(10000);
    expect(manager.bondValueOf("buyer")).toBe(0);
    expect(f.emit).not.toHaveBeenCalled();
    manager.stop();
  });

  it("rolls back every payout row if the checkpoint commit fails", async () => {
    const f = fixtures();
    const p = queuedPersistence(f);
    const now = Date.now();
    f.challenge.endsAt = new Date(now + 10 * 60_000);
    f.tables.holdings!.push(
      {
        id: "h1",
        challengeId: "eden",
        userId: "one",
        bondId: "standard",
        name: "Standard",
        quantity: 1,
        price: 1000,
        faceValue: 2000,
        couponsPaid: 0,
      },
      {
        id: "h2",
        challengeId: "eden",
        userId: "two",
        bondId: "standard",
        name: "Standard",
        quantity: 1,
        price: 1000,
        faceValue: 2000,
        couponsPaid: 0,
      },
    );
    const manager = new MarketsManager(
      f.engine,
      f.redis as any,
      f.db as any,
      f.challenge as any,
      [standard],
      [],
      60000,
      f.emit,
      f.refresh,
    );
    manager.setPersistence(p.hook);
    await manager.start();
    p.beforeCommit.mockRejectedValueOnce(new Error("checkpoint write failed"));
    await expect(manager.payCoupons(now)).rejects.toThrow(
      "checkpoint write failed",
    );
    expect(p.commits).toHaveLength(0);
    expect(f.tables.holdings!.map((r) => r.couponsPaid)).toEqual([0, 0]);
    expect([...p.users].sort()).toEqual(["one", "two"]);
    await p.flush();
    expect(p.commits[0]!.tables.holdings!.map((r) => r.couponsPaid)).toEqual([
      200, 200,
    ]);
    expect(p.commits[0]!.state.accounts.map((a) => a.cash)).toEqual([
      10200, 10200,
    ]);
    manager.stop();
  });

  it.each([false, true])(
    "commits complete option expiry, projections and delisting at its first emit (final=%s)",
    async (final) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const f = fixtures();
      const p = queuedPersistence(f);
      const manager = f.manager();
      manager.setPersistence(p.hook);
      await manager.start();
      p.beforeEmit.mockImplementationOnce(() => {
        expect(f.tables.cycles).toHaveLength(0);
        expect(f.tables.contracts).toHaveLength(0);
        expect(f.engine.optionSymbols()).toHaveLength(6);
      });
      await manager.openOn("A");
      expect(p.commits[0]!.tables.cycles).toHaveLength(1);
      expect(p.commits[0]!.tables.contracts).toHaveLength(6);
      const contracts = manager.contractsSnapshot();
      const cycleId = contracts[0]!.cycleId;
      f.engine.restoreAccount("buyer", {
        cash: 100,
        positions: contracts.map((c) => ({
          symbol: c.symbol,
          quantity: 1,
          avgPrice: 5,
        })),
      });
      f.engine.restoreAccount("bot:writer", {
        cash: 100,
        positions: contracts.map((c) => ({
          symbol: c.symbol,
          quantity: -1,
          avgPrice: 5,
        })),
      });
      if (!final) {
        vi.setSystemTime(1_300_000);
        p.beforeEmit.mockImplementationOnce(() => {
          expect(f.tables.cycles![0].status).toBe("open");
          expect(p.writes).toHaveLength(1);
          expect(contracts.every((c) => !f.engine.isSymbolOpen(c.symbol))).toBe(
            true,
          );
        });
        await manager.close(cycleId);
        expect(p.commits.at(-1)!.tables.cycles![0].status).toBe(
          "exercise_window",
        );
        vi.setSystemTime(1_315_000);
      }
      p.beforeEmit.mockImplementationOnce(() => {
        expect(f.tables.cycles![0].status).toBe(
          final ? "open" : "exercise_window",
        );
        expect(p.writes).toHaveLength(1);
        expect([...p.users].sort()).toEqual(["bot:writer", "buyer"]);
        expect(f.engine.optionSymbols()).toEqual([]);
        expect(
          contracts.every(
            (c) =>
              f.engine.positionOf("buyer", c.symbol) === 0 &&
              f.engine.positionOf("bot:writer", c.symbol) === 0,
          ),
        ).toBe(true);
      });
      if (final) await manager.expireAll(Date.now());
      else await manager.expire(cycleId);
      const commit = p.commits.at(-1)!;
      expect(commit.tables.cycles![0].status).toBe("expired");
      expect(
        commit.tables.contracts!.every((c) => c.status === "expired"),
      ).toBe(true);
      expect(commit.state.options).toEqual([]);
      expect(
        commit.state.accounts.every((a) =>
          a.positions.every((pos) => pos.quantity === 0),
        ),
      ).toBe(true);
      manager.stop();
    },
  );

  it("marks ETF basket projections before the success alert", async () => {
    const f = fixtures();
    const p = queuedPersistence(f);
    const manager = new MarketsManager(
      f.engine,
      f.redis as any,
      f.db as any,
      f.challenge as any,
      [],
      [{ symbol: "ETF", basket: [{ symbol: "A", weight: 2 }] }],
      60000,
      f.emit,
      f.refresh,
    );
    manager.setPersistence(p.hook);
    await manager.start();
    f.engine.restoreAccount("buyer", {
      cash: 1000,
      positions: [{ symbol: "A", quantity: 2, avgPrice: 100 }],
    });
    p.beforeEmit.mockImplementation(() =>
      expect([...p.users]).toEqual(["buyer"]),
    );
    await manager.etfTrade("buyer", "ETF", "create", 1, 1);
    expect(
      p.commits[0]!.state.accounts.find((a) => a.userId === "buyer")!.positions,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: "A", quantity: 0 }),
        expect.objectContaining({ symbol: "ETF", quantity: 1 }),
      ]),
    );
    manager.stop();
  });
});

describe("option lifecycle and assignment", () => {
  it("supports a checkpointed one-shot event hedge without shifting normal cycles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const f = fixtures();
    const manager = f.manager(true);
    await manager.start();
    const releaseAt = Date.now() + 300_000;
    await vi.advanceTimersByTimeAsync(240_000);
    await manager.openOn("A", releaseAt + 60_000);
    const supplemental = f.engine
      .optionMetas()
      .filter((m) => m.autoRoll === false);
    expect(supplemental).toHaveLength(6);
    const bots = new EdenBotEngine(
      f.engine,
      {
        hftMarketMakers: 0,
        momentumTraders: 0,
        vegaSnipers: 1,
        parityArbers: 0,
        quoteSize: 10,
        spread: 1,
        intensity: 1,
      },
      symbols,
    );
    bots.prepareVolEvent("A", releaseAt, Date.now());
    const buys = bots.act(Date.now()).places;
    expect(buys).toHaveLength(2);
    for (const buy of buys) {
      expect(supplemental.some((m) => m.symbol === buy.symbol)).toBe(true);
      f.engine.placeOrder({
        ...buy,
        orderId: `maker:${buy.symbol}`,
        userId: "bot:hft:0",
        side: "sell",
        orderType: "limit",
        quantity: 5,
        price: 10,
      });
      f.engine.placeOrder(buy);
    }
    manager.stop();
    f.engine.restoreState(JSON.parse(JSON.stringify(f.engine.exportState())));
    const restarted = f.manager(true);
    await restarted.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      f.engine
        .optionMetas()
        .filter((m) => m.autoRoll && m.openedAt === releaseAt),
    ).toHaveLength(6);
    const dumps = bots.act(Date.now()).places;
    expect(dumps).toHaveLength(2);
    expect(
      dumps.every((p) => p.side === "sell" && f.engine.isSymbolOpen(p.symbol)),
    ).toBe(true);
    for (const dump of dumps) {
      f.engine.placeOrder({
        ...dump,
        orderId: `bid:${dump.symbol}`,
        userId: "bot:hft:0",
        side: "buy",
        orderType: "limit",
        quantity: dump.quantity,
        price: 10,
      });
      f.engine.placeOrder(dump);
      expect(f.engine.positionOf(dump.userId, dump.symbol)).toBe(0);
    }
    await vi.advanceTimersByTimeAsync(75_000);
    expect(f.engine.optionMetas().some((m) => m.autoRoll === false)).toBe(
      false,
    );
    expect(f.tables.cycles).toHaveLength(3);
    restarted.stop();
  });
  it("starts from checkpoint option metadata without overwriting books, marks or cycles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const f = fixtures();
    const initial = f.manager();
    await initial.start();
    await initial.openOn("A");
    const contract = initial.contractsSnapshot()[0]!;
    f.engine.placeOrder({
      orderId: "saved",
      userId: "bot:hft:0",
      symbol: contract.symbol,
      side: "sell",
      orderType: "limit",
      price: 20,
      quantity: 5,
      ts: Date.now(),
    });
    f.engine.setPrice(contract.symbol, 17);
    f.engine.setFairValue(contract.symbol, 19);
    initial.stop();
    const state = JSON.parse(JSON.stringify(f.engine.exportState()));
    f.engine.restoreState(state);
    f.tables.cycles![0].expiresAt = new Date(Date.now() - 100000);
    f.tables.contracts![0].strike = 999;
    const restarted = f.manager();
    await restarted.start();
    expect(f.engine.exportState()).toEqual(state);
    expect(restarted.contractsSnapshot()).toEqual(initial.contractsSnapshot());
    restarted.stop();
  });

  it("does not resurrect DB option cycles absent from an authoritative checkpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const f = fixtures();
    const initial = f.manager();
    await initial.start();
    await initial.openOn("A");
    initial.stop();
    f.engine.restoreState(makeEngine().exportState());
    const restarted = f.manager();
    await restarted.start();
    expect(restarted.contractsSnapshot()).toEqual([]);
    expect(f.engine.optionSymbols()).toEqual([]);
    restarted.stop();
  });

  it("expires all options at final shutdown, including after stop, with no rollover", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const f = fixtures();
    const manager = f.manager(true);
    await manager.start();
    const contract = manager.contractsSnapshot()[0]!;
    f.engine.restoreAccount("buyer", {
      cash: 100,
      positions: [{ symbol: contract.symbol, quantity: 2, avgPrice: 5 }],
    });
    f.engine.restoreAccount("bot:writer", {
      cash: 100,
      positions: [{ symbol: contract.symbol, quantity: -2, avgPrice: 5 }],
    });
    f.engine.placeOrder({
      orderId: "rest",
      userId: "buyer",
      symbol: contract.symbol,
      side: "buy",
      orderType: "limit",
      price: 1,
      quantity: 1,
      ts: Date.now(),
    });
    manager.stop();
    await manager.expireAll(Date.now());
    expect(f.engine.optionSymbols()).toEqual([]);
    expect(f.engine.positionOf("buyer", contract.symbol)).toBe(0);
    expect(f.engine.positionOf("bot:writer", contract.symbol)).toBe(0);
    expect(f.engine.cashOf("buyer") + f.engine.cashOf("bot:writer")).toBe(200);
    expect(f.engine.openOrderCount("buyer")).toBe(0);
    expect(f.tables.cycles!.every((c) => c.status === "expired")).toBe(true);
    expect(f.tables.contracts!.every((c) => c.status === "expired")).toBe(true);
    await manager.expireAll(Date.now());
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.tables.cycles).toHaveLength(1);
    expect(manager.contractsSnapshot()).toEqual([]);
  });
  it("starts the next cycle at expiry, cancels the old book, and rejects late exercise", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const f = fixtures();
    const manager = f.manager(true);
    await manager.start();
    const first = manager.contractsSnapshot()[0]!;
    f.engine.placeOrder({
      orderId: "rest",
      userId: "u",
      symbol: first.symbol,
      side: "buy",
      orderType: "limit",
      price: 1,
      quantity: 1,
      ts: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(300_000);
    const contracts = manager.contractsSnapshot();
    expect(new Set(contracts.map((c) => c.cycleId)).size).toBe(2);
    expect(contracts.filter((c) => c.status === "open")).toHaveLength(6);
    expect(f.engine.openOrderCount("u")).toBe(0);
    expect(f.engine.isSymbolOpen(first.symbol)).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(
      manager.contractsSnapshot().some((c) => c.cycleId === first.cycleId),
    ).toBe(false);
    expect(await manager.exercise("u", first.symbol, 1, Date.now())).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "warning" })]),
    );
    manager.stop();
  });

  it("does not reset exercise deadline on restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const f = fixtures();
    const manager = f.manager();
    await manager.start();
    await manager.openOn("A");
    const contract = manager.contractsSnapshot()[0]!;
    await vi.advanceTimersByTimeAsync(305_000);
    manager.stop();
    f.engine.restoreAccount("holder", {
      cash: 100,
      positions: [{ symbol: contract.symbol, quantity: 2, avgPrice: 3 }],
    });
    const restarted = f.manager();
    await restarted.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(f.engine.positionOf("holder", contract.symbol)).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.engine.positionOf("holder", contract.symbol)).toBe(0);
    expect(f.engine.hasSymbol(contract.symbol)).toBe(false);
    restarted.stop();
  });

  it("persists a nonextendable breach deadline and preset unfavorable border price", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const f = fixtures();
    const manager = f.manager();
    await manager.start();
    await manager.openOn("A");
    const call = manager
      .contractsSnapshot()
      .find((c) => c.optionType === "call" && c.strike === 100)!;
    f.engine.setPrice("A", 110);
    f.engine.setFairValue("A", 100);
    f.engine.restoreAccount("holder", {
      cash: 10000,
      positions: [{ symbol: call.symbol, quantity: 4, avgPrice: 1 }],
    });
    f.engine.restoreAccount("seller", {
      cash: 10000,
      positions: [
        { symbol: "A", quantity: -100, avgPrice: 100 },
        { symbol: call.symbol, quantity: -4, avgPrice: 1 },
      ],
    });
    await vi.advanceTimersByTimeAsync(300_000);
    await manager.exercise("holder", call.symbol, 2, Date.now());
    const journal = f.hashes.get("qtp:assignment-breaches:eden")!;
    const deadline = JSON.parse(journal["seller:A"]!).deadline;
    await vi.advanceTimersByTimeAsync(5_000);
    await manager.exercise("holder", call.symbol, 2, Date.now());
    expect(JSON.parse(journal["seller:A"]!).deadline).toBe(deadline);
    manager.stop();
    f.engine.setFairValue("A", 500);
    const restarted = f.manager();
    await restarted.start();
    const cash = f.engine.cashOf("seller");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(f.engine.positionOf("seller", "A")).toBe(0);
    expect(f.engine.cashOf("seller")).toBe(cash - 104 * 120);
    expect(f.engine.positionOf("bot:clearing", "A")).toBe(-104);
    restarted.stop();
  });
});

describe("bond holdings", () => {
  it.each([false, true])(
    "preserves ETF checkpoint books and skips automatic windows only for eventScript=%s",
    async (eventScript) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      vi.mocked(setEtfWindow).mockClear();
      const f = fixtures();
      const etf = { symbol: "ETF", basket: [{ symbol: "A", weight: 2 }] };
      f.engine.addSymbol({
        symbol: "ETF",
        initialPrice: 200,
        volatility: 0,
        tickSize: 0.1,
      });
      f.engine.setPrice("ETF", 211);
      f.engine.setFairValue("ETF", 205);
      f.engine.placeOrder({
        orderId: "saved-etf",
        userId: "buyer",
        symbol: "ETF",
        side: "buy",
        orderType: "limit",
        quantity: 3,
        price: 190,
        ts: Date.now(),
      });
      const state = f.engine.exportState();
      f.engine.restoreState(state);
      const challenge = {
        ...f.challenge,
        config: { ...f.challenge.config, eden: { eventScript } },
      };
      const manager = new MarketsManager(
        f.engine,
        f.redis as any,
        f.db as any,
        challenge as any,
        [],
        [etf],
        60000,
        f.emit,
        f.refresh,
      );
      await manager.start();
      expect(f.engine.exportState()).toEqual(state);
      expect(setPrice).toHaveBeenLastCalledWith(
        f.redis,
        "eden",
        "ETF",
        211,
        Date.now(),
      );
      expect(setBookSnapshot).toHaveBeenLastCalledWith(f.redis, "eden", {
        symbol: "ETF",
        ...f.engine.snapshot("ETF"),
        sequence: state.bookSequence,
      });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(setEtfWindow).toHaveBeenCalledTimes(eventScript ? 0 : 1);
      manager.stop();
    },
  );
  it("serializes competing purchases and marks remaining principal across restarts", async () => {
    const f = fixtures();
    const now = Date.now();
    f.challenge.endsAt = new Date(now + 10 * 60_000);
    const bond = {
      id: "standard",
      name: "Standard",
      price: 1000,
      faceValue: 2000,
      maxPerUser: 1,
      payoutMultiplier: 2,
    };
    const manager = new MarketsManager(
      f.engine,
      f.redis as any,
      f.db as any,
      f.challenge as any,
      [bond],
      [],
      60000,
      f.emit,
      f.refresh,
    );
    await manager.start();
    await Promise.all([
      manager.purchaseBond("u", "standard", 10_001, 1),
      manager.purchaseBond("u", "standard", 10_001, 1),
    ]);
    expect(f.tables.holdings).toHaveLength(1);
    expect(f.tables.holdings![0].quantity).toBe(1);
    expect(f.engine.cashOf("u")).toBe(-1);
    expect(manager.bondValueOf("u")).toBe(10_001);
    await manager.payCoupons(now);
    expect(f.engine.cashOf("u")).toBe(-1 + 2000.2);
    expect(f.tables.holdings![0].couponsPaid).toBe(2000.2);
    manager.stop();
    await manager.start();
    expect(manager.bondValueOf("u")).toBeCloseTo(10_001 * (1 - 2000.2 / 20002));
    manager.stop();
  });
});

function botFixture(config: Record<string, number> = {}) {
  const engine = makeEngine();
  for (const type of ["call", "put"] as const) {
    const symbol = type === "call" ? "CALL" : "PUT";
    engine.addSymbol({
      symbol,
      initialPrice: 10,
      tickSize: 0.1,
      volatility: 0,
    });
    engine.registerOption({
      symbol,
      underlying: "A",
      optionType: type,
      strike: 100,
      cycleId: "cycle",
      openedAt: 0,
      expiresAt: 100_000,
    });
  }
  const bots = new EdenBotEngine(
    engine,
    {
      hftMarketMakers: 0,
      momentumTraders: 0,
      vegaSnipers: 0,
      parityArbers: 0,
      quoteSize: 10,
      spread: 1,
      intensity: 1,
      ...config,
    },
    symbols,
  );
  return { engine, bots };
}

describe("Eden bot execution", () => {
  it("does not buy volatility in a series that closes at the release", () => {
    const { bots } = botFixture({ vegaSnipers: 1 });
    bots.prepareVolEvent("A", 100_000, 40_000);
    expect(bots.act(40_000).places).toEqual([]);
  });
  it("quotes ETFs and raises both bid and ask when short", () => {
    const { engine, bots } = botFixture({ hftMarketMakers: 1 });
    engine.addSymbol({
      symbol: "ETF",
      initialPrice: 200,
      tickSize: 0.1,
      volatility: 0,
    });
    const flat = bots.act(1).places;
    expect(flat.some((p) => p.symbol === "ETF")).toBe(true);
    engine.restoreAccount("bot:hft:0", {
      cash: 10000,
      positions: [{ symbol: "A", quantity: -10, avgPrice: 100 }],
    });
    const short = bots.act(2).places;
    for (const side of ["buy", "sell"])
      expect(
        short.find((p) => p.symbol === "A" && p.side === side)!.price!,
      ).toBeGreaterThan(
        flat.find((p) => p.symbol === "A" && p.side === side)!.price!,
      );
    bots.setVolatilityMultiplier(3);
    expect(
      bots.act(3).places.find((p) => p.symbol === "PUT" && p.side === "sell")!
        .price!,
    ).toBeGreaterThan(
      short.find((p) => p.symbol === "PUT" && p.side === "sell")!.price!,
    );
  });

  it("positive news buys underlying and a live call", () => {
    const { bots } = botFixture({ momentumTraders: 1 });
    bots.onNewsPulse([{ symbol: "A", sentiment: 1 }], false);
    expect(bots.act(1, () => 0).places.map((p) => [p.symbol, p.side])).toEqual([
      ["A", "buy"],
      ["CALL", "buy"],
    ]);
  });

  it("accumulates before release and retries a partially unfilled dump afterward", () => {
    const { engine, bots } = botFixture({ vegaSnipers: 1 });
    bots.prepareVolEvent("A", 90_000, 29_999);
    expect(bots.act(29_999).places).toHaveLength(0);
    bots.prepareVolEvent("A", 90_000, 30_000);
    const buy = bots.act(30_000).places;
    expect(buy.map((p) => p.symbol)).toEqual(["CALL", "PUT"]);
    engine.restoreAccount(buy[0]!.userId, {
      cash: 10000,
      positions: [
        { symbol: "CALL", quantity: 3, avgPrice: 10 },
        { symbol: "PUT", quantity: 2, avgPrice: 10 },
      ],
    });
    expect(bots.act(89_999).places.every((p) => p.side === "buy")).toBe(true);
    bots.resolveVolEvent("A", 90_000);
    expect(bots.act(90_000).places.map((p) => p.side)).toEqual([
      "sell",
      "sell",
    ]);
    expect(bots.act(90_001).places).toHaveLength(2);
  });

  it("requires executable parity prices, not mid/FV residuals, and bounds IOC legs", () => {
    const { engine, bots } = botFixture({ parityArbers: 1 });
    let seq = 0;
    const quote = (symbol: string, side: "buy" | "sell", price: number) =>
      engine.placeOrder({
        orderId: `q${++seq}`,
        userId: `maker${seq}`,
        symbol,
        side,
        orderType: "limit",
        quantity: 10,
        price,
        ts: 1,
      });
    quote("CALL", "buy", 5);
    quote("CALL", "sell", 45);
    quote("PUT", "buy", 1);
    quote("PUT", "sell", 10);
    quote("A", "buy", 99);
    quote("A", "sell", 101);
    expect(bots.act(2, () => 0).batches).toHaveLength(0);
    quote("CALL", "buy", 20);
    const action = bots.act(3, () => 0);
    expect(action.places).toHaveLength(0);
    expect(action.batches).toHaveLength(1);
    const legs = action.batches![0]!;
    expect(legs).toHaveLength(3);
    expect(legs.map((p) => [p.symbol, p.side, p.price])).toEqual([
      ["CALL", "sell", 20],
      ["PUT", "buy", 10],
      ["A", "buy", 101],
    ]);
    expect(
      legs.every((p) => p.timeInForce === "IOC" && p.orderType === "limit"),
    ).toBe(true);
  });
});
