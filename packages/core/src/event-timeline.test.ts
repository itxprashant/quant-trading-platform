import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EventExecutor,
  type EventExecutorDependencies,
} from "../../../apps/engine/src/event-executor.js";
import {
  EventTimeline,
  eventActionUuid,
  type EventActionContext,
} from "../../../apps/engine/src/event-timeline.js";
import {
  EDEN_EVENT_ACTIONS,
  EDEN_EVENT_NEWS,
  EDEN_EVENT_OTC,
  type EdenEventAction,
} from "../../shared/src/eden-event.js";
import { edenEventStateAt } from "../../shared/src/eden-clock.js";
import { EDEN_EVENT_BONDS } from "../../shared/src/eden-presets.js";

vi.mock("../../shared/dist/index.js", async (original) => ({
  ...(await original<object>()),
  ...(await import("../../shared/src/eden-clock.js")),
  ...(await import("../../shared/src/eden-presets.js")),
  ...(await import("../../shared/src/eden-event.js")),
}));
const bus = vi.hoisted(() => ({
  publishBroadcast: vi.fn(async () => {}),
  hasPremiumAccess: vi.fn(
    async (_redis: unknown, _challenge: string, userId: string) =>
      userId === "alice",
  ),
  getNewsFeed: vi.fn(async () => []),
  setNewsFeed: vi.fn(async () => {}),
  setFairValue: vi.fn(async () => {}),
}));
vi.mock("../../bus/dist/index.js", () => bus);
vi.mock("../../db/dist/index.js", () => {
  const table = (name: string, fields: string[]) =>
    Object.fromEntries([
      ["name", name],
      ...fields.map((field) => [field, field]),
    ]);
  return {
    auctions: table("auctions", ["id", "challengeId"]),
    challengeNews: table("news", ["id", "challengeId", "effectsAppliedAt"]),
    challenges: table("challenges", ["id"]),
    fairValues: table("fairValues", ["challengeId", "symbol"]),
    grantMissions: table("grants", ["id", "challengeId"]),
    optionContracts: table("contracts", [
      "challengeId",
      "underlying",
      "optionType",
      "status",
      "expiresAt",
    ]),
    otcOffers: table("offers", ["id", "challengeId"]),
    participants: table("participants", ["challengeId", "userId", "joinedAt"]),
    users: table("users", ["id", "displayName", "role"]),
    voteBallots: table("ballots", ["proposalId"]),
    voteProposals: table("votes", ["id", "challengeId"]),
  };
});
vi.mock("../../../apps/engine/node_modules/drizzle-orm/index.js", () => ({
  eq: (key: string, value: unknown) => (row: any) => row[key] === value,
  gt: (key: string, value: number | Date) => (row: any) => row[key] > value,
  lte: (key: string, value: number | Date) => (row: any) => row[key] <= value,
  isNull: (key: string) => (row: any) => row[key] === null,
  inArray: (key: string, values: unknown[]) => (row: any) =>
    values.includes(row[key]),
  and:
    (...filters: Array<(row: any) => boolean>) =>
    (row: any) =>
      filters.every((f) => f(row)),
  asc: (key: string) => key,
}));

