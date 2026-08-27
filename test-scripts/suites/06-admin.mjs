import { http, poll, sleep } from "../lib.mjs";

export async function suiteAdmin(t, ctx) {
  t.suite("Admin live controls");

  const cid = ctx.dir.id;

  await t.test("trader cannot list users or post news", async () => {
    await t.throws(() => http.get("/api/admin/users", { token: ctx.t1.token }), {
      status: 403,
    });
    await t.throws(
      () =>
        http.post(
          `/api/admin/${cid}/news`,
          { message: "nope", level: "info" },
          { token: ctx.t1.token },
        ),
      { status: 403 },
    );
  });

  await t.test("GET /api/admin/users (admin)", async () => {
    const users = await http.get("/api/admin/users", { token: ctx.admin.token });
    t.ok(Array.isArray(users) && users.length >= 3);
    t.ok(users.some((u) => u.role === "admin"));
    t.ok(users.some((u) => u.username === ctx.t1.user.username));
    t.ok(users.every((u) => !("passwordHash" in u)), "password hashes must not leak");
  });

  await t.test("hard-set price is visible on market API", async () => {
    await http.post(
      `/api/admin/${cid}/price`,
      { symbol: "E2EA", price: 123.45 },
      { token: ctx.admin.token },
    );
    const seen = await poll(
      async () => {
        const p = await http.get(`/api/market/${cid}/E2EA/price`);
        return Math.abs((p.price ?? 0) - 123.45) < 1e-6 ? p : null;
      },
      { timeout: 12_000, label: "hard-set price 123.45" },
    );
    t.approx(seen.price, 123.45);
  });

  await t.test("drift target is accepted", async () => {
    const r = await http.post(
      `/api/admin/${cid}/drift`,
      { symbol: "E2EA", target: 130, speed: 3 },
      { token: ctx.admin.token },
    );
    t.eq(r.ok, true);
  });

  await t.test("post announcement + market news; kind not in trader payload", async () => {
    const ann = await http.post(
      `/api/admin/${cid}/news`,
      { message: "E2E announcement", level: "warning", feed: "announcement" },
      { token: ctx.admin.token },
    );
    t.eq(ann.item.message, "E2E announcement");
    t.eq(ann.item.level, "warning");
    t.eq(ann.item.feed, "announcement");
    t.ok(!("kind" in ann.item), "kind must not be serialized to clients");

    const mkt = await http.post(
      `/api/admin/${cid}/news`,
      { message: "E2E headline", level: "info", feed: "news" },
      { token: ctx.admin.token },
    );
    t.eq(mkt.item.feed, "news");

    const all = await http.get(`/api/challenges/${cid}/news`, { token: ctx.t1.token });
    t.ok(all.items.some((i) => i.message === "E2E announcement"));
    t.ok(all.items.some((i) => i.message === "E2E headline"));

    const onlyNews = await http.get(`/api/challenges/${cid}/news`, {
      token: ctx.t1.token,
      query: { feed: "news" },
    });
    t.ok(onlyNews.items.every((i) => i.feed === "news"));
    t.ok(onlyNews.items.some((i) => i.message === "E2E headline"));
  });

  await t.test("scheduled news is not visible until publishAt", async () => {
    const when = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await http.post(
      `/api/admin/${cid}/news`,
      {
        message: "E2E future headline — should stay dormant",
        level: "urgent",
        feed: "news",
        publishAt: when,
      },
      { token: ctx.admin.token },
    );
    t.eq(res.scheduled, true);
    const feed = await http.get(`/api/challenges/${cid}/news`, { token: ctx.t1.token });
    t.ok(
      !feed.items.some((i) => i.message.includes("should stay dormant")),
      "scheduled item leaked into the live feed",
    );
  });

  await t.test("empty news message is 400", async () => {
    const r = await http.request("POST", `/api/admin/${cid}/news`, {
      token: ctx.admin.token,
      body: { message: "", level: "info" },
    });
    t.eq(r.status, 400);
  });

  await t.test("list a new spot live and optionally lock it", async () => {
    const listed = await http.post(
      `/api/admin/${cid}/symbols`,
      {
        symbol: "ZETA",
        name: "Zeta",
        initialPrice: 20,
        volatility: 0.1,
        tickSize: 0.01,
        locked: true,
      },
      { token: ctx.admin.token },
    );
    t.eq(listed.ok, true);
    t.eq(listed.symbol, "ZETA");

    await sleep(600);
    await t.throws(
      () =>
        http.post(
          "/api/orders",
          {
            challengeId: cid,
            symbol: "ZETA",
            side: "buy",
            type: "limit",
            quantity: 1,
            price: 20,
          },
          { token: ctx.t1.token },
        ),
      { status: 409, error: "symbol_locked" },
    );

    await http.post(
      `/api/admin/${cid}/tradeable`,
      { symbol: "ZETA", tradeable: true },
      { token: ctx.admin.token },
    );
    await sleep(400);
    const ack = await http.post(
      "/api/orders",
      {
        challengeId: cid,
        symbol: "ZETA",
        side: "buy",
        type: "limit",
        quantity: 1,
        price: 20,
      },
      { token: ctx.t1.token },
    );
    t.eq(ack.status, "accepted");
    await http.del(`/api/orders/${ack.orderId}`, { token: ctx.t1.token }).catch(() => {});
  });

  await t.test("duplicate live symbol is 409", async () => {
    await t.throws(
      () =>
        http.post(
          `/api/admin/${cid}/symbols`,
          { symbol: "E2EA", name: "dup", initialPrice: 1, volatility: 0.1, tickSize: 0.01 },
          { token: ctx.admin.token },
        ),
      { status: 409, error: "symbol_exists" },
    );
  });

  await t.test("price history endpoint returns an array", async () => {
    const hist = await http.get(`/api/market/${cid}/E2EA/history`, { query: { limit: 20 } });
    t.ok(Array.isArray(hist));
  });

  await t.test("go live on MM challenge and confirm scoring kind", async () => {
    if (!ctx.mm) {
      t.skip("MM live", "MM challenge not created");
      return;
    }
    const live = await http.post(
      `/api/challenges/${ctx.mm.id}/status`,
      { status: "live" },
      { token: ctx.admin.token },
    );
    t.eq(live.status, "live");
    t.eq(live.scoring.kind, "market_making");
    ctx.mm = live;
    await http.post(`/api/challenges/${ctx.mm.id}/join`, {}, { token: ctx.t1.token });
    const pf = await http.get(`/api/portfolio/${ctx.mm.id}`, { token: ctx.t1.token });
    t.ok(typeof pf.score === "number");
  });
}
