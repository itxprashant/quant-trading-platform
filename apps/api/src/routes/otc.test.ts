import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "../../../../packages/core/node_modules/vitest/dist/index.js";
import Fastify from "fastify";
import type { Redis } from "@qtp/bus";

const mocks = {
  now: 1_800_000_000_000,
  frozen: false,
  getFairValues: vi.fn(async () => ({ AERIUM: 1000, NEURO: 500 })),
  getPrice: vi.fn(async () => null),
  getTraderMetrics: vi.fn(async () => null),
  publishBroadcast: vi.fn(async () => {}),
  publishCommand: vi.fn(async () => {}),
  bargainRejectProbability: vi.fn(() => 0),
  computeScore: vi.fn(() => 0),
  profitPnl: vi.fn(() => 0),
  theoreticalOption: vi.fn(() => 0),
  scheduleEdenResolver: vi.fn(),
};
vi.doMock("../../../../packages/bus/dist/index.js", () => mocks);
vi.doMock("../../../../packages/core/dist/index.js", () => mocks);
vi.doMock("../eden-ops.js", () => mocks);
vi.doMock("../ratelimit.js", () => ({ rateLimit: () => async () => {} }));
vi.doMock("../../../../packages/shared/dist/index.js", async (original) => {
  const shared = await original<typeof import("@qtp/shared")>();
  const { z } = await import("zod");
  return {
    ...shared,
    zOtcRespondInput: shared.zOtcRespondInput.extend({
      choiceSymbol: z.string().optional(),
      choiceQuantity: z.number().int().positive().max(50).optional(),
    }),
  };
});
vi.doMock("../../../../packages/db/dist/index.js", () =>
  Object.fromEntries(
    [
      "challenges",
      "orders",
      "otcOffers",
      "participants",
      "positions",
      "loans",
      "bondHoldings",
      "optionContracts",
    ].map((name) => [
      name,
      new Proxy(
        { name },
        { get: (table, key) => (key === "name" ? table.name : String(key)) },
      ),
    ]),
  ),
);
vi.doMock("../../node_modules/drizzle-orm/index.js", () => ({
  and:
    (...filters: any[]) =>
    (row: any) =>
      filters.every((filter) => filter(row)),
  eq: (key: string, expected: any) => (row: any) => row[key] === expected,
  gt: (key: string, expected: any) => (row: any) =>
    row[key] > (expected?.clock ? mocks.now : expected),
  inArray: (key: string, values: unknown[]) => (row: any) =>
    values.includes(row[key]),
  desc: (key: string) => key,
  sql: (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("exists")) return () => !mocks.frozen;
    return {
      clock: true,
      delay: text.includes("interval '5 seconds'") ? 5000 : 0,
    };
  },
}));

const { otcRoutes } = await import("./otc.js");
const { loanRoutes } = await import("./loans.js");
const { portfolioRoutes } = await import("./portfolio.js");

const challengeId = "00000000-0000-4000-a000-000000000001";
const userId = "00000000-0000-4000-a000-000000000002";
const offerId = "00000000-0000-4000-a000-000000000003";
const apps: ReturnType<typeof Fastify>[] = [];

