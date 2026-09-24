import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "../../../../packages/core/node_modules/vitest/dist/index.js";
import { EDEN_EVENT_AERIUM, EDEN_EVENT_OPTIONS, redisKeys } from "@qtp/shared";

vi.doMock("../../../../packages/db/dist/index.js", () =>
  Object.fromEntries(
    [
      "auctions",
      "bondHoldings",
      "challengeNews",
      "challenges",
      "engineCheckpoints",
      "eventActions",
      "fairValues",
      "grantMissions",
      "loans",
      "optionContracts",
      "optionCycles",
      "orders",
      "otcOffers",
      "participants",
      "positions",
      "scoreSnapshots",
      "trades",
      "users",
      "voteProposals",
    ].map((name) => [
      name,
      {
        name,
        id: "id",
        challengeId: "challengeId",
        userId: "userId",
        symbol: "symbol",
      },
    ]),
  ),
);
vi.doMock("../../node_modules/drizzle-orm/index.js", () => ({
  eq: (key: string, expected: any) => (row: any) =>
    typeof row[key] === "string"
      ? row[key].toLowerCase() === String(expected).toLowerCase()
      : row[key] === expected,
  and:
    (...filters: any[]) =>
    (row: any) =>
      filters.every((f) => f(row)),
  desc: (key: string) => key,
}));
vi.doMock("../../../../packages/bus/dist/index.js", () => ({
  getFairValues: vi.fn(),
  getListedSymbols: vi.fn(async () => ["ORBITAL"]),
  publishBroadcast: vi.fn(),
  publishCommand: vi.fn(),
  pushNews: vi.fn(),
  setMarketFrozen: vi.fn(),
  setPrice: vi.fn(),
  setSymbolTradeable: vi.fn(),
}));
vi.doMock("../eden-ops.js", () => ({
  awardGrantMission: vi.fn(),
  closeVote: vi.fn(),
  resolveAuctionRound: vi.fn(),
  scheduleEdenResolver: vi.fn(),
}));
const { adminRoutes } = await import("./admin.js");
const { publishCommand } =
  await import("../../../../packages/bus/dist/index.js");

const ID = "aaaaaaaa-0000-4000-a000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-a000-000000000002";
const TRADER = "cccccccc-0000-4000-a000-000000000003";
const deletedTables = [
  "trades",
  "orders",
  "positions",
  "challengeNews",
  "loans",
  "bondHoldings",
  "otcOffers",
  "optionContracts",
  "optionCycles",
  "auctions",
  "voteProposals",
  "grantMissions",
  "engineCheckpoints",
  "eventActions",
  "fairValues",
  "scoreSnapshots",
];

