import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "../../../../packages/core/node_modules/vitest/dist/index.js";

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
    ].map((name) => [name, { name, id: "id", challengeId: "challengeId" }]),
  ),
);
vi.doMock("../../node_modules/drizzle-orm/index.js", () => ({
  eq: (key: string, expected: any) => (row: any) =>
    String(row[key]).toLowerCase() === String(expected).toLowerCase(),
  and:
    (...filters: any[]) =>
    (row: any) =>
      filters.every((f) => f(row)),
  desc: (key: string) => key,
}));
vi.doMock("../../../../packages/bus/dist/index.js", () => ({
  getLeaderboard: vi.fn(async () => LIVE),
  getFairValues: vi.fn(),
  getListedSymbols: vi.fn(async () => []),
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
const { leaderboardRoutes } = await import("./leaderboard.js");
const { publishBroadcast } =
  await import("../../../../packages/bus/dist/index.js");

const ID = "aaaaaaaa-0000-4000-a000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-a000-000000000002";
const LIVE = [
  { userId: "t1", displayName: "Trader", rank: 1, pnl: 10, score: 10 },
];

// Mocked database and Redis; nothing here touches a real store.
async function fixture(leaderboardHidden: boolean) {
  const rows: any[] = [
    { id: ID, status: "live", leaderboardHidden, finalResults: null },
  ];
  const db: any = {
    query: {
      challenges: {
        findFirst: async ({ where }: any) =>
          structuredClone(rows.find(where)),
      },
    },
    update: () => ({
      set: (values: any) => ({
        where: async (filter: any) => {
          for (const row of rows.filter(filter)) Object.assign(row, values);
        },
      }),
    }),
  };
  const handlers = new Map<string, any>();
  const register = (method: string) => (path: string, ...args: any[]) =>
    handlers.set(`${method} ${path}`, args.at(-1));
  const app: any = {
    db,
    redis: {},
    requireAdmin: vi.fn(),
    optionalAuth: vi.fn(),
    log: { error: vi.fn() },
    addHook: vi.fn(),
    get: register("GET"),
    patch: register("PATCH"),
    post: register("POST"),
  };
  await leaderboardRoutes(app);
  const leaderboardGet = handlers.get("GET /:challengeId");
  handlers.clear();
  await adminRoutes(app);

  const call = async (handler: any, req: any) => {
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
    const result = await handler(req, reply);
    return { statusCode: reply.statusCode, body: reply.payload ?? result };
  };
  return {
    rows,
    view: (role?: "trader" | "admin", id = ID) =>
      call(leaderboardGet, {
        params: { challengeId: id },
        user: role ? { sub: role, role } : undefined,
      }),
    toggle: (body: unknown, id = ID) =>
      call(handlers.get("POST /:challengeId/leaderboard-visibility"), {
        params: { challengeId: id },
        body,
        user: { sub: "admin", role: "admin" },
        log: { info: vi.fn() },
      }),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("leaderboard visibility on the public route", () => {
  it("serves rankings to everyone while visible", async () => {
    const f = await fixture(false);
    for (const role of [undefined, "trader", "admin"] as const)
      expect(await f.view(role)).toEqual({ statusCode: 200, body: LIVE });
  });

  it("withholds rankings from traders and anonymous viewers while hidden", async () => {
    const f = await fixture(true);
    for (const role of [undefined, "trader"] as const)
      expect(await f.view(role)).toEqual({
        statusCode: 403,
        body: { error: "leaderboard_hidden" },
      });
    expect(await f.view("admin")).toEqual({ statusCode: 200, body: LIVE });
  });

  it("keeps final results hidden from traders too", async () => {
    const f = await fixture(true);
    f.rows[0].finalResults = LIVE;
    expect((await f.view("trader")).statusCode).toBe(403);
    expect((await f.view("admin")).body).toEqual(LIVE);
  });
});

describe("admin leaderboard visibility toggle", () => {
  it("persists the flag and broadcasts it to every subscriber", async () => {
    const f = await fixture(false);
    expect(await f.toggle({ hidden: true })).toEqual({
      statusCode: 200,
      body: { ok: true, hidden: true },
    });
    expect(f.rows[0].leaderboardHidden).toBe(true);
    expect(publishBroadcast).toHaveBeenCalledWith({}, ID, [
      {
        target: "all",
        msg: {
          type: "leaderboard_visibility",
          challengeId: ID,
          data: { hidden: true },
        },
      },
    ]);
    expect((await f.view("trader")).statusCode).toBe(403);

    await f.toggle({ hidden: false });
    expect(f.rows[0].leaderboardHidden).toBe(false);
    expect((await f.view("trader")).statusCode).toBe(200);
  });

  it("rejects unknown challenges and malformed bodies without writing", async () => {
    const f = await fixture(false);
    for (const id of [OTHER, "not-a-uuid"])
      expect(await f.toggle({ hidden: true }, id)).toEqual({
        statusCode: 404,
        body: { error: "not_found" },
      });
    expect((await f.toggle({ hidden: "yes" })).statusCode).toBe(400);
    expect(f.rows[0].leaderboardHidden).toBe(false);
    expect(publishBroadcast).not.toHaveBeenCalled();
  });
});
