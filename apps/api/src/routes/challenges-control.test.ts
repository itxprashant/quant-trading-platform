import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "../../../../packages/core/node_modules/vitest/dist/index.js";
import { redisKeys, zChallengeConfig } from "@qtp/shared";

vi.doMock("../../../../packages/db/dist/index.js", () =>
  Object.fromEntries(
    [
      "challengeNews",
      "challenges",
      "engineCheckpoints",
      "participants",
      "users",
    ].map((name) => [name, { name, id: "id", challengeId: "challengeId" }]),
  ),
);
vi.doMock("../../node_modules/drizzle-orm/index.js", () => ({
  eq: (key: string, expected: any) => (row: any) =>
    String(row[key]).toLowerCase() === String(expected).toLowerCase(),
  and:
    (...filters: any[]) =>
    (row: any) =>
      filters.every((f) => !f || f(row)),
  or:
    (...filters: any[]) =>
    (row: any) =>
      filters.some((f) => f?.(row)),
  desc: (key: string) => key,
  isNull: vi.fn(),
  isNotNull: vi.fn(),
  ne: vi.fn(),
  sql: vi.fn(),
}));
vi.doMock("../../../../packages/bus/dist/index.js", () => ({
  getNewsFeed: vi.fn(),
  hasPremiumAccess: vi.fn(),
  listActiveChallenges: vi.fn(),
  markChallengeActive: vi.fn(),
  markChallengeInactive: vi.fn(),
  setNewsFeed: vi.fn(),
  setPrice: vi.fn(),
}));
const { challengeRoutes } = await import("./challenges.js");
const { markChallengeActive, setPrice } =
  await import("../../../../packages/bus/dist/index.js");
const ID = "aaaaaaaa-0000-4000-a000-000000000001";
const START = "2026-10-01T12:00:00.000Z";
const END = "2026-10-01T14:10:00.000Z";

