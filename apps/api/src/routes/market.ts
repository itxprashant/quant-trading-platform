import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { challenges } from "@qtp/db";
import { getBookSnapshot, getMidPriceHistory, getPrice, getPriceHistory } from "@qtp/bus";
import type { ChartPriceSeries, PricePoint } from "@qtp/shared";

export async function marketRoutes(app: FastifyInstance): Promise<void> {
  // All symbols + current prices for a challenge.
  app.get("/:challengeId/symbols", async (req, reply) => {
    const { challengeId } = req.params as { challengeId: string };
    const challenge = await app.db.query.challenges.findFirst({
      where: eq(challenges.id, challengeId),
    });
    if (!challenge) return reply.code(404).send({ error: "not_found" });

    const out: Array<{
      symbol: string;
      name: string | null;
      price: number;
      initialPrice: number;
    }> = [];
    for (const s of challenge.config.symbols) {
      const price = await getPrice(app.redis, challengeId, s.symbol);
      out.push({
        symbol: s.symbol,
        name: s.name ?? null,
        price: price ?? s.initialPrice,
        initialPrice: s.initialPrice,
      });
    }
    return out;
  });

  app.get("/:challengeId/:symbol/price", async (req) => {
    const { challengeId, symbol } = req.params as {
      challengeId: string;
      symbol: string;
    };
    const price = await getPrice(app.redis, challengeId, symbol);
    return { symbol, price };
  });

  app.get("/:challengeId/:symbol/history", async (req) => {
    const { challengeId, symbol } = req.params as {
      challengeId: string;
      symbol: string;
    };
    const { limit, series } = req.query as {
      limit?: string;
      series?: ChartPriceSeries;
    };
    const useMid = series !== "last";
    const cap = limit ? Number(limit) : 200;
    let history: PricePoint[] = useMid
      ? await getMidPriceHistory(app.redis, challengeId, symbol, cap)
      : await getPriceHistory(app.redis, challengeId, symbol, cap);
    if (useMid && history.length === 0) {
      history = await getPriceHistory(app.redis, challengeId, symbol, cap);
    }
    return history;
  });

  app.get("/:challengeId/:symbol/orderbook", async (req) => {
    const { challengeId, symbol } = req.params as {
      challengeId: string;
      symbol: string;
    };
    const snap = await getBookSnapshot(app.redis, challengeId, symbol);
    return snap ?? { symbol, bids: [], asks: [], sequence: 0 };
  });
}
