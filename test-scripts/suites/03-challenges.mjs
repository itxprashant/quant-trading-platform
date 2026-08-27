import { http, directionalConfig, mmConfig, nowId, awaitEngine } from "../lib.mjs";

export async function suiteChallenges(t, ctx) {
  t.suite("Challenge lifecycle & visibility");

  await t.test("trader cannot create a challenge", async () => {
    await t.throws(
      () =>
        http.post(
          "/api/challenges",
          {
            name: "should-fail",
            type: "directional",
            config: directionalConfig(),
          },
          { token: ctx.t1.token },
        ),
      { status: 403 },
    );
  });

  await t.test("create directional draft (admin)", async () => {
    const name = `E2E Dir ${nowId("")}`;
    const created = await http.post(
      "/api/challenges",
      {
        name,
        description: "Isolated e2e directional — safe to end.",
        type: "directional",
        config: directionalConfig(),
        scoring: { kind: "directional", pnlWeight: 1 },
      },
      { token: ctx.admin.token },
    );
    t.ok(created.id);
    t.eq(created.status, "draft");
    t.eq(created.type, "directional");
    t.ok(created.slug);
    ctx.dir = created;
    ctx.createdIds.push(created.id);
  });

  await t.test("create market-making draft (admin)", async () => {
    const created = await http.post(
      "/api/challenges",
      {
        name: `E2E MM ${nowId("")}`,
        type: "market_making",
        config: mmConfig(),
        scoring: {
          kind: "market_making",
          spreadCaptureWeight: 1,
          quoteUptimeWeight: 0.1,
          maxSpread: 1,
          minQuoteSize: 1,
          inventoryPenaltyWeight: 0.05,
          pnlWeight: 0.25,
        },
      },
      { token: ctx.admin.token },
    );
    t.eq(created.type, "market_making");
    t.eq(created.scoring.kind, "market_making");
    ctx.mm = created;
    ctx.createdIds.push(created.id);
  });

  await t.test("create-challenge validation: empty name / no symbols", async () => {
    const r = await http.request("POST", "/api/challenges", {
      token: ctx.admin.token,
      body: { name: "", type: "directional", config: { symbols: [] } },
    });
    t.eq(r.status, 400);
    t.eq(r.body.error, "validation_error");
  });

  await t.test("draft is hidden from trader list, visible to admin", async () => {
    const asTrader = await http.get("/api/challenges", { token: ctx.t1.token });
    t.ok(!asTrader.some((c) => c.id === ctx.dir.id), "trader list leaked a draft");
    const asAdmin = await http.get("/api/challenges", { token: ctx.admin.token });
    t.ok(asAdmin.some((c) => c.id === ctx.dir.id), "admin list missing draft");
  });

  await t.test("GET draft by id is 404 for traders and public", async () => {
    await t.throws(
      () => http.get(`/api/challenges/${ctx.dir.id}`, { token: ctx.t1.token }),
      { status: 404, error: "not_found" },
    );
    await t.throws(() => http.get(`/api/challenges/${ctx.dir.id}`), {
      status: 404,
      error: "not_found",
    });
    const asAdmin = await http.get(`/api/challenges/${ctx.dir.id}`, {
      token: ctx.admin.token,
    });
    t.eq(asAdmin.status, "draft");
  });

  await t.test("trader cannot join a draft", async () => {
    await t.throws(
      () => http.post(`/api/challenges/${ctx.dir.id}/join`, {}, { token: ctx.t1.token }),
      { status: 409, error: "challenge_not_joinable" },
    );
  });

  await t.test("PATCH challenge metadata", async () => {
    const updated = await http.patch(
      `/api/challenges/${ctx.dir.id}`,
      { description: "patched by e2e" },
      { token: ctx.admin.token },
    );
    t.eq(updated.description, "patched by e2e");
  });

  await t.test("schedule → live seeds prices and is joinable", async () => {
    const scheduled = await http.post(
      `/api/challenges/${ctx.dir.id}/status`,
      { status: "scheduled" },
      { token: ctx.admin.token },
    );
    t.eq(scheduled.status, "scheduled");

    const joined = await http.post(
      `/api/challenges/${ctx.dir.id}/join`,
      {},
      { token: ctx.t1.token },
    );
    t.eq(joined.joined, true);

    const live = await http.post(
      `/api/challenges/${ctx.dir.id}/status`,
      { status: "live" },
      { token: ctx.admin.token },
    );
    t.eq(live.status, "live");
    ctx.dir = live;

    const symbols = await http.get(`/api/market/${ctx.dir.id}/symbols`);
    t.eq(symbols.length, 2);
    t.approx(symbols[0].price, 100, 1e-6);
    t.approx(symbols[1].price, 50, 1e-6);
  });

  await t.test("engine runner is processing the directional book", async () => {
    await awaitEngine(ctx.admin.token, ctx.t1.token, ctx.dir.id, "E2EA");
  });

  await t.test("join is idempotent", async () => {
    const again = await http.post(
      `/api/challenges/${ctx.dir.id}/join`,
      {},
      { token: ctx.t1.token },
    );
    t.eq(again.joined, true);
  });

  await t.test("join ended challenge is rejected", async () => {
    const ended = ctx.existingEnded;
    if (!ended) {
      t.skip("join ended", "no ended challenge on production");
      return;
    }
    await t.throws(
      () => http.post(`/api/challenges/${ended.id}/join`, {}, { token: ctx.t1.token }),
      { status: 409, error: "challenge_not_joinable" },
    );
  });

  await t.test("trader cannot change status", async () => {
    await t.throws(
      () =>
        http.post(
          `/api/challenges/${ctx.dir.id}/status`,
          { status: "paused" },
          { token: ctx.t1.token },
        ),
      { status: 403 },
    );
  });

  await t.test("invalid status value is 400", async () => {
    const r = await http.request("POST", `/api/challenges/${ctx.dir.id}/status`, {
      token: ctx.admin.token,
      body: { status: "running" },
    });
    t.eq(r.status, 400);
  });
}