// Tiny transactional fake tests adapter behavior, not SQL isolation or the parent checkpoint.
function fixture() {
  const tables: Record<string, any[]> = {
    auctions: [],
    news: [],
    fairValues: [],
    grants: [],
    contracts: [],
    offers: [],
    votes: [],
    ballots: [],
    challenges: [
      {
        id: "event",
        config: {
          symbols: [],
          eden: { bonds: [], etfs: [] },
          unrelated: "keep",
        },
      },
    ],
    participants: ["bob", "alice", "admin"].map((id) => ({
      id,
      userId: id,
      displayName: id,
      challengeId: "event",
      role: id === "admin" ? "admin" : "trader",
      joinedAt: new Date(0),
    })),
  };
  const db: any = {
    select: () => ({
      from: (table: any) => {
        let filter = (_row: any) => true;
        let order: string | undefined;
        const rows = () =>
          tables[table.name]!.filter(filter)
            .map((r) => structuredClone(r))
            .sort((a, b) =>
              order ? String(a[order]).localeCompare(String(b[order])) : 0,
            );
        const query = {
          innerJoin: () => query,
          where: (f: any) => {
            filter = f;
            return query;
          },
          orderBy: (key: string) => {
            order = key;
            return query;
          },
          for: () => query,
          then: (resolve: any, reject: any) =>
            Promise.resolve(rows()).then(resolve, reject),
        };
        return query;
      },
    }),
    insert: (table: any) => ({
      values: (value: any) => ({
        onConflictDoNothing: async () => {
          for (const row of Array.isArray(value) ? value : [value]) {
            if (!tables[table.name]!.some((r) => r.id === row.id))
              tables[table.name]!.push({
                cutoff: null,
                winnerId: null,
                ...structuredClone(row),
              });
          }
        },
        onConflictDoUpdate: async ({ set }: any) => {
          const existing = tables[table.name]!.find(
            (r) =>
              r.challengeId === value.challengeId && r.symbol === value.symbol,
          );
          if (existing) Object.assign(existing, structuredClone(set));
          else tables[table.name]!.push(structuredClone(value));
        },
      }),
    }),
    update: (table: any) => ({
      set: (values: any) => ({
        where: async (filter: any) => {
          for (const row of tables[table.name]!.filter(filter))
            Object.assign(row, structuredClone(values));
        },
      }),
    }),
    transaction: async (fn: any) => {
      const snapshot = structuredClone(tables);
      try {
        return await fn(db);
      } catch (error) {
        Object.assign(tables, snapshot);
        throw error;
      }
    },
  };
  const fvs = new Map([
    ["AERIUM", 1000],
    ["NEURO", 500],
    ["ORBITAL", 2500],
  ]);
  const prices = new Map(fvs);
  const holdings = new Map<string, Record<string, number>>();
  const engine = {
    getFairValue: (symbol: string) => fvs.get(symbol),
    setFairValue: (symbol: string, value: number) => {
      fvs.set(symbol, value);
      return value;
    },
    getPrice: (symbol: string) => prices.get(symbol),
    cashOf: (userId: string) => (userId === "alice" ? 20000 : 10000),
    positionOf: (userId: string, symbol: string) =>
      holdings.get(userId)?.[symbol] ?? 0,
    symbols: () => [...fvs.keys()],
    isSymbolOpen: (symbol: string) => fvs.has(symbol),
  };
  const callback = () => vi.fn(async () => {});
  const deps = {
    db,
    challenge: {
      id: "event",
      frozen: false,
      config: structuredClone(tables.challenges![0].config),
    },
    redis: {},
    engine,
    minuteMs: 60_000,
    emit: callback(),
    addSpotSymbol: callback(),
    addEtf: callback(),
    addBond: callback(),
    openOptions: callback(),
    setFrozen: callback(),
    resolveAuction: callback(),
    resolveVote: callback(),
    awardGrant: callback(),
    rescueLoans: callback(),
    setVolatility: vi.fn(),
    prepareVega: vi.fn(),
    resolveVega: callback(),
    newsPulse: vi.fn(),
    setEtfWindow: callback(),
    finalize: callback(),
  };
  const executor = new EventExecutor(
    deps as unknown as EventExecutorDependencies,
  );
  return { executor, deps, tables, fvs, prices, holdings };
}