async function fixture(status = "draft", checkpoint = false, scripted = true) {
  let row: any = {
    id: ID,
    slug: "test",
    name: "Test",
    description: null,
    type: "new_eden",
    status,
    config: zChallengeConfig.parse({
      symbols: [{ symbol: "AERIUM", initialPrice: 1000 }],
      eden: { eventScript: scripted },
    }),
    scoring: { kind: "directional" },
    startsAt: new Date(START),
    endsAt: new Date(END),
    createdAt: new Date(START),
    frozen: false,
  };
  const trace: string[] = [];
  const cache = new Map<string, string>();
  let beforeTransaction: (() => void) | undefined;
  const db: any = {
    query: {
      challenges: {
        findFirst: async ({ where }: any) =>
          where(row) ? structuredClone(row) : undefined,
      },
      engineCheckpoints: {
        findFirst: async () => (checkpoint ? { challengeId: ID } : undefined),
      },
    },
    select: () => ({
      from: () => ({
        where: (filter: any) => ({
          for: async () => {
            trace.push("locked");
            return filter(row) ? [structuredClone(row)] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: any) => ({
        where: (filter: any) => ({
          returning: async () => {
            if (!filter(row)) return [];
            trace.push("updated");
            Object.assign(row, structuredClone(values));
            return [structuredClone(row)];
          },
        }),
      }),
    }),
    transaction: vi.fn(async (run: any) => {
      beforeTransaction?.();
      const before = structuredClone(row);
      try {
        const result = await run(db);
        trace.push("committed");
        return result;
      } catch (error) {
        row = before;
        throw error;
      }
    }),
  };
  const redis = { get: vi.fn(async (key: string) => cache.get(key) ?? null) };
  vi.mocked(setPrice).mockImplementation(async () => {
    trace.push("price");
  });
  vi.mocked(markChallengeActive).mockImplementation(async () => {
    trace.push("active");
  });
  const handlers = new Map<string, any>();
  const app: any = {
    db,
    redis,
    authenticate: vi.fn(),
    requireAdmin: vi.fn(),
    optionalAuth: vi.fn(),
    get: vi.fn(),
    post: (path: string, ...args: any[]) =>
      handlers.set(`post:${path}`, args.at(-1)),
    patch: (path: string, ...args: any[]) =>
      handlers.set(`patch:${path}`, args.at(-1)),
  };
  await challengeRoutes(app);
  const call = async (method: string, path: string, body: unknown, id = ID) => {
    const reply: any = {
      statusCode: 200,
      payload: undefined,
      code: (code: number) => {
        reply.statusCode = code;
        return reply;
      },
      send: (payload: unknown) => {
        reply.payload = payload;
        return reply;
      },
    };
    const result = await handlers.get(`${method}:${path}`)(
      { params: { id }, body },
      reply,
    );
    return { statusCode: reply.statusCode, body: reply.payload ?? result };
  };
  return {
    db,
    cache,
    trace,
    redis,
    row: () => row,
    patch: (body: unknown) => call("patch", "/:id", body),
    status: (next: string, id = ID) =>
      call("post", "/:id/status", { status: next }, id),
    beforeTransaction: (run: () => void) => {
      beforeTransaction = run;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("challenge clock/config guards", () => {
  it.each(["live", "paused", "ended"])(
    "rejects changed clocks while %s without a checkpoint",
    async (status: string) => {
      const f = await fixture(status);
      expect(await f.patch({ startsAt: "2026-10-02T12:00:00.000Z" })).toEqual({
        statusCode: 409,
        body: { error: "event_clock_immutable" },
      });
      expect(
        (await f.patch({ endsAt: "2026-10-02T14:10:00.000Z" })).statusCode,
      ).toBe(409);
      expect(f.row().startsAt).toEqual(new Date(START));
    },
  );

  it("keeps clocks immutable for draft/scheduled rows with a checkpoint", async () => {
    for (const status of ["draft", "scheduled"]) {
      const f = await fixture(status, true);
      expect(
        (await f.patch({ endsAt: "2026-10-02T14:10:00.000Z" })).statusCode,
      ).toBe(409);
    }
  });

  it("allows initial scheduling and script configuration before startup", async () => {
    const f = await fixture();
    const config = {
      ...f.row().config,
      eden: { ...f.row().config.eden, eventScript: false },
    };
    expect(
      (await f.patch({ startsAt: "2026-10-02T12:00:00.000Z", config }))
        .statusCode,
    ).toBe(200);
    expect(f.row().config.eden.eventScript).toBe(false);
  });

  it("rejects script toggles and all config replacement after a script starts", async () => {
    const f = await fixture("paused");
    const config = structuredClone(f.row().config);
    config.eden.eventScript = false;
    expect((await f.patch({ config })).body).toEqual({
      error: "event_clock_immutable",
    });
    config.eden.eventScript = true;
    config.maxOrderQuantity += 1;
    expect((await f.patch({ config })).body).toEqual({
      error: "started_event_config_immutable",
    });
    expect((await f.patch({ type: "directional" })).statusCode).toBe(409);
  });

  it("allows metadata and identical clock values without replacing running config", async () => {
    const f = await fixture("live");
    expect(
      (await f.patch({ name: "Renamed", startsAt: START, endsAt: END }))
        .statusCode,
    ).toBe(200);
    expect(f.row().name).toBe("Renamed");
  });

  it("does not block non-script config edits but still prevents enabling a script after startup", async () => {
    const f = await fixture("live", false, false);
    const config = structuredClone(f.row().config);
    config.maxOrderQuantity += 1;
    expect((await f.patch({ config })).statusCode).toBe(200);
    config.eden.eventScript = true;
    expect((await f.patch({ config })).statusCode).toBe(409);
  });
});

describe("reset-aware lifecycle starts", () => {
  it.each(["live", "scheduled"])(
    "rejects %s while reset holds the canonical lease",
    async (status: string) => {
      const f = await fixture("paused");
      f.cache.set(redisKeys.engineLock(ID), "reset:owner");
      expect(await f.status(status, ID.toUpperCase())).toEqual({
        statusCode: 409,
        body: { error: "reset_in_progress" },
      });
      expect(f.db.transaction).not.toHaveBeenCalled();
      expect(markChallengeActive).not.toHaveBeenCalled();
    },
  );

  it("rechecks the reset lease after taking the lifecycle row lock", async () => {
    const f = await fixture("paused");
    f.beforeTransaction(() => {
      f.cache.set(redisKeys.engineLock(ID), "reset:racing");
    });
    expect((await f.status("live")).body).toEqual({
      error: "reset_in_progress",
    });
    expect(f.row().status).toBe("paused");
    expect(f.trace).not.toContain("updated");
  });

  it("allows normal engine ownership and seeds prices before releasing the row lock", async () => {
    const f = await fixture("paused");
    f.cache.set(redisKeys.engineLock(ID), "engine:normal-owner");
    expect((await f.status("live")).statusCode).toBe(200);
    expect(f.trace).toEqual([
      "locked",
      "updated",
      "price",
      "active",
      "committed",
    ]);
  });
});
