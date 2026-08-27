import { http, poll, sleep, directionalConfig } from "../lib.mjs";

async function place(token, challengeId, extra) {
  return http.post("/api/orders", { challengeId, ...extra }, { token });
}

async function waitOrder(token, challengeId, orderId, pred, label) {
  return poll(
    async () => {
      const rows = await http.get("/api/orders", {
        token,
        query: { challengeId },
      });
      const o = rows.find((r) => r.id === orderId);
      return o && pred(o) ? o : null;
    },
    { timeout: 20_000, interval: 400, label },
  );
}

export async function suiteTrading(t, ctx) {
  t.suite("Trading / matching / portfolio");

  const cid = ctx.dir.id;
  const sym = "E2EA";

  await t.test("limit order without price is 400", async () => {
    await t.throws(
      () => place(ctx.t1.token, cid, { symbol: sym, side: "buy", type: "limit", quantity: 1 }),
      { status: 400, error: "limit_requires_price" },
    );
  });

  await t.test("unknown symbol is 400", async () => {
    await t.throws(
      () =>
        place(ctx.t1.token, cid, {
          symbol: "NOSUCH",
          side: "buy",
          type: "limit",
          quantity: 1,
          price: 10,
        }),
      { status: 400, error: "unknown_symbol" },
    );
  });

  await t.test("quantity above maxOrderQuantity is 400", async () => {
    await t.throws(
      () =>
        place(ctx.t1.token, cid, {
          symbol: sym,
          side: "buy",
          type: "limit",
          quantity: 99,
          price: 10,
        }),
      { status: 400, error: "quantity_exceeds_limit" },
    );
  });

  await t.test("zero / negative quantity is 400 validation_error", async () => {
    const r = await http.request("POST", "/api/orders", {
      token: ctx.t1.token,
      body: { challengeId: cid, symbol: sym, side: "buy", type: "limit", quantity: 0, price: 10 },
    });
    t.eq(r.status, 400);
  });

  await t.test("order on ended challenge is 409", async () => {
    const ended = ctx.existingEnded;
    if (!ended) {
      t.skip("order on ended", "no ended challenge");
      return;
    }
    await t.throws(
      () =>
        place(ctx.t1.token, ended.id, {
          symbol: ended.config.symbols[0].symbol,
          side: "buy",
          type: "limit",
          quantity: 1,
          price: 1,
        }),
      { status: 409, error: "challenge_not_live" },
    );
  });

  await t.test("resting limit sell appears on the book", async () => {
    const ack = await place(ctx.t1.token, cid, {
      symbol: sym,
      side: "sell",
      type: "limit",
      quantity: 5,
      price: 50,
    });
    t.eq(ack.status, "accepted");
    t.ok(ack.orderId);
    ctx.sellOrderId = ack.orderId;

    const open = await waitOrder(
      ctx.t1.token,
      cid,
      ack.orderId,
      (o) => o.status === "open" || o.status === "filled" || o.status === "partially_filled",
      "sell order visible",
    );
    t.ok(["open", "partially_filled", "filled"].includes(open.status));

    const book = await poll(
      async () => {
        const b = await http.get(`/api/market/${cid}/${sym}/orderbook`);
        const hit = (b.asks ?? []).some((l) => l.price === 50 && l.quantity >= 1);
        return hit ? b : null;
      },
      { timeout: 20_000, label: "ask 50 on book" },
    );
    t.ok(book.asks.some((l) => l.price === 50));
  });

  await t.test("crossing buy fills both sides (price-time priority)", async () => {
    const ack = await place(ctx.t2.token, cid, {
      symbol: sym,
      side: "buy",
      type: "limit",
      quantity: 5,
      price: 50,
    });
    ctx.buyOrderId = ack.orderId;

    const buy = await waitOrder(
      ctx.t2.token,
      cid,
      ack.orderId,
      (o) => o.status === "filled",
      "buy fill",
    );
    t.eq(buy.status, "filled");
    t.eq(buy.remainingQuantity, 0);

    const sell = await waitOrder(
      ctx.t1.token,
      cid,
      ctx.sellOrderId,
      (o) => o.status === "filled",
      "sell fill",
    );
    t.eq(sell.status, "filled");
  });

  await t.test("portfolio cash + inventory match the fill at 50", async () => {
    const seller = await poll(
      async () => {
        const p = await http.get(`/api/portfolio/${cid}`, { token: ctx.t1.token });
        const pos = p.positions.find((x) => x.symbol === sym && x.quantity === -5);
        return pos ? p : null;
      },
      { timeout: 15_000, label: "seller position -5" },
    );
    t.approx(seller.cash, 250, 1e-4);
    t.eq(seller.positions.find((p) => p.symbol === sym).quantity, -5);

    const buyer = await http.get(`/api/portfolio/${cid}`, { token: ctx.t2.token });
    t.approx(buyer.cash, -250, 1e-4);
    t.eq(buyer.positions.find((p) => p.symbol === sym)?.quantity, 5);

    // Trades move the mark (PRICE_TRADE_IMPACT). Equity must equal cash + qty*live.
    const live = await http.get(`/api/market/${cid}/${sym}/price`);
    const mark = live.price ?? 100;
    t.approx(seller.pnl, seller.cash + -5 * mark, 1e-2);
    t.approx(buyer.pnl, buyer.cash + 5 * mark, 1e-2);
  });

  await t.test("PnL is profit versus starting cash", async () => {
    const p = await http.get(`/api/portfolio/${cid}`, { token: ctx.t2.token });
    const starting = ctx.dir.config.startingCash ?? 0;
    t.approx(p.pnl, p.cash + p.marketValue - starting, 1e-4);
  });

  await t.test("first order auto-enrolls a new trader", async () => {
    const fresh = ctx.fresh;
    if (!fresh) {
      t.skip("auto-enroll", "register did not create a user");
      return;
    }
    const ack = await place(fresh.token, cid, {
      symbol: "E2EB",
      side: "sell",
      type: "limit",
      quantity: 1,
      price: 80,
    });
    t.eq(ack.status, "accepted");
    ctx.freshSellId = ack.orderId;
    const pf = await poll(
      async () => {
        const p = await http.get(`/api/portfolio/${cid}`, { token: fresh.token });
        return p.challengeId === cid ? p : null;
      },
      { label: "auto-enrolled portfolio" },
    );
    t.eq(pf.challengeId, cid);
  });

  await t.test("cancel resting order (owner)", async () => {
    const ack = await place(ctx.t1.token, cid, {
      symbol: "E2EB",
      side: "buy",
      type: "limit",
      quantity: 2,
      price: 1,
    });
    await waitOrder(ctx.t1.token, cid, ack.orderId, (o) => o.status === "open", "resting buy");
    const res = await http.del(`/api/orders/${ack.orderId}`, { token: ctx.t1.token });
    t.eq(res.status, "cancelled");
    const row = await waitOrder(
      ctx.t1.token,
      cid,
      ack.orderId,
      (o) => o.status === "cancelled",
      "cancelled status",
    );
    t.eq(row.status, "cancelled");
  });

  await t.test("cancel already-cancelled is 409", async () => {
    const rows = await http.get("/api/orders", {
      token: ctx.t1.token,
      query: { challengeId: cid },
    });
    const cancelled = rows.find((o) => o.status === "cancelled");
    t.ok(cancelled, "need a cancelled order");
    await t.throws(() => http.del(`/api/orders/${cancelled.id}`, { token: ctx.t1.token }), {
      status: 409,
      error: "order_not_cancellable",
    });
  });

  await t.test("cannot cancel another trader's order", async () => {
    if (!ctx.freshSellId) {
      t.skip("foreign cancel", "no foreign resting order");
      return;
    }
    await t.throws(
      () => http.del(`/api/orders/${ctx.freshSellId}`, { token: ctx.t1.token }),
      { status: 403, error: "forbidden" },
    );
  });

  await t.test("cancel unknown order is 404", async () => {
    await t.throws(
      () => http.del("/api/orders/00000000-0000-4000-8000-000000000000", { token: ctx.t1.token }),
      { status: 404 },
    );
  });

  await t.test("open=true filter excludes filled/cancelled", async () => {
    const open = await http.get("/api/orders", {
      token: ctx.t1.token,
      query: { challengeId: cid, open: "true" },
    });
    t.ok(open.every((o) => o.status === "open" || o.status === "partially_filled"));
  });

  await t.test("GET /api/orders without challengeId is 400", async () => {
    const r = await http.request("GET", "/api/orders", { token: ctx.t1.token });
    t.eq(r.status, 400);
    t.eq(r.body.error, "challengeId_required");
  });

  await t.test("partial fill leaves remainder on the book", async () => {
    const sell = await place(ctx.t1.token, cid, {
      symbol: "E2EB",
      side: "sell",
      type: "limit",
      quantity: 6,
      price: 40,
    });
    await waitOrder(ctx.t1.token, cid, sell.orderId, (o) => o.status === "open", "partial sell rest");
    const buy = await place(ctx.t2.token, cid, {
      symbol: "E2EB",
      side: "buy",
      type: "limit",
      quantity: 2,
      price: 40,
    });
    await waitOrder(ctx.t2.token, cid, buy.orderId, (o) => o.status === "filled", "partial buy fill");
    const left = await waitOrder(
      ctx.t1.token,
      cid,
      sell.orderId,
      (o) => o.status === "partially_filled" && o.remainingQuantity === 4,
      "partial remaining 4",
    );
    t.eq(left.remainingQuantity, 4);
    await http.del(`/api/orders/${sell.orderId}`, { token: ctx.t1.token });
  });

  await t.test("market order consumes resting liquidity", async () => {
    const sell = await place(ctx.t1.token, cid, {
      symbol: "E2EB",
      side: "sell",
      type: "limit",
      quantity: 3,
      price: 41,
    });
    await waitOrder(ctx.t1.token, cid, sell.orderId, (o) => o.status === "open", "mkt rest");
    const mkt = await place(ctx.t2.token, cid, {
      symbol: "E2EB",
      side: "buy",
      type: "market",
      quantity: 3,
    });
    const filled = await waitOrder(
      ctx.t2.token,
      cid,
      mkt.orderId,
      (o) => o.status === "filled" || o.status === "cancelled",
      "market result",
    );
    t.eq(filled.status, "filled");
  });

  await t.test("leaderboard ranks traders and excludes admin", async () => {
    const lb = await poll(
      async () => {
        const rows = await http.get(`/api/leaderboard/${cid}`);
        return rows.length >= 2 ? rows : null;
      },
      { timeout: 25_000, label: "leaderboard populated" },
    );
    const ranks = lb.map((e) => e.rank);
    t.eq(ranks[0], 1);
    t.ok(lb.every((e) => e.userId !== ctx.admin.user.id), "admin should not be ranked");
    for (let i = 1; i < lb.length; i++) {
      t.ok(lb[i - 1].score >= lb[i].score, "scores should be non-increasing");
    }
    const self = lb.find((e) => e.userId === ctx.t2.user.id);
    t.ok(self, "buyer should appear");
  });

  await t.test("volume limit returns 429 volume_limited", async () => {
    // Tiny dedicated challenge so we do not trip limits on the main e2e book.
    const created = await http.post(
      "/api/challenges",
      {
        name: `E2E Vol ${Date.now().toString(36)}`,
        type: "directional",
        config: directionalConfig({
          maxVolumePerMinute: 3,
          maxOrdersPerSecond: 20,
          symbols: [
            { symbol: "VLX", name: "Vol", initialPrice: 10, volatility: 0, tickSize: 0.01 },
          ],
        }),
      },
      { token: ctx.admin.token },
    );
    ctx.createdIds.push(created.id);
    await http.post(`/api/challenges/${created.id}/status`, { status: "live" }, { token: ctx.admin.token });
    const first = await http.request("POST", "/api/orders", {
      token: ctx.t1.token,
      body: {
        challengeId: created.id,
        symbol: "VLX",
        side: "buy",
        type: "limit",
        quantity: 2,
        price: 1,
      },
    });
    t.eq(first.status, 202);
    const second = await http.request("POST", "/api/orders", {
      token: ctx.t1.token,
      body: {
        challengeId: created.id,
        symbol: "VLX",
        side: "buy",
        type: "limit",
        quantity: 2,
        price: 1,
      },
    });
    t.eq(second.status, 429);
    t.eq(second.body.error, "volume_limited");
    await http.post(
      `/api/challenges/${created.id}/status`,
      { status: "ended" },
      { token: ctx.admin.token },
    );
  });

  await t.test("orders-per-second limit returns 429 rate_limited", async () => {
    const created = await http.post(
      "/api/challenges",
      {
        name: `E2E Rate ${Date.now().toString(36)}`,
        type: "directional",
        config: directionalConfig({
          maxOrdersPerSecond: 2,
          maxVolumePerMinute: 5000,
          symbols: [
            { symbol: "RLX", name: "Rate", initialPrice: 10, volatility: 0, tickSize: 0.01 },
          ],
        }),
      },
      { token: ctx.admin.token },
    );
    ctx.createdIds.push(created.id);
    await http.post(`/api/challenges/${created.id}/status`, { status: "live" }, { token: ctx.admin.token });
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const r = await http.request("POST", "/api/orders", {
        token: ctx.t1.token,
        body: {
          challengeId: created.id,
          symbol: "RLX",
          side: "buy",
          type: "limit",
          quantity: 1,
          price: 1,
        },
      });
      statuses.push(r.status);
    }
    t.ok(statuses.includes(429), `expected a 429, got ${statuses.join(",")}`);
    t.ok(statuses.includes(202), "at least one order should be accepted");
    await http.post(
      `/api/challenges/${created.id}/status`,
      { status: "ended" },
      { token: ctx.admin.token },
    );
  });

  await t.test("pause rejects new orders; resume allows them", async () => {
    await http.post(
      `/api/challenges/${cid}/status`,
      { status: "paused" },
      { token: ctx.admin.token },
    );
    await t.throws(
      () =>
        place(ctx.t1.token, cid, {
          symbol: sym,
          side: "buy",
          type: "limit",
          quantity: 1,
          price: 1,
        }),
      { status: 409, error: "challenge_not_live" },
    );
    await http.post(
      `/api/challenges/${cid}/status`,
      { status: "live" },
      { token: ctx.admin.token },
    );
    await sleep(800);
    const ack = await place(ctx.t1.token, cid, {
      symbol: sym,
      side: "buy",
      type: "limit",
      quantity: 1,
      price: 1,
    });
    t.eq(ack.status, "accepted");
    await http.del(`/api/orders/${ack.orderId}`, { token: ctx.t1.token }).catch(() => {});
  });
}