const start = 1_700_000_000_000;
function context(
  action: EdenEventAction,
  now = start + action.atSecond * 1000,
  minuteMs = 60_000,
): EventActionContext {
  return {
    challengeId: "event",
    actionUuid: eventActionUuid("event", action.id),
    now,
    scheduledAt: start + (action.atSecond * minuteMs) / 60,
    secondMs: minuteMs / 60,
    lateByMs: 0,
    timestampAtSecond: (second) => start + (second * minuteMs) / 60,
    resourceUuid: (key) => eventActionUuid("event", key),
  };
}
function action(id: string) {
  const item = EDEN_EVENT_ACTIONS.find((a) => a.id === `eden-v1/${id}`);
  if (!item) throw new Error(`Missing test action ${id}`);
  return item;
}
async function run(f: ReturnType<typeof fixture>, id: string, now?: number) {
  const item = action(id);
  await f.executor.execute(item, context(item, now));
}
beforeEach(() => vi.clearAllMocks());

describe("script schedule and dispatcher", () => {
  it("preserves labels, timing and unique receipts", () => {
    // Replacing the minute-130 pair with minute 70 leaves 107 total actions.
    expect(EDEN_EVENT_ACTIONS).toHaveLength(107);
    expect(new Set(EDEN_EVENT_ACTIONS.map((a) => a.id)).size).toBe(107);
    expect(EDEN_EVENT_NEWS).toHaveLength(24);
    expect(
      EDEN_EVENT_NEWS.filter((n) => n.classification === "signal"),
    ).toHaveLength(12);
    expect(
      EDEN_EVENT_NEWS.filter((n) => n.classification === "noise"),
    ).toHaveLength(12);
    expect(EDEN_EVENT_NEWS.map((n) => n.minute)).toEqual(
      Array.from({ length: 25 }, (_, i) => (i + 1) * 5).filter(
        (minute) => minute !== 65,
      ),
    );
    for (const [minute, headline] of [
      [5, "Refinery strike in Sector 4 cuts Aerium output by 12%."],
      [15, "New extraction tax levied on raw Aerium. Processing costs up 8%."],
      [
        25,
        "Smugglers busted with 50,000 tons of counterfeit Aerium; market supply shocks.",
      ],
      [
        30,
        "Neuro-Chips approved for civilian use! Deep silicon linkage established with Aerium.",
      ],
      [40, "Cobalt shortage cripples Neuro-Chip assembly lines."],
      [75, "Options expire. Massive Gamma squeeze observed on Neuro-Chips."],
      [90, "Zero-point energy prototype successful! Aerium obsolete!"],
      [115, "Solar flare scrambles Neuro-Chip logic gates globally!"],
      [125, "Massive cyberattack disables 40% of remaining Aerium grid."],
    ] as const) {
      expect(EDEN_EVENT_NEWS.find((n) => n.minute === minute)).toMatchObject({
        classification: "signal",
        original: true,
        headline,
      });
    }
    for (const [minute, headline] of [
      [
        10,
        "Senate sub-committee discussing long-term viability of Aerium infrastructure.",
      ],
      [20, "Celebrity influencer 'Nova' endorses Aerium on holonet."],
      [
        35,
        "Unverified rumor: Neuro-Chip CEO seen leaving rival's headquarters.",
      ],
      [
        50,
        "Orbital-Station quarterly earnings report delayed by 1 hour due to clerical error.",
      ],
      [
        85,
        "Analyst downgrades Neuro-Chips to 'Hold', citing lack of innovation.",
      ],
      [
        95,
        "Mass protests in the capital against zero-point energy safety risks.",
      ],
      [110, "CEO of Orbital Station tweets a rocket emoji."],
    ] as const) {
      expect(EDEN_EVENT_NEWS.find((n) => n.minute === minute)).toMatchObject({
        classification: "noise",
        original: true,
        headline,
      });
    }
    expect(EDEN_EVENT_NEWS.find((n) => n.minute === 55)).toMatchObject({
      classification: "signal",
      effects: [{ symbol: "AERIUM", operation: "cap", value: 1150 }],
    });
    expect(EDEN_EVENT_ACTIONS.filter((a) => a.kind === "news")).toHaveLength(
      48,
    );
    expect(EDEN_EVENT_ACTIONS.filter((a) => a.atSecond === 130 * 60)).toEqual([
      action("end"),
    ]);
    expect(EDEN_EVENT_OTC.filter((o) => o.original)).toHaveLength(6);
    expect(EDEN_EVENT_BONDS.map((b) => b.maxPerUser)).toEqual([1, 1]);
    expect(
      EDEN_EVENT_ACTIONS.indexOf(action("auction/90/resolve")),
    ).toBeLessThan(EDEN_EVENT_ACTIONS.indexOf(action("news/90/premium")));
    expect(
      action("auction/90/resolve").atSecond -
        action("auction/90/open").atSecond,
    ).toBe(30);
    expect(EDEN_EVENT_ACTIONS.indexOf(action("news/90/public"))).toBeLessThan(
      EDEN_EVENT_ACTIONS.indexOf(action("vega/resolve")),
    );
  });

  it("establishes introduction FVs before public news without additive shocks", () => {
    for (const [minute, listing] of [
      [45, "list/orbital"],
      [70, "options/open"],
    ] as const) {
      const premium = action(`news/${minute}/premium`);
      const publicNews = action(`news/${minute}/public`);
      expect(EDEN_EVENT_NEWS.find((n) => n.minute === minute)).toMatchObject({
        classification: "signal",
        effects: [],
        original: false,
      });
      expect(premium.atSecond).toBe(minute * 60 - 10);
      expect(publicNews.atSecond).toBe(minute * 60);
      expect(action(listing).atSecond).toBe(publicNews.atSecond);
      expect(EDEN_EVENT_ACTIONS.indexOf(action(listing))).toBeLessThan(
        EDEN_EVENT_ACTIONS.indexOf(publicNews),
      );
    }
    expect(edenEventStateAt(action("news/70/premium").atSecond).phase).toBe(
      "halftime",
    );
    expect(EDEN_EVENT_ACTIONS.indexOf(action("unfreeze"))).toBeLessThan(
      EDEN_EVENT_ACTIONS.indexOf(action("options/open")),
    );
    expect(EDEN_EVENT_NEWS.some((n) => n.minute === 130)).toBe(false);
  });

  it.each([60_000, 1000, 60])(
    "fires exact epoch boundaries at minuteMs=%s",
    async (minuteMs) => {
      const executed: string[] = [];
      const timeline = new EventTimeline({
        challengeId: "event",
        enabled: true,
        startsAt: start,
        minuteMs,
        loadCompletedActionIds: async () => [],
        execute: async (a) => {
          executed.push(a.id);
        },
      });
      for (const item of EDEN_EVENT_ACTIONS) {
        await timeline.tick(start + item.atSecond * (minuteMs / 60));
        expect(executed).toEqual(
          EDEN_EVENT_ACTIONS.filter((a) => a.atSecond <= item.atSecond).map(
            (a) => a.id,
          ),
        );
      }
    },
  );

  it("serializes ticks, restores receipts and retries a failed action", async () => {
    const completed = new Set<string>([action("open").id]);
    const execute = vi.fn(async (a: EdenEventAction) => {
      completed.add(a.id);
    });
    execute.mockRejectedValueOnce(new Error("temporary"));
    const deps = {
      challengeId: "event",
      enabled: true,
      startsAt: start,
      loadCompletedActionIds: async () => completed,
      execute,
    };
    const timeline = new EventTimeline(deps);
    await expect(timeline.tick(start + 150000)).rejects.toThrow("temporary");
    await Promise.all([
      timeline.tick(start + 150000),
      timeline.tick(start + 150000),
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await new EventTimeline(deps).tick(start + 150000)).toEqual([]);
    expect(eventActionUuid("event", "key")).not.toBe(
      eventActionUuid("other", "key"),
    );
  });
});

describe("script executor", () => {
  it("releases premium options news during halftime without opening options early", async () => {
    const f = fixture();
    await run(f, "freeze");
    await run(f, "news/70/premium");
    expect(f.deps.challenge.frozen).toBe(true);
    expect(f.deps.openOptions).not.toHaveBeenCalled();
    expect(f.deps.emit).not.toHaveBeenCalled();
    expect(f.deps.newsPulse).not.toHaveBeenCalled();
    expect(f.tables.news![0]).toMatchObject({
      kind: "signal",
      fvEffects: [],
      effectsAppliedAt: null,
    });
    expect(f.tables.news![0].publishAt).toEqual(
      new Date(start + (70 * 60 - 10) * 1000),
    );
    expect(
      bus.publishBroadcast.mock.calls
        .flatMap((args: any[]) => args[2])
        .map((envelope: any) => envelope.target),
    ).toEqual(["alice"]);
    await run(f, "unfreeze");
    await run(f, "options/open");
    await run(f, "news/70/public");
    expect(f.deps.challenge.frozen).toBe(false);
    expect(f.deps.openOptions).toHaveBeenCalledTimes(1);
    expect(f.tables.news![0].effectsAppliedAt).toEqual(
      new Date(start + 70 * 60000),
    );
    expect(f.tables.news![0].fvEffects).toEqual([]);
    expect(f.deps.emit).not.toHaveBeenCalled();
  });

  it("replays the complete public FV path without duplicating effects", async () => {
    const f = fixture();
    for (const item of EDEN_EVENT_ACTIONS) {
      if (item.kind === "news" && item.audience === "public") {
        await f.executor.execute(item, context(item));
        await f.executor.execute(item, context(item));
        if (item.news.minute === 55) {
          expect(f.fvs.get("AERIUM")).toBe(1110);
          expect(f.tables.news!.at(-1).fvEffects).toEqual([
            { symbol: "AERIUM", delta: 0 },
          ]);
        }
      }
    }
    expect(f.fvs.get("AERIUM")).toBe(930);
    expect(f.fvs.get("NEURO")).toBe(700);
    expect(f.tables.news).toHaveLength(24);
    expect(f.tables.news!.every((row) => row.effectsAppliedAt !== null)).toBe(
      true,
    );
  });

  it("rolls back a multi-symbol FV failure before mutating engine state", async () => {
    const f = fixture();
    const insert = f.deps.db.insert;
    let writes = 0;
    const spy = vi
      .spyOn(f.deps.db, "insert")
      .mockImplementation((table: any) => {
        if (table.name === "fairValues" && ++writes === 2)
          throw new Error("DB failure");
        return insert(table);
      });
    await expect(run(f, "news/90/public")).rejects.toThrow("DB failure");
    expect(f.tables.fairValues).toHaveLength(0);
    expect(f.tables.news![0].effectsAppliedAt).toBeNull();
    expect(f.fvs.get("AERIUM")).toBe(1000);
    expect(f.fvs.get("NEURO")).toBe(500);
    spy.mockRestore();
    await run(f, "news/90/public");
    expect(f.fvs.get("AERIUM")).toBe(700);
    expect(f.fvs.get("NEURO")).toBe(700);
  });

  it("keeps premium effects private and applies public FV once across retries", async () => {
    const f = fixture();
    await run(f, "news/5/premium");
    expect(f.fvs.get("AERIUM")).toBe(1000);
    expect(f.deps.emit).not.toHaveBeenCalled();
    expect(f.deps.newsPulse).not.toHaveBeenCalled();
    expect(
      bus.publishBroadcast.mock.calls
        .flatMap((args: any[]) => args[2])
        .map((e: any) => e.target),
    ).toEqual(["alice"]);
    const item = (bus.publishBroadcast.mock.calls[0] as any)[2][0].msg.data;
    expect(item).not.toHaveProperty("kind");
    expect(item).not.toHaveProperty("fvEffects");
    expect(item).not.toHaveProperty("momentum");
    await run(f, "news/5/public");
    await run(f, "news/5/public");
    expect(f.tables.news).toHaveLength(1);
    expect(f.fvs.get("AERIUM")).toBe(1050);
    expect(f.deps.emit).toHaveBeenCalledTimes(1);
    expect(f.deps.newsPulse).toHaveBeenCalledTimes(1);
    expect(f.tables.news![0].effectsAppliedAt).toEqual(
      new Date(start + 300000),
    );
  });

  it("honors a poller receipt, caps at public time, and repairs post-commit cache failure", async () => {
    const f = fixture();
    f.fvs.set("AERIUM", 1200);
    await run(f, "news/55/premium");
    f.fvs.set("AERIUM", 1250);
    bus.setFairValue.mockRejectedValueOnce(new Error("redis down"));
    await expect(run(f, "news/55/public")).rejects.toThrow("redis down");
    await run(f, "news/55/public");
    expect(f.fvs.get("AERIUM")).toBe(1150);
    expect(f.tables.news![0].fvEffects).toEqual([
      { symbol: "AERIUM", delta: -100 },
    ]);
    expect(f.tables.fairValues![0].fairValue).toBe(1150);
    expect(f.deps.emit).not.toHaveBeenCalled();
    expect(f.deps.newsPulse).not.toHaveBeenCalled();
  });

  it("persists dynamic config before callbacks and preserves unrelated config", async () => {
    const f = fixture();
    f.deps.addSpotSymbol.mockImplementation(async () => {
      expect(
        f.tables.challenges![0].config.symbols.some(
          (s: any) => s.symbol === "NEURO",
        ),
      ).toBe(true);
    });
    await run(f, "list/neuro");
    await run(f, "list/neuro");
    await run(f, "list/orbital");
    await run(f, "bond/standard");
    await run(f, "options/open");
    const config = f.tables.challenges![0].config;
    expect(config.symbols).toHaveLength(1);
    expect(config.eden.etfs[0].basket).toEqual([
      { symbol: "AERIUM", weight: 2 },
      { symbol: "NEURO", weight: 1 },
    ]);
    expect(config.eden.bonds[0].payoutMultiplier).toBe(2);
    expect(config.eden.options.enabled).toBe(true);
    expect(config.unrelated).toBe("keep");
    expect(f.deps.challenge.config).toEqual(config);
  });

  it("uses deterministic auction/vote/grant rows and suppresses stale opening broadcasts", async () => {
    const f = fixture();
    for (const id of ["auction/15/open", "vote/open", "grant/open"]) {
      await run(f, id, start + 130 * 60000);
      await run(f, id, start + 130 * 60000);
    }
    expect(f.tables.auctions).toHaveLength(1);
    expect(f.tables.votes).toHaveLength(1);
    expect(f.tables.grants).toHaveLength(1);
    expect(bus.publishBroadcast).not.toHaveBeenCalled();
    await run(f, "auction/15/resolve");
    await run(f, "vote/resolve");
    await run(f, "grant/award");
    expect(f.deps.resolveAuction).toHaveBeenCalledWith(
      f.tables.auctions![0].id,
      start + 890000,
      start + 1790000,
    );
    expect(f.deps.resolveVote).toHaveBeenCalledWith(
      f.tables.votes![0].id,
      start + 81 * 60000,
    );
    expect(f.deps.awardGrant).toHaveBeenCalledWith(
      f.tables.grants![0].id,
      start + 105 * 60000,
    );
  });

  it("does not reset live ballot totals when a vote opening is retried", async () => {
    const f = fixture();
    await run(f, "vote/open");
    const id = f.tables.votes![0].id;
    f.tables.ballots!.push({ proposalId: id, choice: "yes" });
    await run(f, "vote/open");
    const message = (bus.publishBroadcast.mock.lastCall as any)[2][0].msg;
    expect(message.data.yes).toBe(1);
    expect(message.data.description).toContain("alice");
    expect(f.tables.votes).toHaveLength(1);
  });

  it("creates all six prescribed OTC terms for every human, freezing runtime terms on retry", async () => {
    const f = fixture();
    f.prices.set("AERIUM", 1005);
    f.fvs.set("CALL", 20);
    f.tables.contracts!.push({
      id: "call",
      challengeId: "event",
      symbol: "CALL",
      underlying: "AERIUM",
      optionType: "call",
      strike: 1000,
      status: "open",
      expiresAt: new Date(start + 75 * 60000),
    });
    f.holdings.set("alice", { AERIUM: 60, NEURO: 20 });
    f.holdings.set("bob", { NEURO: 12 });
    for (const minute of [12.5, 32.5, 52.5, 72.5, 92.5, 112.5])
      await run(f, `otc/${minute}`);
    expect(f.tables.offers).toHaveLength(12);
    expect(f.tables.offers!.some((r) => r.userId === "admin")).toBe(false);
    const rows = f.tables.offers!.filter((r) => r.userId === "alice");
    expect(rows.map((r) => r.legs)).toEqual([
      [{ symbol: "AERIUM", quantity: 50, price: 950 }],
      [
        { symbol: "AERIUM", quantity: -20, price: 0 },
        { symbol: "NEURO", quantity: 20, price: 0 },
      ],
      [{ symbol: "ORBITAL", quantity: 10, price: 2550 }],
      [{ symbol: "CALL", quantity: -15, price: 6 }],
      [{ symbol: "AERIUM", quantity: 30, price: 1200 }],
      [{ symbol: "AERIUM", quantity: -50, price: 900 }],
    ]);
    expect(rows.every((r) => r.cashToTrader === 0)).toBe(true);
    expect(rows[5].description).toContain("choose exactly one");
    expect(rows[5].choices).toEqual([
      { symbol: "AERIUM", quantity: -50, price: 900 },
      { symbol: "NEURO", quantity: -20, price: 450 },
    ]);
    f.fvs.set("AERIUM", 4000);
    f.holdings.set("alice", { AERIUM: 2, NEURO: 99 });
    await run(f, "otc/12.5");
    await run(f, "otc/112.5");
    expect(f.tables.offers).toHaveLength(12);
    expect(rows[0].legs[0].price).toBe(950);
    expect(rows[5].choices[0]).toEqual({
      symbol: "AERIUM",
      quantity: -50,
      price: 900,
    });
    expect(
      bus.publishBroadcast.mock.calls
        .flatMap((args: any[]) => args[2])
        .every((e: any) => e.target !== "all"),
    ).toBe(true);
  });

  it("skips halted/expired OTC, missing calls, missing bailout holdings, and late Vega preparation", async () => {
    const f = fixture();
    await run(f, "otc/62.5");
    await run(f, "otc/12.5", start + 14 * 60000);
    await run(f, "otc/72.5");
    await run(f, "otc/112.5");
    await run(f, "vega/prepare", start + 90 * 60000);
    expect(f.tables.offers).toHaveLength(0);
    expect(f.deps.prepareVega).not.toHaveBeenCalled();
    await run(f, "etf/55/open", start + 56 * 60000);
    expect(f.deps.setEtfWindow).toHaveBeenCalledWith(
      "ORBITAL",
      false,
      start + 55 * 60000,
    );
  });

  it("delegates lifecycle, Vega and finalization in order without writing receipts", async () => {
    const f = fixture();
    await run(f, "freeze");
    expect(f.deps.setFrozen).toHaveBeenLastCalledWith(true);
    expect(f.deps.rescueLoans).toHaveBeenCalledWith(start + 60 * 60000);
    await run(f, "unfreeze");
    expect(f.deps.challenge.frozen).toBe(false);
    await run(f, "vega/prepare");
    expect(f.deps.prepareVega).toHaveBeenCalledWith(
      "AERIUM",
      start + 90 * 60000,
      start + 89 * 60000,
    );
    await run(f, "vega/resolve");
    await run(f, "volatility/triple");
    expect(f.deps.setVolatility).toHaveBeenCalledWith(3);
    await run(f, "end");
    expect(f.deps.finalize).toHaveBeenCalledWith(start + 130 * 60000);
    expect(f.deps.challenge.frozen).toBe(true);
    expect(f.tables).not.toHaveProperty("eventActions");
  });
});
