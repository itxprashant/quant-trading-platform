import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "../../../packages/core/node_modules/vitest/dist/index.js";
import { ChallengeEngine } from "@qtp/core";
import type { EdenSettlementsDependencies } from "./eden-settlements.js";

vi.doMock("../../../packages/db/dist/index.js", () => {
  const names = [
    "auctionBids",
    "auctions",
    "challenges",
    "eventActions",
    "grantMissions",
    "loans",
    "otcOffers",
    "participants",
    "users",
    "voteBallots",
    "voteProposals",
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      new Proxy(
        { name },
        {
          get: (target, key) =>
            key === "name" ? target.name : `${name}.${String(key)}`,
        },
      ),
    ]),
  );
});
vi.doMock("../node_modules/drizzle-orm/index.js", () => {
  const value = (row: any, key: any): any =>
    typeof key === "string" && key.includes(".") && key in row ? row[key] : key;
  return {
    eq: (key: string, expected: any) => (row: any) => {
      const actual = value(row, key),
        right = value(row, expected);
      return actual instanceof Date && right instanceof Date
        ? actual.getTime() === right.getTime()
        : actual === right;
    },
    and:
      (...filters: any[]) =>
      (row: any) =>
        filters.every((filter) => !filter || filter(row)),
    or:
      (...filters: any[]) =>
      (row: any) =>
        filters.some((filter) => filter && filter(row)),
    lte: (key: string, expected: any) => (row: any) =>
      value(row, key) != null && value(row, key) <= expected,
    isNull: (key: string) => (row: any) => value(row, key) == null,
    isNotNull: (key: string) => (row: any) => value(row, key) != null,
    inArray: (key: string, values: any[]) => (row: any) =>
      values.includes(value(row, key)),
    like: (key: string, pattern: string) => (row: any) =>
      new RegExp(`^${pattern.replaceAll("%", ".*")}$`).test(value(row, key)),
    asc: (key: string) => key,
  };
});
vi.doMock("../../../packages/bus/dist/index.js", () => ({
  publishBroadcast: vi.fn(async () => {}),
}));

const { EdenSettlements } = await import("./eden-settlements.js");
const { publishBroadcast } =
  await import("../../../packages/bus/dist/index.js");