// Entirely mocked route/database/Redis. These tests never invoke a real reset.
async function fixture(status = "paused") {
  const tables: Record<string, any[]> = Object.fromEntries(
    deletedTables.map((name) => [
      name,
      [
        { id: `${name}-owned`, challengeId: ID },
        { id: `${name}-other`, challengeId: OTHER },
      ],
    ]),
  );
  tables.challenges = [
    {
      id: ID,
      status,
      frozen: true,
      finalizedAt: new Date(),
      startsAt: new Date(),
      endsAt: new Date(),
      config: {
        startingCash: 10000,
        symbols: [EDEN_EVENT_AERIUM, { symbol: "NEURO", initialPrice: 500 }],
        eden: {
          eventScript: true,
          rules: { enabled: true },
          bonds: [{ id: "old" }],
          etfs: [{ symbol: "ORBITAL" }],
          options: { ...EDEN_EVENT_OPTIONS, enabled: true },
        },
      },
    },
  ];
  tables.participants = [
    { challengeId: ID, cash: -100, startingCash: 5, loanDebt: 500 },
    { challengeId: OTHER, cash: 9, startingCash: 9, loanDebt: 1 },
  ];
  const cache = new Map<string, string>();
  for (const prefix of [
    "price",
    "phist",
    "phist-mid",
    "book",
    "fv",
    "premium",
    "drift_target",
    "drift_speed",
  ]) {
    cache.set(`qtp:${prefix}:${ID}:REMOVED`, "old");
    cache.set(`qtp:${prefix}:${OTHER}:REMOVED`, "other");
  }
  for (const key of [
    redisKeys.commandStream(ID),
    redisKeys.commandCursor(ID),
    redisKeys.eventStream(ID),
    redisKeys.leaderboard(ID),
    redisKeys.newsFeed(ID),
    redisKeys.metrics(ID),
    redisKeys.fairValueSet(ID),
    redisKeys.fairValueSnapshot(ID),
    redisKeys.lockedSymbols(ID),
    redisKeys.marketFrozen(ID),
    redisKeys.listedSymbols(ID),
    redisKeys.etfWindows(ID),
    redisKeys.optionContracts(ID),
    `qtp:final:${ID}`,
    `qtp:assignment-breaches:${ID}`,
  ])
    cache.set(key, "old");
  const active = new Set([ID, OTHER]);
  const trace: string[] = [];
  let beforeTransaction: (() => void) | undefined;
  let beforeDelete: (() => void) | undefined;
  const db: any = {
    query: {
      challenges: {
        findFirst: async ({ where }: any) =>
          structuredClone(tables.challenges!.find(where)),
      },
      participants: {
        findFirst: async ({ where }: any) =>
          structuredClone(tables.participants!.find(where)),
      },
    },
    select: () => ({
      from: (table: any) => ({
        where: (filter: any) =>
          Object.assign(
            Promise.resolve(structuredClone(tables[table.name]!.filter(filter))),
            {
              for: async () => {
                trace.push("row-lock");
                return structuredClone(tables[table.name]!.filter(filter));
              },
            },
          ),
      }),
    }),
    update: (table: any) => ({
      set: (values: any) => ({
        where: async (filter: any) => {
          trace.push(`update:${table.name}`);
          for (const row of tables[table.name]!.filter(filter))
            Object.assign(row, structuredClone(values));
        },
      }),
    }),
    delete: (table: any) => ({
      where: async (filter: any) => {
        trace.push(`delete:${table.name}`);
        tables[table.name] = tables[table.name]!.filter((row) => !filter(row));
      },
    }),
    transaction: vi.fn(async (run: any) => {
      beforeTransaction?.();
      const before = structuredClone(tables);
      try {
        const result = await run(db);
        trace.push("commit");
        return result;
      } catch (error) {
        for (const name of Object.keys(tables)) tables[name] = before[name]!;
        trace.push("rollback");
        throw error;
      }
    }),
  };
  const redis = {
    set: vi.fn(async (key: string, value: string, ...options: any[]) => {
      expect(options).toEqual(["EX", 120, "NX"]);
      if (cache.has(key)) return null;
      cache.set(key, value);
      trace.push("acquired");
      return "OK";
    }),
    eval: vi.fn(
      async (script: string, _keys: number, key: string, owner: string) => {
        if (cache.get(key) !== owner) return 0;
        if (script.includes("'DEL'")) {
          cache.delete(key);
          trace.push("released");
        } else trace.push("renewed");
        return 1;
      },
    ),
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => [
      "0",
      [...cache.keys()].filter((key) =>
        new RegExp(`^${pattern.replaceAll("*", ".*")}$`).test(key),
      ),
    ]),
    del: vi.fn(async (...keys: string[]) => {
      beforeDelete?.();
      trace.push("cache-delete");
      for (const key of keys) cache.delete(key);
    }),
    srem: vi.fn(async (_key: string, id: string) => {
      active.delete(id);
    }),
    publish: vi.fn(),
  };
  const handlers = new Map<string, any>();
  const app: any = {
    db,
    redis,
    requireAdmin: vi.fn(),
    log: { error: vi.fn() },
    addHook: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    post: (path: string, ...args: any[]) => handlers.set(path, args.at(-1)),
  };
  await adminRoutes(app);
  const request = async (
    path: string,
    body: unknown,
    id = ID,
    params: Record<string, string> = {},
  ) => {
    const reply: any = {
      statusCode: 200,
      payload: undefined,
      code: (code: number) => {
        reply.statusCode = code;
        return reply;
      },
      send: (payload: any) => {
        reply.payload = payload;
        return reply;
      },
    };
    const result = await handlers.get(path)(
      {
        params: { challengeId: id, ...params },
        body,
        user: { sub: "admin" },
        log: { info: vi.fn() },
      },
      reply,
    );
    return { statusCode: reply.statusCode, body: reply.payload ?? result };
  };
  return {
    tables,
    cache,
    active,
    trace,
    db,
    redis,
    request,
    call: (id = ID) => request("/:challengeId/reset", undefined, id),
    openOptions: (body: unknown = {}) =>
      request("/:challengeId/options/open", body),
    freeze: (frozen: boolean) => request("/:challengeId/freeze", { frozen }),
    editAccount: (body: unknown, userId = TRADER) =>
      request("/:challengeId/accounts/:userId", body, ID, { userId }),
    beforeTransaction: (run: () => void) => {
      beforeTransaction = run;
    },
    beforeDelete: (run: () => void) => {
      beforeDelete = run;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("admin option opening", () => {
  it("persists enabled options when opening all configured underlyings", async () => {
    const f = await fixture();
    f.tables.challenges![0].config.eden.options.enabled = false;
    vi.mocked(publishCommand).mockImplementationOnce(async () => {
      expect(f.tables.challenges![0].config.eden.options.enabled).toBe(true);
      expect(f.trace).toContain("commit");
      return "1-0";
    });
    expect(await f.openOptions()).toEqual({
      statusCode: 200,
      body: { ok: true },
    });
    expect(f.tables.challenges![0].config.eden.options).toMatchObject({
      enabled: true,
      underlyings: ["AERIUM"],
    });
    expect(publishCommand).toHaveBeenCalledWith(
      f.redis,
      ID,
      expect.objectContaining({ type: "open_option_cycle", underlying: "" }),
    );
  });

  it("merges an explicit underlying into the persisted options config", async () => {
    const f = await fixture();
    await f.openOptions({ underlying: "NEURO" });
    expect(f.tables.challenges![0].config.eden.options).toMatchObject({
      enabled: true,
      underlyings: ["AERIUM", "NEURO"],
    });
  });

  it("rejects opening with no explicit or configured underlyings", async () => {
    const f = await fixture();
    f.tables.challenges![0].config.eden.options = {
      ...EDEN_EVENT_OPTIONS,
      underlyings: [],
    };
    expect(await f.openOptions()).toEqual({
      statusCode: 400,
      body: { error: "invalid_underlyings" },
    });
    expect(publishCommand).not.toHaveBeenCalled();
    expect(f.tables.challenges![0].config.eden.options.enabled).toBe(false);
  });
});

describe("admin freeze during a scripted event", () => {
  const MINUTE = 60_000;
  async function scripted(elapsedMinutes: number) {
    const f = await fixture("live");
    const start = Date.now() - elapsedMinutes * MINUTE;
    Object.assign(f.tables.challenges![0], {
      type: "new_eden",
      finalizedAt: null,
      startsAt: new Date(start),
      endsAt: new Date(start + 130 * MINUTE),
    });
    return f;
  }

  it.each([
    ["before the scripted open", -5],
    ["during halftime", 65],
  ])("refuses a manual unfreeze %s", async (_label: string, elapsed: number) => {
    const f = await scripted(elapsed);
    expect(await f.freeze(false)).toEqual({
      statusCode: 409,
      body: { error: "scripted_halt" },
    });
    expect(f.tables.challenges![0].frozen).toBe(true);
    expect(publishCommand).not.toHaveBeenCalled();
    expect((await f.freeze(true)).statusCode).toBe(200);
  });

  it("allows a manual unfreeze during a trading session", async () => {
    const f = await scripted(20);
    expect((await f.freeze(false)).body).toEqual({ ok: true, frozen: false });
    expect(f.tables.challenges![0].frozen).toBe(false);
  });
});

describe("admin Eden controls on a missing challenge", () => {
  const bodies = {
    otc: {
      userId: TRADER,
      description: "ghost",
      legs: [{ symbol: "AERIUM", quantity: 1, price: 1 }],
    },
    vote: { title: "ghost", description: "ghost" },
    grant: { symbol: "AERIUM", description: "ghost", prize: 1 },
  };

  it.each(Object.entries(bodies))(
    "%s returns 404 before writing anything",
    async (path: string, body: unknown) => {
      const f = await fixture("live");
      for (const id of [OTHER, "not-a-uuid"]) {
        expect(await f.request(`/:challengeId/${path}`, body, id)).toEqual({
          statusCode: 404,
          body: { error: "not_found" },
        });
      }
      expect(publishCommand).not.toHaveBeenCalled();
    },
  );
});

describe("admin account edit", () => {
  async function live() {
    const f = await fixture("live");
    f.tables.challenges![0].finalizedAt = null;
    f.tables.participants!.push({ challengeId: ID, userId: TRADER, cash: 1 });
    return f;
  }

  it("queues an absolute cash and inventory edit for the engine", async () => {
    const f = await live();
    expect(
      await f.editAccount({
        cash: 2500,
        positions: [
          { symbol: "AERIUM", quantity: 12 },
          { symbol: "ORBITAL", quantity: 0 },
        ],
      }),
    ).toEqual({ statusCode: 202, body: { ok: true } });
    expect(publishCommand).toHaveBeenCalledWith(
      f.redis,
      ID,
      expect.objectContaining({
        type: "admin_set_account",
        challengeId: ID,
        userId: TRADER,
        cash: 2500,
        positions: [
          { symbol: "AERIUM", quantity: 12 },
          { symbol: "ORBITAL", quantity: 0 },
        ],
      }),
    );
  });

  it("queues a cash and inventory delta edit for the engine", async () => {
    const f = await live();
    expect(
      await f.editAccount({
        cashDelta: -150.5,
        positions: [{ symbol: "AERIUM", delta: 4 }],
      }),
    ).toEqual({ statusCode: 202, body: { ok: true } });
    expect(publishCommand).toHaveBeenCalledWith(
      f.redis,
      ID,
      expect.objectContaining({
        type: "admin_set_account",
        userId: TRADER,
        cashDelta: -150.5,
        positions: [{ symbol: "AERIUM", delta: 4 }],
      }),
    );
    expect(vi.mocked(publishCommand).mock.calls[0]![2]).not.toHaveProperty(
      "cash",
    );
  });

  it("allows zeroing a held symbol that is no longer listed", async () => {
    const f = await live();
    f.tables.positions!.push({ challengeId: ID, userId: TRADER, symbol: "OLD" });
    expect(
      (await f.editAccount({ positions: [{ symbol: "OLD", quantity: 0 }] }))
        .statusCode,
    ).toBe(202);
  });

  it.each([
    ["an empty edit", {}],
    ["a fractional quantity", { positions: [{ symbol: "AERIUM", quantity: 1.5 }] }],
    ["a fractional delta", { positions: [{ symbol: "AERIUM", delta: 0.5 }] }],
    ["both cash and cashDelta", { cash: 10, cashDelta: 5 }],
    [
      "a row with both quantity and delta",
      { positions: [{ symbol: "AERIUM", quantity: 1, delta: 1 }] },
    ],
    ["a row with neither quantity nor delta", { positions: [{ symbol: "AERIUM" }] }],
    [
      "duplicate symbols",
      {
        positions: [
          { symbol: "AERIUM", quantity: 1 },
          { symbol: "AERIUM", quantity: 2 },
        ],
      },
    ],
  ])("rejects %s", async (_label: string, body: unknown) => {
    const f = await live();
    expect((await f.editAccount(body)).statusCode).toBe(400);
    expect(publishCommand).not.toHaveBeenCalled();
  });

  it("rejects unknown symbols, non-participants and challenges that are not live", async () => {
    const f = await live();
    expect(
      await f.editAccount({ positions: [{ symbol: "NOPE", quantity: 1 }] }),
    ).toEqual({
      statusCode: 400,
      body: { error: "unknown_symbol", symbol: "NOPE" },
    });
    expect(await f.editAccount({ cash: 1 }, OTHER)).toEqual({
      statusCode: 404,
      body: { error: "not_enrolled" },
    });
    f.tables.challenges![0].status = "paused";
    expect(await f.editAccount({ cash: 1 })).toEqual({
      statusCode: 409,
      body: { error: "challenge_not_live" },
    });
    f.tables.challenges![0].status = "live";
    f.tables.challenges![0].finalizedAt = new Date();
    expect((await f.editAccount({ cash: 1 })).statusCode).toBe(409);
    expect(publishCommand).not.toHaveBeenCalled();
  });
});

describe("admin reset coordination", () => {
  it("rejects live challenges before acquiring a lease or deleting anything", async () => {
    const f = await fixture("live");
    expect(await f.call()).toEqual({
      statusCode: 409,
      body: { error: "pause_before_reset" },
    });
    expect(f.redis.set).not.toHaveBeenCalled();
    expect(f.db.transaction).not.toHaveBeenCalled();
  });

  it("rejects any existing engine lease, including a draining paused runner", async () => {
    const f = await fixture();
    f.cache.set(redisKeys.engineLock(ID), "engine-owner");
    expect((await f.call()).statusCode).toBe(409);
    expect(f.db.transaction).not.toHaveBeenCalled();
    expect(f.cache.get(redisKeys.engineLock(ID))).toBe("engine-owner");
  });

  it("checks the canonical challenge lock even with uppercase UUID input", async () => {
    const f = await fixture();
    f.cache.set(redisKeys.engineLock(ID), "engine-owner");
    expect((await f.call(ID.toUpperCase())).statusCode).toBe(409);
    expect(f.redis.set.mock.calls[0]![0]).toBe(redisKeys.engineLock(ID));
  });

  it("atomically deletes all projections and checkpoints, restores draft config and cash, and clears dynamic caches", async () => {
    const f = await fixture();
    expect(await f.call()).toEqual({ statusCode: 200, body: { ok: true } });
    for (const name of deletedTables)
      expect(f.tables[name]).toEqual([
        { id: `${name}-other`, challengeId: OTHER },
      ]);
    expect(f.tables.challenges![0]).toMatchObject({
      status: "draft",
      frozen: false,
      finalizedAt: null,
      startsAt: null,
      endsAt: null,
      config: {
        symbols: [EDEN_EVENT_AERIUM],
        eden: {
          eventScript: true,
          bonds: [],
          etfs: [],
          options: EDEN_EVENT_OPTIONS,
        },
      },
    });
    expect(f.tables.participants).toEqual([
      { challengeId: ID, cash: 10000, startingCash: 10000, loanDebt: 0 },
      { challengeId: OTHER, cash: 9, startingCash: 9, loanDebt: 1 },
    ]);
    expect([...f.cache.keys()].some((key) => key.includes(ID))).toBe(false);
    expect([...f.cache.keys()].every((key) => key.includes(OTHER))).toBe(true);
    expect(f.active).toEqual(new Set([OTHER]));
    expect(f.db.transaction).toHaveBeenCalledTimes(1);
    expect(f.trace.indexOf("row-lock")).toBeLessThan(
      f.trace.indexOf("update:challenges"),
    );
    expect(f.trace.indexOf("update:challenges")).toBeLessThan(
      f.trace.indexOf("delete:trades"),
    );
    expect(f.trace.lastIndexOf("cache-delete")).toBeLessThan(
      f.trace.indexOf("commit"),
    );
    expect(f.trace.indexOf("commit")).toBeLessThan(f.trace.indexOf("released"));
    expect(f.redis.publish).not.toHaveBeenCalled();
  });

  it("rejects a start that wins the challenge row lock before reset", async () => {
    const f = await fixture();
    f.beforeTransaction(() => {
      f.tables.challenges![0].status = "live";
    });
    expect((await f.call()).body).toEqual({ error: "pause_before_reset" });
    expect(f.trace.some((step) => step.startsWith("delete:"))).toBe(false);
    expect(f.cache.has(redisKeys.engineLock(ID))).toBe(false);
  });

  it("rolls back every DB change when cache cleanup fails and releases only its own lease", async () => {
    const f = await fixture();
    const before = structuredClone(f.tables);
    f.beforeDelete(() => {
      throw new Error("redis unavailable");
    });
    await expect(f.call()).rejects.toThrow("redis unavailable");
    expect(f.tables).toEqual(before);
    expect(f.cache.has(redisKeys.engineLock(ID))).toBe(false);
  });

  it("aborts on ownership loss and never deletes a replacement owner's lease", async () => {
    const f = await fixture();
    const before = structuredClone(f.tables);
    f.beforeDelete(() => {
      f.cache.set(redisKeys.engineLock(ID), "replacement-owner");
    });
    await expect(f.call()).rejects.toThrow("reset_lock_lost");
    expect(f.tables).toEqual(before);
    expect(f.cache.get(redisKeys.engineLock(ID))).toBe("replacement-owner");
  });

  it("preserves custom symbols and instruments when eventScript is disabled", async () => {
    const f = await fixture();
    f.tables.challenges![0].config.eden.eventScript = false;
    const config = structuredClone(f.tables.challenges![0].config);
    await f.call();
    expect(f.tables.challenges![0].config).toEqual(config);
  });
});
