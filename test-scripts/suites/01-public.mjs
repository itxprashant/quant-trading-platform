import { API, http } from "../lib.mjs";

export async function suitePublic(t) {
  t.suite("Public / platform");

  await t.test("GET /api/health is ok", async () => {
    const body = await http.get("/api/health");
    t.eq(body.status, "ok");
    t.ok(typeof body.ts === "number" && body.ts > 1e12, "ts should be epoch ms");
    const drift = Math.abs(body.ts - Date.now());
    t.ok(drift < 60_000, `health clock drift ${drift}ms should be < 60s`);
  });

  await t.test("GET /api/metrics exposes Prometheus counters", async () => {
    const r = await http.request("GET", "/api/metrics");
    t.eq(r.status, 200);
    t.ok(typeof r.body === "string" && r.body.includes("qtp_http_requests_total"));
  });

  await t.test("web pages respond 200", async () => {
    for (const path of ["/", "/login", "/challenges"]) {
      const r = await http.request("GET", `${API}${path}`);
      t.eq(r.status, 200, `${path} → ${r.status}`);
    }
  });

  await t.test("list challenges (unauthenticated)", async () => {
    const list = await http.get("/api/challenges");
    t.ok(Array.isArray(list), "should return an array");
    t.ok(list.length >= 1, "production should have at least one challenge");
    for (const c of list) {
      t.ok(c.id && c.name && c.type && c.status, "challenge has required fields");
      t.neq(c.status, "draft", "traders/public must not see drafts");
      t.ok(["directional", "market_making", "new_eden"].includes(c.type));
      t.ok(c.config?.symbols?.length >= 1);
    }
  });

  await t.test("GET challenge by id and slug", async () => {
    const list = await http.get("/api/challenges");
    const live = list.find((c) => c.status === "live") ?? list[0];
    const byId = await http.get(`/api/challenges/${live.id}`);
    t.eq(byId.id, live.id);
    t.eq(byId.name, live.name);
    if (live.slug) {
      const bySlug = await http.get(`/api/challenges/${live.slug}`);
      t.eq(bySlug.id, live.id);
    }
  });

  await t.test("unknown challenge is 404", async () => {
    await t.throws(() => http.get("/api/challenges/00000000-0000-4000-8000-000000000000"), {
      status: 404,
      error: "not_found",
    });
  });

  await t.test("unauthenticated portfolio / admin / join are 401", async () => {
    const list = await http.get("/api/challenges");
    const id = list[0].id;
    await t.throws(() => http.get(`/api/portfolio/${id}`), { status: 401 });
    await t.throws(() => http.get("/api/admin/users"), { status: 401 });
    await t.throws(() => http.post(`/api/challenges/${id}/join`, {}), { status: 401 });
  });

  await t.test("news + market + leaderboard are readable without auth", async () => {
    const list = await http.get("/api/challenges");
    const live = list.find((c) => c.status === "live") ?? list[0];
    const news = await http.get(`/api/challenges/${live.id}/news`);
    t.ok(Array.isArray(news.items));
    for (const item of news.items) {
      t.ok(!("kind" in item) || item.kind == null, "news kind must not leak to public REST");
    }
    const symbols = await http.get(`/api/market/${live.id}/symbols`);
    t.ok(Array.isArray(symbols) && symbols.length >= 1);
    t.ok(typeof symbols[0].price === "number");
    const book = await http.get(`/api/market/${live.id}/${symbols[0].symbol}/orderbook`);
    t.eq(book.symbol, symbols[0].symbol);
    t.ok(Array.isArray(book.bids) && Array.isArray(book.asks));
    const lb = await http.get(`/api/leaderboard/${live.id}`);
    t.ok(Array.isArray(lb));
  });
}
