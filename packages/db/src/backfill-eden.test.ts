// Keep the harness dependency runtime-only: the migrate image builds DB without core/Vitest.
const vitestPath = new URL(
  "../../core/node_modules/vitest/dist/index.js",
  import.meta.url,
).href;
const { afterEach, beforeEach, expect, it, vi } = await import(vitestPath);

const now = 1_800_000_000_000;
const cutoff = new Date(now - 60_000);
const cutoffArg = `--legacy-cutoff=${cutoff.toISOString()}`;
const originalArgv = process.argv;
type Row = Record<string, any>;
type Predicate = (row: Row) => boolean;
let data: Record<string, Row[]>;
let applied: Row[];
let failAt: number;
let execute: ReturnType<typeof vi.fn>;
let transaction: ReturnType<typeof vi.fn>;
let exit: ReturnType<typeof vi.spyOn>;

function legacy(id: string, totalRepay = 100) {
  return {
    id,
    challengeId: "event",
    userId: "trader",
    totalRepay,
    remaining: 999,
    installment: 0,
    nextPaymentAt: null,
    fundedAt: null,
    createdAt: new Date(now - 120_000),
    status: "active",
  };
}

function news(id: string, overrides: Row = {}) {
  return {
    id,
    publishedAt: new Date(now - 90_000),
    embargoUntil: new Date(now - 70_000),
    effectsAppliedAt: null,
    fvEffects: [{ symbol: "A", delta: 100 }],
    ...overrides,
  };
}