async function fixture() {
  mocks.frozen = false;
  vi.spyOn(Date, "now").mockImplementation(() => mocks.now);
  const offer: any = {
    id: offerId,
    challengeId,
    userId,
    description: "Choose one bailout asset",
    legs: [{ symbol: "AERIUM", quantity: -50, price: 900 }],
    choices: [
      { symbol: "AERIUM", quantity: -50, price: 900 },
      { symbol: "NEURO", quantity: -20, price: 450 },
    ],
    cashToTrader: 0,
    status: "pending",
    expiresAt: new Date(mocks.now + 15000),
    createdAt: new Date(mocks.now),
    settleAt: null,
  };
  const positions: any[] = [];
  const orders: any[] = [];
  const loanRows: any[] = [];
  const queriedSymbols: string[] = [];
  const db: any = {
    query: {
      otcOffers: { findFirst: async () => structuredClone(offer) },
      challenges: {
        findFirst: async () => ({
          id: challengeId,
          status: "live",
          type: "new_eden",
          frozen: mocks.frozen,
          endsAt: new Date(mocks.now + 60000),
          config: { eden: { rules: { positionCap: 100 } } },
        }),
      },
      participants: {
        findFirst: async () => ({
          userId,
          challengeId,
          cash: 10000,
          startingCash: 10000,
          loanDebt: 0,
        }),
      },
    },
    select: () => ({
      from: (table: any) => {
        let filter = (_row: any) => true;
        const query = {
          where: (next: any) => {
            filter = next;
            return query;
          },
          orderBy: () => query,
          limit: () => query,
          then: (resolve: any, reject: any) => {
            const rows =
              table.name === "otcOffers"
                ? [offer]
                : table.name === "orders"
                  ? orders
                  : table.name === "loans"
                    ? loanRows
                    : table.name === "positions"
                      ? positions
                      : [];
            if (table.name === "positions") {
              for (const symbol of ["AERIUM", "NEURO"])
                if (filter({ symbol, userId, challengeId }))
                  queriedSymbols.push(symbol);
            }
            const filtered = rows.filter(filter);
            const result =
              table.name === "orders"
                ? [
                    {
                      quantity: filtered.reduce(
                        (sum, row) => sum + row.remainingQuantity,
                        0,
                      ),
                    },
                  ]
                : structuredClone(filtered);
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return query;
      },
    }),
    insert: () => ({
      values: (values: any) => ({
        returning: async () => {
          const row = { ...values, createdAt: new Date(mocks.now) };
          loanRows.push(row);
          return [row];
        },
      }),
    }),
    update: () => ({
      set: (values: any) => ({
        where: (filter: any) => {
          const apply = () => {
            if (!filter(offer)) return [];
            const next = { ...values };
            if (next.settleAt?.clock)
              next.settleAt = new Date(mocks.now + next.settleAt.delay);
            Object.assign(offer, next);
            return [structuredClone(offer)];
          };
          return {
            returning: async () => apply(),
            then: (resolve: any) => Promise.resolve(apply()).then(resolve),
          };
        },
      }),
    }),
  };
  const app = Fastify();
  apps.push(app);
  app.decorate("db", db);
  app.decorate("redis", { get: async () => null } as unknown as Redis);
  app.decorate("authenticate", async (req: any) => {
    req.user = { sub: userId };
  });
  app.decorate("requireAdmin", async () => {});
  await app.register(otcRoutes, { prefix: "/otc" });
  await app.register(loanRoutes, { prefix: "/loans" });
  await app.register(portfolioRoutes, { prefix: "/portfolio" });
  const respond = (payload: object) =>
    app.inject({ method: "POST", url: `/otc/${offerId}/respond`, payload });
  return { app, offer, positions, orders, loanRows, queriedSymbols, respond };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("bailout choice responses", () => {
  it("exposes stored loan schedules on request, list and portfolio", async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: "POST",
      url: "/loans/request",
      payload: { challengeId, principal: 100 },
    });
    expect(response.statusCode).toBe(202);
    const nextPaymentAt = new Date(mocks.now + 60000).toISOString();
    expect(response.json().loan).toMatchObject({
      installment: 200,
      nextPaymentAt,
      fundedAt: null,
    });
    f.loanRows[0].fundedAt = new Date(mocks.now);
    const list = await f.app.inject({ url: `/loans/${challengeId}` });
    expect(list.json()[0]).toMatchObject({
      installment: 200,
      nextPaymentAt,
      fundedAt: new Date(mocks.now).toISOString(),
    });
    const portfolio = await f.app.inject({ url: `/portfolio/${challengeId}` });
    expect(portfolio.statusCode).toBe(200);
    expect(portfolio.json().loans[0]).toMatchObject({
      installment: 200,
      nextPaymentAt,
      fundedAt: new Date(mocks.now).toISOString(),
    });
  });
  it.each([
    {},
    { choiceSymbol: "NEURO" },
    { choiceQuantity: 1 },
    { choiceSymbol: "UNLISTED", choiceQuantity: 1 },
    { choiceSymbol: "NEURO", choiceQuantity: 21 },
    { choiceSymbol: "NEURO", choiceQuantity: 0 },
    { choiceSymbol: "NEURO", choiceQuantity: -1 },
    { choiceSymbol: "NEURO", choiceQuantity: 1.5 },
    { choiceSymbol: "AERIUM", choiceQuantity: 51 },
  ])(
    "rejects invalid/missing choice %j",
    async (choice: { choiceSymbol?: string; choiceQuantity?: number }) => {
      const f = await fixture();
      const response = await f.respond({ action: "accept", ...choice });
      expect(response.statusCode).toBe(400);
      expect(f.offer.status).toBe("pending");
      expect(mocks.publishCommand).not.toHaveBeenCalled();
    },
  );

  it("persists and queues only the selected leg at its immutable quote", async () => {
    const f = await fixture();
    const response = await f.respond({
      action: "accept",
      choiceSymbol: "NEURO",
      choiceQuantity: 3,
      legs: [{ symbol: "NEURO", quantity: -50, price: 9999 }],
    });
    expect(response.statusCode).toBe(200);
    const expected = [{ symbol: "NEURO", quantity: -3, price: 450 }];
    expect(f.offer.legs).toEqual(expected);
    expect(response.json().legs).toEqual(expected);
    expect(mocks.publishCommand).toHaveBeenCalledWith(
      expect.anything(),
      challengeId,
      expect.objectContaining({ legs: expected }),
    );
    expect(f.queriedSymbols).toEqual(["NEURO"]);
    expect(f.offer.choices).toHaveLength(2);
  });

  it("uses the selected position and working orders for cap checks", async () => {
    const f = await fixture();
    f.positions.push({ challengeId, userId, symbol: "NEURO", quantity: -80 });
    f.orders.push({
      challengeId,
      userId,
      symbol: "NEURO",
      side: "sell",
      remainingQuantity: 18,
      status: "open",
    });
    const response = await f.respond({
      action: "accept",
      choiceSymbol: "NEURO",
      choiceQuantity: 3,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("position_cap_exceeded");
    expect(f.offer.status).toBe("pending");
  });

  it("bargains selected economics and cannot cancel accepted legs during the delay", async () => {
    const f = await fixture();
    const response = await f.respond({
      action: "bargain",
      choiceSymbol: "NEURO",
      choiceQuantity: 3,
      counterCash: 300,
    });
    expect(response.statusCode).toBe(200);
    // 3 NEURO at FV 500, quote 450: fair side payment is 150; surplus 150 / 1500.
    expect(mocks.bargainRejectProbability).toHaveBeenCalledWith(0.1);
    expect(f.offer.legs).toEqual([
      { symbol: "NEURO", quantity: -3, price: 450 },
    ]);
    expect(f.offer.settleAt.getTime()).toBe(mocks.now + 5000);
    expect(mocks.scheduleEdenResolver).toHaveBeenCalledWith(
      5000,
      expect.any(Function),
    );
    mocks.frozen = true;
    expect((await f.respond({ action: "reject" })).statusCode).toBe(409);
    expect(f.offer.status).toBe("accepted");
    await mocks.scheduleEdenResolver.mock.calls[0]![1]();
    expect(mocks.publishCommand).toHaveBeenCalledWith(
      expect.anything(),
      challengeId,
      expect.objectContaining({ legs: f.offer.legs, cashToTrader: 300 }),
    );
  });

  it("blocks new accepts/bargains while frozen, but permits rejecting pending offers", async () => {
    const f = await fixture();
    mocks.frozen = true;
    for (const action of ["accept", "bargain"]) {
      const response = await f.respond({
        action,
        choiceSymbol: "NEURO",
        choiceQuantity: 1,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("market_frozen");
    }
    expect((await f.respond({ action: "reject" })).statusCode).toBe(200);
    expect(f.offer.status).toBe("rejected");
  });

  it("serializes choices and the binding settlement deadline", async () => {
    const f = await fixture();
    f.offer.status = "accepted";
    f.offer.settleAt = new Date(mocks.now + 5000);
    const response = await f.app.inject({ url: `/otc/${challengeId}` });
    expect(response.json()[0]).toMatchObject({
      choices: f.offer.choices,
      settleAt: f.offer.settleAt.toISOString(),
    });
  });

  it("keeps fixed offers working and does not let choice fields rewrite them", async () => {
    const f = await fixture();
    f.offer.choices = null;
    expect(
      (
        await f.respond({
          action: "accept",
          choiceSymbol: "NEURO",
          choiceQuantity: 1,
        })
      ).statusCode,
    ).toBe(400);
    expect((await f.respond({ action: "accept" })).statusCode).toBe(200);
    expect(f.offer.legs[0].symbol).toBe("AERIUM");
  });
});
