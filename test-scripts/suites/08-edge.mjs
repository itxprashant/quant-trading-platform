import { directionalConfig, http, nowId, poll, sleep, waitStatus } from "../lib.mjs";

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

  await t.test("self-cross cancels the older resting order instead of trading", async () => {
    const cid = ctx.dir.id;
    const before = await http.get(`/api/portfolio/${cid}`, { token: ctx.t1.token });
    const posBefore = before.positions.find((p) => p.symbol === "E2EA")?.quantity ?? 0;
    const sell = await http.post(
      "/api/orders",
      { challengeId: cid, symbol: "E2EA", side: "sell", type: "limit", quantity: 1, price: 90 },
      { token: ctx.t1.token },
    );
    await waitStatus(ctx.t1.token, cid, sell.orderId, ["open"], "own ask rests");
    const buy = await http.post(
      "/api/orders",
      { challengeId: cid, symbol: "E2EA", side: "buy", type: "limit", quantity: 1, price: 90 },
      { token: ctx.t1.token },
    );
    await waitStatus(ctx.t1.token, cid, sell.orderId, ["cancelled"], "older ask cancelled");
    const row = await waitStatus(ctx.t1.token, cid, buy.orderId, ["open"], "new bid rests");
    t.eq(row.remainingQuantity, 1, "no wash trade should fill the new bid");
    const after = await http.get(`/api/portfolio/${cid}`, { token: ctx.t1.token });
    t.eq(after.positions.find((p) => p.symbol === "E2EA")?.quantity ?? 0, posBefore);
    await http.del(`/api/orders/${buy.orderId}`, { token: ctx.t1.token }).catch(() => {});
  });

  await t.test("exposure cap: position + working size is capped at maxOrderQuantity", async () => {
    const cid = ctx.dir.id;
    const cap = ctx.dir.config.maxOrderQuantity;
    const taker = ctx.fresh ?? ctx.t3;
    const qty = async () => {
      const p = await http.get(`/api/portfolio/${cid}`, { token: taker.token });
      return p.positions.find((x) => x.symbol === "E2EA")?.quantity ?? 0;
    };
    const start = await qty();
    const room = cap - start;
    t.ok(room > 0, `taker already at the cap (${start})`);
    const sell = await http.post(
      "/api/orders",
      { challengeId: cid, symbol: "E2EA", side: "sell", type: "limit", quantity: room, price: 2 },
      { token: ctx.t2.token },
    );
    await waitStatus(ctx.t2.token, cid, sell.orderId, ["open"], "maker ask rests");
    const buy = await http.post(
      "/api/orders",
      { challengeId: cid, symbol: "E2EA", side: "buy", type: "limit", quantity: room + 5, price: 2 },
      { token: taker.token },
    );
    t.eq(buy.quantity, room, "API should clamp to the remaining room");
    await waitStatus(taker.token, cid, buy.orderId, ["filled"], "taker fills to the cap");
    await t.throws(
      () =>
        http.post(
          "/api/orders",
          { challengeId: cid, symbol: "E2EA", side: "buy", type: "limit", quantity: 1, price: 2 },
          { token: taker.token },
        ),
      { status: 409, error: "no_capacity" },
    );
    const held = await poll(async () => ((await qty()) === cap ? cap : null), {
      label: `taker holds ${cap}`,
    });
    t.ok(held <= ctx.dir.config.maxPosition, `inventory ${held} exceeded maxPosition`);
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