function ended(id: string, overrides: Row = {}) {
  return {
    id,
    status: "ended",
    createdAt: new Date(now - 120_000),
    finalizedAt: null,
    finalResults: [{ userId: "trader", score: 42 }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", "mock-explicit-target");
  vi.stubEnv("ENGINE_MINUTE_MS", "60000");
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  data = {
    loans: [legacy("a"), legacy("b")],
    challenges: [
      {
        id: "event",
        status: "live",
        createdAt: new Date(now - 120_000),
        finalizedAt: null,
        endsAt: new Date(now + 150_000),
      },
    ],
    participants: [
      {
        id: "p",
        challengeId: "event",
        userId: "trader",
        cash: 123,
        loanDebt: 150,
      },
    ],
    challengeNews: [],
    engineCheckpoints: [],
    scoreSnapshots: [{ challengeId: "old", userId: "trader", score: 42 }],
    fairValues: [{ challengeId: "event", symbol: "A", fairValue: 1100 }],
  };
  applied = [];
  failAt = Infinity;
  execute = vi.fn(async () => {});
  transaction = vi.fn(async (callback: any, config: any) => {
    const snapshot = structuredClone(data);
    const pending: Row[] = [];
    const tx = {
      execute,
      select: () => ({
        from: (table: Row) => ({
          where: (predicate: Predicate) => {
            const rows = structuredClone(data[table.name]!.filter(predicate));
            return Object.assign(Promise.resolve(rows), {
              orderBy: () =>
                Promise.resolve(
                  rows.sort(
                    (a, b) =>
                      a.createdAt - b.createdAt || a.id.localeCompare(b.id),
                  ),
                ),
            });
          },
        }),
      }),
      update: (table: Row) => {
        expect(["loans", "challengeNews", "challenges"]).toContain(table.name);
        expect(config.accessMode).toBe("read write");
        return {
          set: (values: Row) => ({
            where: (predicate: Predicate) => ({
              returning: async () => {
                if (pending.length === failAt)
                  throw new Error("secret DB connection failure");
                if (table.name === "challengeNews")
                  expect(Object.keys(values)).toEqual(["effectsAppliedAt"]);
                if (table.name === "challenges")
                  expect(Object.keys(values)).toEqual(["finalizedAt"]);
                const matches = data[table.name]!.filter(predicate);
                for (const row of matches) {
                  const next = Object.fromEntries(
                    Object.entries(values).map(([key, value]) => [
                      key,
                      typeof value === "function"
                        ? value(row)
                        : key === "fundedAt"
                          ? row[value]
                          : value,
                    ]),
                  );
                  Object.assign(row, next);
                  pending.push({ table: table.name, id: row.id, ...next });
                }
                return matches;
              },
            }),
          }),
        };
      },
    };
    try {
      const result = await callback(tx);
      applied.push(...pending);
      return result;
    } catch (error) {
      data = snapshot;
      throw error;
    }
  });
  vi.doMock("./client.js", () => ({ getDb: () => ({ transaction }) }));
  vi.doMock("./schema.js", () =>
    Object.fromEntries(
      [
        "loans",
        "participants",
        "challenges",
        "challengeNews",
        "engineCheckpoints",
      ].map((name) => [
        name,
        new Proxy(
          { name },
          { get: (target, key) => (key === "name" ? target.name : key) },
        ),
      ]),
    ),
  );
  vi.doMock("../node_modules/drizzle-orm/index.js", () => ({
    and:
      (...predicates: (Predicate | undefined)[]) =>
      (row: Row) =>
        predicates.every((p) => !p || p(row)),
    or:
      (...predicates: Predicate[]) =>
      (row: Row) =>
        predicates.some((p) => p(row)),
    eq: (key: string, value: any) => (row: Row) => row[key] === value,
    lt: (key: string, value: Date) => (row: Row) =>
      row[key] != null && row[key] < value,
    lte: (key: string, value: Date) => (row: Row) =>
      row[key] != null && row[key] <= value,
    inArray: (key: string, values: unknown[]) => (row: Row) =>
      values.includes(row[key]),
    isNull: (key: string) => (row: Row) => row[key] === null,
    isNotNull: (key: string) => (row: Row) => row[key] != null,
    asc: (key: string) => key,
    sql: (parts: TemplateStringsArray, ...columns: string[]) => {
      if (parts.join("").startsWith("greatest(")) {
        return (row: Row) =>
          new Date(
            Math.max(
              ...columns
                .filter((key) => row[key] != null)
                .map((key) => row[key].getTime()),
            ),
          );
      }
      return parts.join("");
    },
  }));
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function run(args: string[] = []) {
  process.argv = ["node", "backfill-eden.ts", ...args];
  await import("./backfill-eden.js");
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
}

function report() {
  const line = vi
    .mocked(console.log)
    .mock.calls.find(
      ([value]: unknown[]) =>
        typeof value === "string" && value.startsWith("{"),
    );
  return JSON.parse(line![0] as string);
}

it("defaults to a read-only dry run and reports unproven completion candidates", async () => {
  data.challengeNews = [
    news("old"),
    news("embargo", { embargoUntil: new Date(now + 1000) }),
  ];
  data.challenges!.push(ended("old"));
  const original = structuredClone(data);
  await run();
  expect(exit).toHaveBeenLastCalledWith(0);
  expect(data).toEqual(original);
  expect(applied).toEqual([]);
  expect(report()).toMatchObject({
    publishedNewsCandidates: 2,
    endedChallengeCandidates: 1,
    newsCompletions: 0,
    challengeCompletions: 0,
  });
  expect(transaction.mock.calls[0]![1]).toEqual({
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
});

it("applies exact FIFO debt, original funding dates and end-anchored installments", async () => {
  const participants = structuredClone(data.participants);
  await run(["--apply"]);
  expect(exit).toHaveBeenLastCalledWith(0);
  expect(applied.map((r) => r.remaining)).toEqual([100, 50]);
  expect(applied.reduce((sum, r) => sum + r.remaining, 0)).toBe(150);
  expect(applied[0]!.installment).toBe(100 / 3);
  expect(applied[0]!.nextPaymentAt).toEqual(new Date(now + 30_000));
  expect(applied[0]!.fundedAt).toEqual(new Date(now - 120_000));
  expect(data.participants).toEqual(participants);
  expect(
    execute.mock.calls.some(([query]: unknown[]) =>
      String(query).includes("challenge_news, engine_checkpoints"),
    ),
  ).toBe(true);
  vi.resetModules();
  exit.mockClear();
  await run(["--apply"]);
  expect(applied).toHaveLength(2);
  expect(exit).toHaveBeenLastCalledWith(0);
});

it("closes zero-debt active and historic repaid loans without funding", async () => {
  data.participants![0]!.loanDebt = 0;
  data.loans![1]!.status = "repaid";
  await run(["--apply"]);
  expect(applied).toHaveLength(2);
  expect(
    applied.every(
      (r) =>
        r.remaining === 0 && r.status === "repaid" && r.nextPaymentAt === null,
    ),
  ).toBe(true);
});

it("uses the original expired loan deadline, without charging cash", async () => {
  data.challenges![0]!.endsAt = new Date(now - 30_000);
  await run(["--apply"]);
  expect(applied[0]!.installment).toBe(100);
  expect(applied[0]!.nextPaymentAt).toEqual(new Date(now - 30_000));
  expect(data.participants![0]!.cash).toBe(123);
});

it.each([
  "missing end",
  "mixed active",
  "too much debt",
  "negative debt",
  "nonfinite repay",
  "missing participant",
])("aborts loans AND completion markers for %s", async (kind: string) => {
  data.challengeNews = [news("old")];
  data.challenges!.push(ended("old"));
  if (kind === "missing end") data.challenges![0]!.endsAt = null;
  if (kind === "mixed active")
    data.loans!.push({ ...legacy("new"), installment: 10 });
  if (kind === "too much debt") data.participants![0]!.loanDebt = 201;
  if (kind === "negative debt") data.participants![0]!.loanDebt = -1;
  if (kind === "nonfinite repay") data.loans![0]!.totalRepay = Infinity;
  if (kind === "missing participant") data.participants = [];
  const original = structuredClone(data);
  await run(["--apply", cutoffArg]);
  expect(exit).toHaveBeenLastCalledWith(1);
  expect(applied).toEqual([]);
  expect(data).toEqual(original);
});

it.each(["news", "challenge"])(
  "requires an audited cutoff before applying %s markers or loans",
  async (kind: string) => {
    if (kind === "news") data.challengeNews = [news("old")];
    else data.challenges!.push(ended("old"));
    const original = structuredClone(data);
    await run(["--apply"]);
    expect(exit).toHaveBeenLastCalledWith(1);
    expect(applied).toEqual([]);
    expect(data).toEqual(original);
  },
);

it("previews the same cutoff-qualified completion counts without writing", async () => {
  data.challengeNews = [
    news("old"),
    news("new", { publishedAt: cutoff }),
    news("embargo", { embargoUntil: new Date(now) }),
  ];
  data.challenges!.push(ended("old"), ended("checkpointed"));
  data.engineCheckpoints = [{ challengeId: "checkpointed", state: {} }];
  const original = structuredClone(data);
  await run([cutoffArg]);
  expect(exit).toHaveBeenLastCalledWith(0);
  expect(report()).toMatchObject({
    publishedNewsCandidates: 1,
    endedChallengeCandidates: 2,
    checkpointedChallengesSkipped: 1,
    newsCompletions: 1,
    challengeCompletions: 1,
  });
  expect(data).toEqual(original);
  expect(applied).toEqual([]);
});

it("marks only pre-cutoff public news, using max(publishedAt, embargoUntil)", async () => {
  data.challengeNews = [
    news("old"),
    news("no-embargo", { embargoUntil: null }),
    news("embargo-boundary", { embargoUntil: cutoff }),
    news("earlier-embargo", { embargoUntil: new Date(now - 100_000) }),
    news("unpublished", { publishedAt: null }),
    news("publish-boundary", { publishedAt: cutoff }),
    news("new", { publishedAt: new Date(now) }),
    news("still-private", { embargoUntil: new Date(cutoff.getTime() + 1) }),
    news("already-applied", { effectsAppliedAt: new Date(now - 80_000) }),
  ];
  const original = structuredClone(data);
  await run(["--apply", cutoffArg]);
  expect(exit).toHaveBeenLastCalledWith(0);
  const marks = applied.filter((r) => r.table === "challengeNews");
  expect(marks.map((r) => r.id)).toEqual([
    "old",
    "no-embargo",
    "embargo-boundary",
    "earlier-embargo",
  ]);
  expect(marks.map((r) => r.effectsAppliedAt)).toEqual([
    new Date(now - 70_000),
    new Date(now - 90_000),
    cutoff,
    new Date(now - 90_000),
  ]);
  expect(data.challengeNews!.slice(4)).toEqual(
    original.challengeNews!.slice(4),
  );
  expect(data.participants).toEqual(original.participants);
  expect(data.fairValues).toEqual(original.fairValues);
});

it("preserves old final results, skipping checkpointed, recent and already finalized challenges", async () => {
  data.challenges!.push(
    ended("old"),
    ended("checkpointed"),
    ended("boundary", { createdAt: cutoff }),
    ended("new", { createdAt: new Date(now) }),
    ended("finalized", { finalizedAt: new Date(now - 80_000) }),
    ended("paused", { status: "paused" }),
    ended("scheduled", { status: "scheduled" }),
  );
  data.engineCheckpoints = [{ challengeId: "checkpointed", state: {} }];
  const original = structuredClone(data);
  await run(["--apply", cutoffArg]);
  expect(exit).toHaveBeenLastCalledWith(0);
  expect(applied.filter((r) => r.table === "challenges")).toEqual([
    { table: "challenges", id: "old", finalizedAt: cutoff },
  ]);
  expect(data.challenges![1]).toEqual({
    ...original.challenges![1],
    finalizedAt: cutoff,
  });
  expect(data.challenges!.slice(2)).toEqual(original.challenges!.slice(2));
  expect(data.scoreSnapshots).toEqual(original.scoreSnapshots);
  expect(data.engineCheckpoints).toEqual(original.engineCheckpoints);
});

it("is idempotent for loans, news markers and ended-challenge markers", async () => {
  data.challengeNews = [news("old")];
  data.challenges!.push(ended("old"));
  await run(["--apply", cutoffArg]);
  expect(exit).toHaveBeenLastCalledWith(0);
  const original = structuredClone(data);
  expect(applied).toHaveLength(4);
  vi.resetModules();
  exit.mockClear();
  await run(["--apply", cutoffArg]);
  expect(exit).toHaveBeenLastCalledWith(0);
  expect(applied).toHaveLength(4);
  expect(data).toEqual(original);
});

it.each([1, 2, 3])(
  "rolls back all tables on write failure after %i updates without printing DB errors",
  async (count: number) => {
    data.challengeNews = [news("old")];
    data.challenges!.push(ended("old"));
    failAt = count;
    const original = structuredClone(data);
    await run(["--apply", cutoffArg]);
    expect(exit).toHaveBeenLastCalledWith(1);
    expect(data).toEqual(original);
    expect(applied).toEqual([]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "secret DB",
    );
  },
);

it("skips modern pending and already funded loans", async () => {
  data.loans = [
    { ...legacy("modern"), installment: 10 },
    { ...legacy("funded"), fundedAt: new Date(now) },
  ];
  await run(["--apply"]);
  expect(exit).toHaveBeenLastCalledWith(0);
  expect(applied).toEqual([]);
});

it.each([[], ["--apply"], ["--apply", cutoffArg]])(
  "succeeds on a fresh database without legacy data: %j",
  async (...args: string[]) => {
    for (const table of Object.keys(data)) data[table] = [];
    const original = structuredClone(data);
    await run(args);
    expect(exit).toHaveBeenLastCalledWith(0);
    expect(data).toEqual(original);
    expect(applied).toEqual([]);
  },
);

it("allows a newly seeded draft database to apply without a cutoff", async () => {
  data.loans = [];
  data.challenges![0]!.status = "draft";
  data.participants![0]!.loanDebt = 0;
  await run(["--apply"]);
  expect(exit).toHaveBeenLastCalledWith(0);
  expect(applied).toEqual([]);
});

it("does not require a cutoff for already checkpointed ended challenges", async () => {
  data.loans = [];
  data.challenges!.push(ended("checkpointed"));
  data.engineCheckpoints = [{ challengeId: "checkpointed", state: {} }];
  const original = structuredClone(data);
  await run(["--apply"]);
  expect(exit).toHaveBeenLastCalledWith(0);
  expect(report()).toMatchObject({
    endedChallengeCandidates: 1,
    checkpointedChallengesSkipped: 1,
    challengeCompletions: 0,
  });
  expect(data).toEqual(original);
});

it.each([
  ["--force"],
  ["--aply"],
  ["--apply", "--apply"],
  [cutoffArg, cutoffArg],
  ["--legacy-cutoff="],
  ["--legacy-cutoff=not-a-date"],
  ["--legacy-cutoff=2026-02-30T12:00:00Z"],
  ["--legacy-cutoff=2026-09-22"],
  ["--legacy-cutoff=2026-09-22T12:00:00"],
  [`--legacy-cutoff=${new Date(now + 1).toISOString()}`],
])(
  "rejects invalid arguments before connecting: %j",
  async (...args: string[]) => {
    await run(args);
    expect(exit).toHaveBeenLastCalledWith(1);
    expect(transaction).not.toHaveBeenCalled();
  },
);

it("accepts UTC cutoff timestamps without fractional seconds", async () => {
  await run([cutoffArg.replace(".000Z", "Z")]);
  expect(exit).toHaveBeenLastCalledWith(0);
});
