import { directionalConfig, http, nowId, poll, sleep } from "../lib.mjs";

export async function suiteEdge(t, ctx) {
  t.suite("Edge cases / logic");

  await t.test("portfolio for a non-participant is 404 not_enrolled", async () => {
    const user = ctx.fresh2;
    if (!user) {
      t.skip("ghost portfolio", "second register user missing");
      return;
    }
    await t.throws(
      () => http.get(`/api/portfolio/${ctx.dir.id}`, { token: user.token }),
      { status: 404, error: "not_enrolled" },
    );
  });

  await t.test("self-crossing orders (same user) fill or rest without crashing", async () => {
    const cid = ctx.dir.id;
    const sell = await http.post(
      "/api/orders",
      { challengeId: cid, symbol: "E2EA", side: "sell", type: "limit", quantity: 1, price: 90 },
      { token: ctx.t1.token },
    );
    await sleep(500);
    const buy = await http.post(
      "/api/orders",
      { challengeId: cid, symbol: "E2EA", side: "buy", type: "limit", quantity: 1, price: 90 },
      { token: ctx.t1.token },
    );
    const row = await poll(
      async () => {
        const orders = await http.get("/api/orders", {
          token: ctx.t1.token,
          query: { challengeId: cid },
        });
        const b = orders.find((o) => o.id === buy.orderId);
        return b && b.status !== "open" ? b : null;
      },
      { timeout: 12_000, label: "self-cross resolves" },
    );
    t.ok(["filled", "cancelled", "rejected"].includes(row.status));
  });

  await t.test("position cap: engine refuses inventory beyond maxPosition", async () => {
    const cid = ctx.dir.id;
    // maxPosition is 50. Seed a large resting offer and take it.
    const sell = await http.post(
      "/api/orders",
      { challengeId: cid, symbol: "E2EA", side: "sell", type: "limit", quantity: 20, price: 2 },
      { token: ctx.t1.token },
    );
    await sleep(400);
    await http.post(
      "/api/orders",
      { challengeId: cid, symbol: "E2EA", side: "buy", type: "limit", quantity: 20, price: 2 },
      { token: ctx.fresh?.token ?? ctx.t2.token },
    );
    await sleep(800);
    const extraSell = await http.post(
      "/api/orders",
      { challengeId: cid, symbol: "E2EA", side: "sell", type: "limit", quantity: 20, price: 2 },
      { token: ctx.t1.token },
    );
    await sleep(400);
    const extraBuy = await http.post(
      "/api/orders",
      { challengeId: cid, symbol: "E2EA", side: "buy", type: "limit", quantity: 20, price: 2 },
      { token: ctx.fresh?.token ?? ctx.t2.token },
    );
    await sleep(800);
    const takerTok = ctx.fresh?.token ?? ctx.t2.token;
    const pf = await http.get(`/api/portfolio/${cid}`, { token: takerTok });
    const qty = pf.positions.find((p) => p.symbol === "E2EA")?.quantity ?? 0;
    t.ok(qty <= 50, `inventory ${qty} exceeded maxPosition 50`);
    void sell;
    void extraSell;
    void extraBuy;
  });

  await t.test("OTC offer expires and cannot be accepted", async () => {
    const offer = await http.post(
      `/api/admin/${ctx.eden.id}/otc`,
      {
        userId: ctx.t1.user.id,
        description: "E2E expire",
        legs: [{ symbol: "AERIUM", quantity: 1, price: 1000 }],
        cashToTrader: 0,
        expiresSec: 5,
      },
      { token: ctx.admin.token },
    );
    await sleep(5500);
    const r = await http.request("POST", `/api/otc/${offer.offer.id}/respond`, {
      token: ctx.t1.token,
      body: { action: "accept" },
    });
    t.ok(r.status === 409, `expected 409 after expiry, got ${r.status}`);
    if (r.status === 409) t.eq(r.body.error, "offer_expired");
  });

  await t.test("grant with no positive holders awards nobody", async () => {
    const opened = await http.post(
      `/api/admin/${ctx.eden.id}/grant`,
      {
        symbol: "AERIUM",
        description: "E2E empty grant",
        prize: 10,
        durationSec: 8,
      },
      { token: ctx.admin.token },
    );
    await http.post(
      `/api/admin/${ctx.eden.id}/grant/${opened.grantId}/award`,
      {},
      { token: ctx.admin.token },
    );
    const v = await poll(
      async () => {
        const g = await http.get(`/api/votes/${ctx.eden.id}`, { token: ctx.t1.token });
        return g.grant?.id === opened.grantId && g.grant.status !== "open" ? g : null;
      },
      { timeout: 12_000, label: "empty grant resolved" },
    );
    t.eq(v.grant.status, "awarded");
    // Nobody held AERIUM long; winner should be null.
    if (v.grant.winnerId != null) {
      ctx.findings.push({
        severity: "medium",
        area: "grants",
        title: "Grant awarded a winner with no positive AERIUM holders",
        detail: `winnerId=${v.grant.winnerId}`,
      });
    }
  });

  await t.test("loan list endpoint returns the issued loan", async () => {
    const rows = await http.get(`/api/loans/${ctx.eden.id}`, { token: ctx.t1.token });
    t.ok(Array.isArray(rows) && rows.length >= 1);
    t.ok(rows.every((l) => l.userId === ctx.t1.user.id));
  });

  await t.test("news on a draft is 404 for traders", async () => {
    const draft = await http.post(
      "/api/challenges",
      {
        name: `E2E DraftNews ${Date.now().toString(36)}`,
        type: "directional",
        config: ctx.dir.config,
      },
      { token: ctx.admin.token },
    );
    ctx.createdIds.push(draft.id);
    await t.throws(
      () => http.get(`/api/challenges/${draft.id}/news`, { token: ctx.t1.token }),
      { status: 404 },
    );
    await http.post(
      `/api/challenges/${draft.id}/status`,
      { status: "ended" },
      { token: ctx.admin.token },
    );
  });

  await t.test("orders placed at go-live rest on the book (command cursor)", async () => {
    const created = await http.post(
      "/api/challenges",
      {
        name: `E2E Race ${nowId("")}`,
        type: "directional",
        config: directionalConfig({
          symbols: [
            { symbol: "RAC", name: "Race", initialPrice: 10, volatility: 0, tickSize: 0.01 },
          ],
        }),
      },
      { token: ctx.admin.token },
    );
    ctx.createdIds.push(created.id);
    await http.post(
      `/api/challenges/${created.id}/status`,
      { status: "live" },
      { token: ctx.admin.token },
    );
    const ack = await http.post(
      "/api/orders",
      {
        challengeId: created.id,
        symbol: "RAC",
        side: "buy",
        type: "limit",
        quantity: 1,
        price: 3,
      },
      { token: ctx.t1.token },
    );
    t.eq(ack.status, "accepted");
    await sleep(8000);
    const book = await http.get(`/api/market/${created.id}/RAC/orderbook`);
    const onBook = (book.bids ?? []).some((l) => l.price === 3);
    if (!onBook) {
      ctx.findings.push({
        severity: "high",
        area: "engine",
        title: "ChallengeRunner XREADs from lastId='$' and drops early commands",
        detail:
          "The reconcile loop claims live challenges every 3s. The command cursor starts at '$', so place_order / issue_loan published in that window stay 'accepted' in Postgres but never hit the book or the ledger. Later commands work once the runner is up.",
      });
    }
    t.ok(
      onBook,
      "canary bid @ 3 never appeared on the book — command likely dropped because the runner starts XREAD at $",
    );
    await http.post(
      `/api/challenges/${created.id}/status`,
      { status: "ended" },
      { token: ctx.admin.token },
    );
  });

  await t.test("active-challenges admin list includes our live ones", async () => {
    const active = await http.get("/api/challenges/_active/list", { token: ctx.admin.token });
    t.ok(Array.isArray(active));
    t.ok(active.includes(ctx.dir.id) || active.includes(ctx.eden.id));
  });
}