const NOW = 1_800_000_000_000;
const CHALLENGE = "00000000-0000-4000-a000-000000000000";
const user = (n: number) =>
  `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

// Transactional adapter fake exercises rollback/retry and checkpoint boundaries,
// not PostgreSQL row-lock isolation. Engine account arithmetic is real.
function fixture(count = 3) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const symbols = [
    { symbol: "A", initialPrice: 100, volatility: 0, tickSize: 1 },
  ];
  const engine = new ChallengeEngine({
    challengeId: CHALLENGE,
    symbols,
    startingCash: 1000,
    minPosition: -10000,
    maxPosition: 10000,
    maxOrderQuantity: 50,
    positionCap: 100,
    allowMargin: true,
  });
  const challenge = {
    id: CHALLENGE,
    slug: "test",
    type: "new_eden",
    status: "live",
    config: {
      symbols,
      eden: { auctionWinnerFraction: 0.3, premiumAccessMinutes: 15 },
    },
    endsAt: new Date(NOW + 180_000),
    frozen: false,
  };
  const tables: Record<string, any[]> = Object.fromEntries(
    [
      "auctionBids",
      "auctions",
      "challenges",
      "eventActions",
      "grantMissions",
      "loans",
      "otcOffers",
      "participants",
      "users",
      "voteBallots",
      "voteProposals",
    ].map((name) => [name, []]),
  );
  tables.challenges!.push(challenge);
  for (let n = 1; n <= count; n++) {
    tables.participants!.push({
      userId: user(n),
      challengeId: CHALLENGE,
      joinedAt: new Date(NOW - 1000),
    });
    tables.users!.push({ id: user(n), role: "trader" });
    engine.restoreAccount(user(n), { cash: 1000, loanDebt: 0, positions: [] });
  }
  const qualify = (table: string, row: any): Record<string, any> =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [`${table}.${key}`, value]),
    );
  const trace: string[] = [];
  const db: any = {
    select: (fields?: Record<string, string>) => ({
      from: (table: any) => {
        const joins: Array<{ table: any; filter: (row: any) => boolean }> = [];
        let filter = (_row: any) => true;
        let order: string[] = [];
        const query: any = {
          innerJoin: (joined: any, on: any) => {
            joins.push({ table: joined, filter: on });
            return query;
          },
          where: (next: any) => {
            filter = next;
            return query;
          },
          orderBy: (...keys: string[]) => {
            order = keys;
            return query;
          },
          for: () => {
            trace.push(`lock:${table.name}`);
            return query;
          },
          then: (resolve: any, reject: any) =>
            Promise.resolve()
              .then(() => {
                let rows = tables[table.name]!.map((row) => ({
                  original: row,
                  flat: qualify(table.name, row),
                }));
                for (const join of joins)
                  rows = rows.flatMap((row) =>
                    tables[join.table.name]!.map((other) => ({
                      original: row.original,
                      flat: { ...row.flat, ...qualify(join.table.name, other) },
                    })).filter((combined) => join.filter(combined.flat)),
                  );
                rows = rows.filter((row) => filter(row.flat));
                rows.sort((a, b) => {
                  for (const key of order) {
                    if (a.flat[key] < b.flat[key]) return -1;
                    if (a.flat[key] > b.flat[key]) return 1;
                  }
                  return 0;
                });
                return rows.map((row) =>
                  structuredClone(
                    fields
                      ? Object.fromEntries(
                          Object.entries(fields).map(([name, key]) => [
                            name,
                            row.flat[key],
                          ]),
                        )
                      : row.original,
                  ),
                );
              })
              .then(resolve, reject),
        };
        return query;
      },
    }),
    update: (table: any) => ({
      set: (values: any) => ({
        where: (filter: any) => {
          const apply = () => {
            const changed = tables[table.name]!.filter((row) =>
              filter(qualify(table.name, row)),
            );
            for (const row of changed)
              Object.assign(row, structuredClone(values));
            return structuredClone(changed);
          };
          return {
            returning: async () => apply(),
            then: (resolve: any, reject: any) =>
              Promise.resolve().then(apply).then(resolve, reject),
          };
        },
      }),
    }),
    insert: (table: any) => ({
      values: (values: any) => {
        let ignore = false;
        const apply = () => {
          const rows = Array.isArray(values) ? values : [values];
          const added: any[] = [];
          for (const value of rows) {
            const exists = tables[table.name]!.some((row) =>
              table.name === "eventActions"
                ? row.challengeId === value.challengeId &&
                  row.actionId === value.actionId
                : row.id === value.id,
            );
            if (exists && ignore) continue;
            if (exists) throw new Error("duplicate row");
            const row = {
              createdAt: new Date(NOW),
              completedAt: new Date(NOW),
              ...structuredClone(value),
            };
            tables[table.name]!.push(row);
            added.push(row);
          }
          return added;
        };
        const query: any = {
          onConflictDoNothing: () => {
            ignore = true;
            return query;
          },
          returning: async () => apply(),
          then: (resolve: any, reject: any) =>
            Promise.resolve().then(apply).then(resolve, reject),
        };
        return query;
      },
    }),
    transaction: async (run: any) => {
      const before = structuredClone(tables);
      try {
        return await run(db);
      } catch (error) {
        for (const name of Object.keys(tables)) tables[name] = before[name]!;
        throw error;
      }
    },
  };
  const writes: Array<(tx: any) => Promise<void>> = [];
  const checkpoints: ReturnType<ChallengeEngine["exportState"]>[] = [];
  let fail = false;
  const persistence = {
    collect: vi.fn((_events: unknown[]) => {
      trace.push("collected");
    }),
    markUsers: vi.fn(),
    queueWrite: (write: (tx: any) => Promise<void>) => {
      writes.push(write);
    },
    flush: vi.fn(async () => {
      const snapshot = engine.exportState();
      await db.transaction(async (tx: any) => {
        for (const write of writes) await write(tx);
        if (fail) {
          fail = false;
          throw new Error("database rollback");
        }
      });
      writes.length = 0;
      checkpoints.push(snapshot);
      trace.push("committed");
    }),
  };
  const redis = { eval: vi.fn(async () => 1) };
  const emit = vi.fn(async () => {
    trace.push("emitted");
  });
  const refreshPortfolios = vi.fn(async () => {
    trace.push("refreshed");
  });
  const deps = {
    db,
    engine,
    redis,
    challenge,
    persistence,
    emit,
    refreshPortfolios,
    minuteMs: 60_000,
  } as unknown as EdenSettlementsDependencies;
  const settlements = new EdenSettlements(deps);
  const addLoan = (id = "loan", principal = 120) => {
    tables.loans!.push({
      id,
      challengeId: CHALLENGE,
      userId: user(1),
      principal,
      totalRepay: principal * 2,
      remaining: principal * 2,
      status: "active",
      fundedAt: null,
      installment: (principal * 2) / 3,
      nextPaymentAt: new Date(NOW + 60_000),
      createdAt: new Date(NOW),
    });
  };
  const addAuction = (n = count) => {
    tables.auctions!.push({
      id: "auction",
      challengeId: CHALLENGE,
      status: "open",
      cutoff: null,
      expiresAt: new Date(NOW),
      createdAt: new Date(NOW - 30_000),
    });
    for (let i = n; i >= 1; i--)
      tables.auctionBids!.push({
        id: `bid${i}`,
        auctionId: "auction",
        userId: user(i),
        amount: 50,
        won: false,
      });
  };
  const addOtc = (quantity = 2) =>
    tables.otcOffers!.push({
      id: "offer",
      challengeId: CHALLENGE,
      userId: user(1),
      status: "accepted",
      settleAt: new Date(NOW + 5000),
      expiresAt: new Date(NOW + 1000),
      legs: [{ symbol: "A", quantity, price: 100 }],
      cashToTrader: 25,
    });
  const addVote = (status = "passed") => {
    tables.voteProposals!.push({
      id: "vote",
      challengeId: CHALLENGE,
      title: "Tax",
      description: "Tax",
      kind: "wealth_tax",
      status,
      expiresAt: new Date(NOW),
      createdAt: new Date(NOW - 1000),
    });
    tables.voteBallots!.push({
      proposalId: "vote",
      userId: user(1),
      choice: "yes",
    });
  };
  const addGrant = () =>
    tables.grantMissions!.push({
      id: "grant",
      challengeId: CHALLENGE,
      symbol: "A",
      description: "Grant",
      prize: 100,
      status: "open",
      winnerId: null,
      expiresAt: new Date(NOW),
      createdAt: new Date(NOW - 1000),
    });
  return {
    deps,
    settlements,
    db,
    engine,
    tables,
    persistence,
    redis,
    emit,
    refreshPortfolios,
    trace,
    checkpoints,
    failNext: () => {
      fail = true;
    },
    addLoan,
    addAuction,
    addOtc,
    addVote,
    addGrant,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("EdenSettlements", () => {
  it("funds once, catches up fixed installments, and clears the residual at the deadline", async () => {
    const f = fixture();
    f.addLoan();
    await f.settlements.issueLoan("loan", NOW);
    expect(f.engine.cashOf(user(1))).toBe(1120);
    expect(f.tables.loans![0]).toMatchObject({
      installment: 80,
      totalRepay: 240,
      fundedAt: new Date(NOW),
    });
    expect(f.trace.indexOf("committed")).toBeLessThan(
      f.trace.indexOf("emitted"),
    );
    await f.settlements.issueLoan("loan", NOW);
    await f.settlements.repayLoans(NOW + 120_000);
    expect(f.engine.cashOf(user(1))).toBe(960);
    expect(f.tables.loans![0]).toMatchObject({
      remaining: 80,
      installment: 80,
      nextPaymentAt: new Date(NOW + 180_000),
    });
    await f.settlements.repayLoans(NOW + 120_000);
    expect(f.engine.cashOf(user(1))).toBe(960);
    await f.settlements.repayLoans(NOW + 180_000);
    expect(f.engine.cashOf(user(1))).toBe(880);
    expect(f.engine.loanDebtOf(user(1))).toBe(0);
    expect(f.tables.loans![0]).toMatchObject({
      status: "repaid",
      remaining: 0,
      nextPaymentAt: null,
    });
  });

  it("drains failed funding writes before retrying, without funding twice", async () => {
    const f = fixture();
    f.addLoan();
    f.failNext();
    await expect(f.settlements.issueLoan("loan", NOW)).rejects.toThrow(
      "database rollback",
    );
    expect(f.tables.loans![0].fundedAt).toBeNull();
    expect(f.tables.eventActions).toEqual([]);
    expect(f.emit).not.toHaveBeenCalled();
    await f.settlements.issueLoan("loan", NOW);
    expect(f.engine.cashOf(user(1))).toBe(1120);
    expect(f.tables.loans![0].fundedAt).toEqual(new Date(NOW));
    expect(f.tables.eventActions!.map((r) => r.actionId)).toEqual([
      "loan:loan",
    ]);
    await new EdenSettlements(f.deps).issueLoan("loan", NOW);
    expect(f.engine.cashOf(user(1))).toBe(1120);
  });

  it("retries a failed repayment without a second debit", async () => {
    const f = fixture();
    f.addLoan();
    await f.settlements.issueLoan("loan", NOW);
    f.failNext();
    await expect(f.settlements.repayLoans(NOW + 60_000)).rejects.toThrow(
      "database rollback",
    );
    expect(f.tables.loans![0].remaining).toBe(240);
    await f.settlements.repayLoans(NOW + 60_000);
    expect(f.engine.cashOf(user(1))).toBe(1040);
    expect(f.tables.loans![0].remaining).toBe(160);
  });

  it("does not infer legacy funding from checkpoint age", async () => {
    const f = fixture();
    f.addLoan();
    Object.assign(f.tables.loans![0], { installment: 0, nextPaymentAt: null });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await f.settlements.issueLoan("loan", NOW);
    await f.settlements.issueLoan("loan", NOW);
    expect(f.engine.cashOf(user(1))).toBe(1000);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("voids an unfunded request after the live deadline", async () => {
    const f = fixture();
    f.addLoan();
    await f.settlements.issueLoan("loan", NOW + 180_000);
    expect(f.engine.cashOf(user(1))).toBe(1000);
    expect(f.tables.loans![0]).toMatchObject({
      status: "repaid",
      fundedAt: null,
      remaining: 0,
    });
  });

  it("uses game minutes rather than the API schedule and collects a partial final minute", async () => {
    const f = fixture();
    f.addLoan();
    f.deps.minuteMs = 1000;
    f.deps.challenge.endsAt = new Date(NOW + 2500);
    await f.settlements.issueLoan("loan", NOW);
    expect(f.tables.loans![0]).toMatchObject({
      installment: 80,
      nextPaymentAt: new Date(NOW + 1000),
    });
    await f.settlements.repayLoans(NOW + 2000);
    expect(f.tables.loans![0].remaining).toBe(80);
    await f.settlements.repayLoans(NOW + 2500);
    expect(f.engine.cashOf(user(1))).toBe(880);
    expect(f.engine.loanDebtOf(user(1))).toBe(0);
  });

  it("charges the exact deterministic auction cohort and persists the original entitlement deadline", async () => {
    const f = fixture(5);
    f.addAuction();
    await f.settlements.resolveAuction("auction", NOW - 1);
    expect(f.tables.auctions![0].status).toBe("open");
    await f.settlements.resolveAuction("auction", NOW, NOW + 20_000);
    expect(
      f.tables
        .auctionBids!.filter((b) => b.won)
        .map((b) => b.userId)
        .sort(),
    ).toEqual([user(1), user(2)]);
    expect(f.engine.cashOf(user(1))).toBe(950);
    expect(f.engine.cashOf(user(3))).toBe(1000);
    expect(f.tables.auctions![0]).toMatchObject({
      status: "resolved",
      cutoff: 50,
    });
    expect(f.redis.eval).toHaveBeenCalledTimes(2);
    expect(f.redis.eval.mock.calls[0]!.at(-1)).toBe(String(NOW + 20_000));
    await f.settlements.resolveAuction("auction", NOW + 1000);
    expect(f.engine.cashOf(user(1))).toBe(950);
    expect(f.redis.eval.mock.calls.at(-1)!.at(-1)).toBe(String(NOW + 20_000));
    expect(f.trace.filter((s) => s === "lock:auctions")).toHaveLength(4);
  });

  it("excludes unaffordable and unenrolled bids without debiting them", async () => {
    const f = fixture(3);
    f.addAuction();
    f.tables.auctionBids!.push({
      id: "intruder",
      auctionId: "auction",
      userId: user(99),
      amount: 1000,
      won: false,
    });
    f.engine.adjustCash(user(1), -999);
    await f.settlements.resolveAuction("auction", NOW);
    expect(
      f.tables.auctionBids!.filter((b) => b.won).map((b) => b.userId),
    ).toEqual([user(2)]);
    expect(f.engine.cashOf(user(1))).toBe(1);
  });

  it("publishes no auction result on rollback and repairs premium after retry", async () => {
    const f = fixture();
    f.addAuction();
    f.failNext();
    await expect(f.settlements.resolveAuction("auction", NOW)).rejects.toThrow(
      "database rollback",
    );
    expect(f.tables.auctions![0].status).toBe("open");
    expect(f.redis.eval).not.toHaveBeenCalled();
    expect(publishBroadcast).not.toHaveBeenCalled();
    await f.settlements.resolveAuction("auction", NOW);
    expect(f.engine.cashOf(user(1))).toBe(950);
    expect(f.tables.auctions![0].status).toBe("resolved");
    expect(f.redis.eval).toHaveBeenCalledTimes(1);
  });

  it("waits for the bargain deadline, then settles despite negative cash and mirrors the host", async () => {
    const f = fixture();
    f.addOtc();
    f.engine.adjustCash(user(1), -900);
    f.engine.setPrice("A", 5000);
    f.engine.setFairValue("A", 8000);
    await f.settlements.settleOtc("offer", NOW + 4999);
    expect(f.tables.otcOffers![0].status).toBe("accepted");
    await f.settlements.settleOtc("offer", NOW + 5000);
    expect(f.engine.cashOf(user(1))).toBe(-75);
    expect(f.engine.cashOf("bot:deal-desk")).toBe(175);
    expect(f.engine.positionOf(user(1), "A")).toBe(2);
    expect(f.engine.positionOf("bot:deal-desk", "A")).toBe(-2);
    await f.settlements.settleOtc("offer", NOW + 6000);
    expect(f.engine.cashOf(user(1))).toBe(-75);
    expect(f.tables.otcOffers![0].status).toBe("settled");
  });

  it("creates an actual opposite option position for the Deal Desk counterparty", async () => {
    const f = fixture();
    f.addOtc();
    const symbol = "A-C-100-CYCLE";
    f.engine.addSymbol({
      symbol,
      initialPrice: 10,
      tickSize: 1,
      volatility: 0,
    });
    f.engine.registerOption({
      symbol,
      underlying: "A",
      optionType: "call",
      strike: 100,
      cycleId: "cycle",
      openedAt: NOW,
      expiresAt: NOW + 60_000,
    });
    f.tables.otcOffers![0].legs = [{ symbol, quantity: -2, price: 10 }];
    await f.settlements.settleOtc("offer", NOW + 5000);
    expect(f.engine.positionOf(user(1), symbol)).toBe(-2);
    expect(f.engine.positionOf("bot:deal-desk", symbol)).toBe(2);
    expect(f.engine.cashOf(user(1)) + f.engine.cashOf("bot:deal-desk")).toBe(
      1000,
    );
  });

  it("preserves an accepted bargain after holdings change, without inventing a penalty", async () => {
    const f = fixture();
    f.addOtc();
    await f.settlements.reserveOtc(NOW);
    f.engine.settleFill(user(1), "A", 99, 0);
    await f.settlements.settleOtc("offer", NOW + 5000);
    expect(f.tables.otcOffers![0].status).toBe("settled");
    expect(f.engine.cashOf(user(1))).toBe(825);
    expect(f.engine.positionOf(user(1), "A")).toBe(101);
    expect(f.emit.mock.calls.flat(2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "alert",
          level: "urgent",
          message: expect.stringContaining("no automatic penalty"),
        }),
      ]),
    );
    await f.settlements.settleOtc("offer", NOW + 6000);
    expect(f.engine.cashOf(user(1))).toBe(825);
    expect(f.persistence.flush).toHaveBeenCalledTimes(2);
  });

  it("cancels conflicting working orders before checkpointing the binding settlement", async () => {
    const f = fixture();
    f.addOtc(5);
    f.engine.settleFill(user(1), "A", 90, 0);
    f.engine.placeOrder({
      orderId: user(50),
      userId: user(1),
      symbol: "A",
      side: "buy",
      orderType: "limit",
      price: 10,
      quantity: 10,
      ts: NOW,
    });
    expect(f.engine.snapshot("A").bids.length).toBeGreaterThan(0);
    await f.settlements.settleOtc("offer", NOW + 5000);
    expect(f.engine.positionOf(user(1), "A")).toBe(95);
    expect(f.engine.snapshot("A").bids).toEqual([]);
    expect(f.persistence.collect).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          type: "order_update",
          status: "cancelled",
          orderId: user(50),
        }),
      ]),
    );
    expect(f.trace.indexOf("collected")).toBeLessThan(
      f.trace.indexOf("committed"),
    );
  });

  it("honors accepted terms on a closed but still registered book", async () => {
    const f = fixture();
    f.addOtc();
    await f.settlements.reserveOtc(NOW);
    f.engine.closeSymbol("A", NOW);
    await f.settlements.settleOtc("offer", NOW + 5000);
    expect(f.tables.otcOffers![0].status).toBe("settled");
    expect(f.engine.cashOf(user(1))).toBe(825);
  });

  it("keeps removed-instrument obligations accepted for host review rather than resurrecting them", async () => {
    const f = fixture();
    f.addOtc();
    await f.settlements.reserveOtc(NOW);
    f.emit.mockClear();
    f.engine.removeSymbol("A");
    await f.settlements.settleOtc("offer", NOW + 5000);
    await f.settlements.settleOtc("offer", NOW + 6000);
    expect(f.tables.otcOffers![0].status).toBe("accepted");
    expect(f.engine.cashOf(user(1))).toBe(1000);
    expect(f.engine.hasSymbol("A")).toBe(false);
    expect(f.emit).toHaveBeenCalledTimes(1);
    expect(f.tables.eventActions!.map((row) => row.actionId)).toEqual([
      "otc-reserved:offer",
    ]);
  });

  it("reserves accepted exposure before both maker and taker order flow", async () => {
    const f = fixture();
    f.addOtc(80);
    await f.settlements.reserveOtc(NOW);
    expect(f.engine.cashOf(user(1))).toBe(1000);
    expect(f.checkpoints.at(-1)?.reservations).toEqual([
      {
        id: "offer",
        userId: user(1),
        legs: [{ symbol: "A", quantity: 80, price: 100 }],
      },
    ]);
    f.engine.placeOrder({
      orderId: user(50),
      userId: user(1),
      symbol: "A",
      side: "buy",
      orderType: "limit",
      quantity: 50,
      price: 100,
      ts: NOW,
    });
    f.engine.placeOrder({
      orderId: user(51),
      userId: "bot:flow",
      symbol: "A",
      side: "sell",
      orderType: "market",
      quantity: 50,
      price: null,
      ts: NOW,
    });
    expect(f.engine.positionOf(user(1), "A")).toBe(20);
    const rejected = f.engine.placeOrder({
      orderId: user(52),
      userId: user(1),
      symbol: "A",
      side: "buy",
      orderType: "market",
      quantity: 1,
      price: null,
      ts: NOW,
    });
    expect(rejected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "order_update", status: "rejected" }),
      ]),
    );
    await f.settlements.settleOtc("offer", NOW + 5000);
    expect(f.engine.positionOf(user(1), "A")).toBe(100);
    expect(f.engine.exportState().reservations).toEqual([]);
  });

  it("rejects an unreservable provisional acceptance before confirming the bargain", async () => {
    const f = fixture();
    f.addOtc(101);
    await f.settlements.reserveOtc(NOW);
    expect(f.tables.otcOffers![0].status).toBe("rejected");
    expect(f.engine.cashOf(user(1))).toBe(1000);
    expect(f.engine.exportState().reservations).toEqual([]);
    expect(
      f.tables.eventActions!.some(
        (row) => row.actionId === "otc-reserved:offer",
      ),
    ).toBe(false);
    expect(f.emit.mock.calls.flat(2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "alert",
          message: expect.stringContaining(
            "Provisional deal acceptance rejected",
          ),
        }),
      ]),
    );
  });

  it("retries reservation checkpoint writes without reserving twice", async () => {
    const f = fixture();
    f.addOtc();
    f.failNext();
    const reserve = vi.spyOn(f.engine, "reserveSettlement");
    await expect(f.settlements.reserveOtc(NOW)).rejects.toThrow(
      "database rollback",
    );
    expect(f.tables.eventActions).toEqual([]);
    expect(f.emit).not.toHaveBeenCalled();
    await f.settlements.reserveOtc(NOW);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(f.engine.exportState().reservations).toHaveLength(1);
    expect(f.tables.eventActions!.map((row) => row.actionId)).toEqual([
      "otc-reserved:offer",
    ]);
  });

  it("does not recreate a receipted reservation missing from a checkpoint", async () => {
    const f = fixture();
    f.addOtc();
    await f.settlements.reserveOtc(NOW);
    const state = f.engine.exportState();
    state.reservations = [];
    f.engine.restoreState(state);
    const reserve = vi.spyOn(f.engine, "reserveSettlement");
    await new EdenSettlements(f.deps).reserveOtc(NOW);
    expect(reserve).not.toHaveBeenCalled();
    expect(f.engine.exportState().reservations).toEqual([]);
  });

  it("does no checkpoint work when there are no accepted offers", async () => {
    const f = fixture();
    await f.settlements.reserveOtc(NOW);
    expect(f.persistence.flush).not.toHaveBeenCalled();
  });

  it("recovers an API-passed tax with one durable receipt, including after rollback", async () => {
    const f = fixture(10);
    f.addVote();
    for (let n = 1; n <= 10; n++) f.engine.adjustCash(user(n), n * 100 - 1000);
    f.failNext();
    await expect(f.settlements.applyTax("vote", NOW)).rejects.toThrow(
      "database rollback",
    );
    expect(f.tables.eventActions).toEqual([]);
    await f.settlements.applyTax("vote", NOW);
    expect(f.engine.cashOf(user(10))).toBe(850);
    expect(f.engine.cashOf(user(1))).toBe(175);
    expect(f.engine.cashOf(user(2))).toBe(275);
    expect(f.tables.eventActions!.map((r) => r.actionId)).toEqual(["tax:vote"]);
    await new EdenSettlements(f.deps).applyTax("vote", NOW);
    expect(f.engine.cashOf(user(10))).toBe(850);
  });

  it("closes only due votes and excludes nonparticipant ballots", async () => {
    const f = fixture();
    f.addVote("open");
    f.tables.voteBallots!.push({
      proposalId: "vote",
      userId: user(99),
      choice: "no",
    });
    await f.settlements.resolveVote("vote", NOW - 1);
    expect(f.tables.voteProposals![0].status).toBe("open");
    await f.settlements.resolveVote("vote", NOW);
    expect(f.tables.voteProposals![0].status).toBe("passed");
    expect(f.tables.eventActions!.some((r) => r.actionId === "tax:vote")).toBe(
      true,
    );
  });

  it("recovers a failed enqueue after an API vote was closed early", async () => {
    const f = fixture();
    f.addVote();
    f.tables.voteProposals![0].expiresAt = new Date(NOW + 60_000);
    await f.settlements.recover(NOW);
    expect(f.tables.eventActions!.some((r) => r.actionId === "tax:vote")).toBe(
      true,
    );
  });

  it("awards a deterministic grant exactly once and resolves an empty cohort", async () => {
    const f = fixture();
    f.addGrant();
    f.engine.settleFill(user(2), "A", 3, 0);
    f.engine.settleFill(user(1), "A", 3, 0);
    await f.settlements.awardGrant("grant", NOW);
    await f.settlements.awardGrant("grant", NOW);
    expect(f.tables.grantMissions![0]).toMatchObject({
      status: "awarded",
      winnerId: user(1),
    });
    expect(f.engine.cashOf(user(1))).toBe(1100);
    f.tables.grantMissions!.push({
      ...f.tables.grantMissions![0],
      id: "empty",
      symbol: "NONE",
      status: "open",
    });
    await f.settlements.awardGrant("empty", NOW);
    expect(f.tables.grantMissions![1]).toMatchObject({
      status: "awarded",
      winnerId: null,
    });
  });

  it("uses a stable rescue loan intent for repeated halftime actions", async () => {
    const f = fixture();
    f.engine.adjustCash(user(1), -1050);
    await f.settlements.rescueLoans(NOW);
    expect(f.engine.cashOf(user(1))).toBe(1);
    expect(f.engine.loanDebtOf(user(1))).toBe(102);
    expect(f.tables.loans).toHaveLength(1);
    f.engine.adjustCash(user(1), -10);
    await f.settlements.rescueLoans(NOW);
    expect(f.engine.cashOf(user(1))).toBe(-9);
    expect(f.tables.loans).toHaveLength(1);
  });

  it("recovers due records and leaves future settlements untouched", async () => {
    const f = fixture();
    f.addLoan();
    f.addAuction();
    f.addVote("open");
    f.addGrant();
    f.addOtc();
    await f.settlements.recover(NOW);
    expect(f.tables.loans![0].fundedAt).not.toBeNull();
    expect(f.tables.auctions![0].status).toBe("resolved");
    expect(f.tables.voteProposals![0].status).toBe("passed");
    expect(f.tables.grantMissions![0].status).toBe("awarded");
    expect(f.tables.otcOffers![0].status).toBe("accepted");
    const state = f.engine.exportState();
    await f.settlements.recover(NOW);
    expect(f.engine.exportState()).toEqual(state);
    await f.settlements.recover(NOW + 5000);
    expect(f.tables.otcOffers![0].status).toBe("settled");
  });
});
