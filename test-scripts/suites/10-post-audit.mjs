import {
  awaitEngine,
  directionalConfig,
  edenConfig,
  http,
  nowId,
  poll,
  scriptedEdenConfig,
  sleep,
  waitStatus,
} from "../lib.mjs";

const qty = (p, symbol) => p.positions.find((x) => x.symbol === symbol)?.quantity ?? 0;

/**
 * Regressions from AUDIT.md and mechanics added after it (options exercise,
 * bonds, freeze on Eden routes, lifecycle guards). The options cycle expires
 * one real minute after it opens, so the exercise runs in the background
 * while the other checks proceed.
 */
export async function suitePostAudit(t, ctx) {
  t.suite("Post-audit regressions / new mechanics");

  await t.test("probe Eden with a one-minute options cycle goes live", async () => {
    const base = edenConfig();
    const created = await http.post(
      "/api/challenges",
      {
        name: `E2E Probe ${nowId("")}`,
        description: "Isolated post-audit probe — ended after the run.",
        type: "new_eden",
        config: {
          ...base,
          symbols: [base.symbols[0]],
          eden: {
            ...base.eden,
            options: { ...base.eden.options, cycleMinutes: 1 },
            bonds: [
              { id: "discount", name: "E2E Discount", price: 200, faceValue: 250, couponPer5Min: 0, maxPerUser: 1 },
              { id: "whale", name: "E2E Whale", price: 50_000, faceValue: 50_000, couponPer5Min: 0, maxPerUser: 1 },
            ],
            etfs: [],
          },
        },
        scoring: { kind: "directional", pnlWeight: 1 },
        endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      },
      { token: ctx.admin.token },
    );
    ctx.createdIds.push(created.id);
    ctx.probe = created;
    await http.post(`/api/challenges/${created.id}/status`, { status: "live" }, { token: ctx.admin.token });
    for (const tr of [ctx.t1, ctx.t2, ctx.t3]) {
      await http.post(`/api/challenges/${created.id}/join`, {}, { token: tr.token });
    }
    await awaitEngine(ctx.admin.token, ctx.t1.token, created.id, "AERIUM");
  });

  const pid = () => ctx.probe?.id;

  await t.test("a written ITM call trades on the option book", async () => {
    if (!pid()) return t.skip("option trade", "probe missing");
    await http.post(`/api/admin/${pid()}/options/open`, { underlying: "AERIUM" }, { token: ctx.admin.token });
    const { contracts } = await poll(
      async () => {
        const r = await http.get(`/api/options/${pid()}`);
        return r.contracts?.length ? r : null;
      },
      { timeout: 15_000, label: "probe option contracts" },
    );
    const call = contracts
      .filter((c) => c.optionType === "call")
      .sort((a, b) => a.strike - b.strike)[0];
    t.ok(call && call.strike < 1000, `lowest call strike ${call?.strike} should be in the money`);
    const expiresAt = Date.parse(call.expiresAt);
    t.ok(expiresAt - Date.now() <= 90_000, `cycle expires in ${expiresAt - Date.now()}ms`);

    const ask = await http.post(
      "/api/orders",
      { challengeId: pid(), symbol: call.symbol, side: "sell", type: "limit", quantity: 1, price: 60 },
      { token: ctx.t2.token },
    );
    await waitStatus(ctx.t2.token, pid(), ask.orderId, ["open"], "written call rests");
    const bid = await http.post(
      "/api/orders",
      { challengeId: pid(), symbol: call.symbol, side: "buy", type: "limit", quantity: 1, price: 60 },
      { token: ctx.t1.token },
    );
    await waitStatus(ctx.t1.token, pid(), bid.orderId, ["filled"], "call bought");
    ctx.call = call;
    ctx.exercise = exerciseAtExpiry(ctx, call, expiresAt).catch((error) => ({ error }));
  });

  await t.test("allowMargin:false blocks buys the account cannot fund (H-5)", async () => {
    const created = await http.post(
      "/api/challenges",
      {
        name: `E2E NoMargin ${nowId("")}`,
        type: "directional",
        config: directionalConfig({
          symbols: [{ symbol: "NMG", name: "No Margin", initialPrice: 100, volatility: 0, tickSize: 0.01 }],
          startingCash: 1000,
          allowMargin: false,
        }),
      },
      { token: ctx.admin.token },
    );
    ctx.createdIds.push(created.id);
    ctx.noMargin = created;
    await http.post(`/api/challenges/${created.id}/status`, { status: "live" }, { token: ctx.admin.token });
    await http.post(`/api/challenges/${created.id}/join`, {}, { token: ctx.t1.token });
    await http.post(`/api/challenges/${created.id}/join`, {}, { token: ctx.t2.token });
    await awaitEngine(ctx.admin.token, ctx.t1.token, created.id, "NMG");

    const ask = await http.post(
      "/api/orders",
      { challengeId: created.id, symbol: "NMG", side: "sell", type: "limit", quantity: 20, price: 100 },
      { token: ctx.t2.token },
    );
    const askRow = await waitStatus(ctx.t2.token, created.id, ask.orderId, ["open", "rejected", "cancelled"], "ask");
    if (askRow.status !== "open") return t.skip("margin buy", `short ask was ${askRow.status}`);
    const bid = await http.post(
      "/api/orders",
      { challengeId: created.id, symbol: "NMG", side: "buy", type: "limit", quantity: 20, price: 100 },
      { token: ctx.t1.token },
    );
    await waitStatus(
      ctx.t1.token,
      created.id,
      bid.orderId,
      ["filled", "partially_filled", "rejected", "cancelled"],
      "margin buy processed",
    );
    await sleep(1000);
    const p = await http.get(`/api/portfolio/${created.id}`, { token: ctx.t1.token });
    t.ok(
      p.cash >= -1e-6,
      `with $1,000 and allowMargin:false, t1 bought ${qty(p, "NMG")} NMG @ 100 and cash is ${p.cash}`,
    );
  });

  await t.test("an ended, finalized challenge cannot be set live again", async () => {
    const id = ctx.noMargin?.id;
    if (!id) return t.skip("re-live", "no-margin challenge missing");
    await http.post(`/api/challenges/${id}/status`, { status: "ended" }, { token: ctx.admin.token });
    await sleep(10_000);
    const board = await http.get(`/api/leaderboard/${id}`);
    const relive = await http.request("POST", `/api/challenges/${id}/status`, {
      token: ctx.admin.token,
      body: { status: "live" },
    });
    if (relive.status === 409) return;

    // t2 is short from the margin test, so a 1-lot buy has exposure room.
    const order = () =>
      http.request("POST", "/api/orders", {
        token: ctx.t2.token,
        body: { challengeId: id, symbol: "NMG", side: "buy", type: "limit", quantity: 1, price: 1 },
      });
    let ack = await order();
    const firstError = ack.body?.error;
    // Finalization leaves the market frozen; an admin unfreeze is the next thing a host would try.
    let unfreeze = null;
    if (firstError === "market_frozen") {
      unfreeze = await http.request("POST", `/api/admin/${id}/freeze`, {
        token: ctx.admin.token,
        body: { frozen: false },
      });
      ack = await order();
    }
    await sleep(6000);
    const rows = await http.get("/api/orders", { token: ctx.t2.token, query: { challengeId: id } });
    const row = rows.find((o) => o.id === ack.body?.orderId);
    const book = await http.get(`/api/market/${id}/NMG/orderbook`);
    const onBook = (book.bids ?? []).some((l) => l.price === 1);
    const boardAfter = await http.get(`/api/leaderboard/${id}`);
    if (ack.body?.orderId) {
      await http.del(`/api/orders/${ack.body.orderId}`, { token: ctx.t2.token }).catch(() => {});
    }
    await http.post(`/api/challenges/${id}/status`, { status: "ended" }, { token: ctx.admin.token });
    t.eq(boardAfter, board, "final leaderboard changed after re-live");
    throw new Error(
      `ended→live returned ${relive.status}; first order ${firstError ?? "accepted"}` +
        (unfreeze ? `; unfreeze ${unfreeze.status}` : "") +
        `; order ack ${ack.status}${ack.body?.error ? ` ${ack.body.error}` : ""}, row ${row?.status ?? "missing"} after 6s, on book ${onBook}`,
    );
  });

  await t.test("control routes on an ended challenge are refused", async () => {
    const id = ctx.noMargin?.id;
    if (!id) return t.skip("ended controls", "no-margin challenge missing");
    await t.throws(
      () => http.post(`/api/admin/${id}/freeze`, { frozen: true }, { token: ctx.admin.token }),
      { status: 409, error: "challenge_not_live" },
    );
    await t.throws(
      () => http.post("/api/orders/cancel-all", { challengeId: id }, { token: ctx.t1.token }),
      { status: 409, error: "challenge_not_cancellable" },
    );
  });

  await t.test("freeze blocks Eden off-book routes and shows on the challenge", async () => {
    const cid = ctx.eden?.id;
    if (!cid) return t.skip("eden freeze", "eden challenge missing");
    const offer = await http.post(
      `/api/admin/${cid}/otc`,
      {
        userId: ctx.t1.user.id,
        description: "E2E frozen desk",
        legs: [{ symbol: "HELION", quantity: 1, price: 250 }],
        cashToTrader: 0,
        expiresSec: 60,
      },
      { token: ctx.admin.token },
    );
    await http.post(`/api/admin/${cid}/freeze`, { frozen: true }, { token: ctx.admin.token });
    try {
      const c = await http.get(`/api/challenges/${cid}`, { token: ctx.t1.token });
      t.eq(c.frozen, true, "challenge payload should report frozen");
      const blocked = { status: 409, error: "market_frozen" };
      await t.throws(
        () => http.post("/api/markets/bonds/purchase", { challengeId: cid, bondId: "standard", quantity: 1 }, { token: ctx.t3.token }),
        blocked,
      );
      await t.throws(
        () => http.post("/api/markets/etfs/trade", { challengeId: cid, etfSymbol: "ORB", action: "create", quantity: 1 }, { token: ctx.t3.token }),
        blocked,
      );
      await t.throws(
        () =>
          http.post(
            "/api/options/exercise",
            { challengeId: cid, symbol: ctx.optionContracts?.[0]?.symbol ?? "AERIUM", quantity: 1 },
            { token: ctx.t1.token },
          ),
        blocked,
      );
      await t.throws(
        () => http.post(`/api/otc/${offer.offer.id}/respond`, { action: "accept" }, { token: ctx.t1.token }),
        blocked,
      );
      const rejected = await http.post(`/api/otc/${offer.offer.id}/respond`, { action: "reject" }, { token: ctx.t1.token });
      t.eq(rejected.result, "rejected", "rejecting should stay allowed while frozen");
    } finally {
      await http.post(`/api/admin/${cid}/freeze`, { frozen: false }, { token: ctx.admin.token });
    }
    const after = await http.get(`/api/challenges/${cid}`, { token: ctx.t1.token });
    t.eq(after.frozen, false);
  });

  await t.test("host backstops resolve an auction and award a grant before the deadline", async () => {
    if (!pid()) return t.skip("backstops", "probe missing");
    const admin = { token: ctx.admin.token };
    const auction = await http.post(`/api/admin/${pid()}/auction`, { durationSec: 600 }, admin);
    const grant = await http.post(
      `/api/admin/${pid()}/grant`,
      { symbol: "AERIUM", description: "E2E early award", prize: 1, durationSec: 600 },
      admin,
    );
    await http.post(`/api/admin/${pid()}/auction/${auction.auctionId}/resolve`, {}, admin);
    await http.post(`/api/admin/${pid()}/grant/${grant.grantId}/award`, {}, admin);
    await sleep(8000);
    const a = await http.get(`/api/auctions/${pid()}`, { token: ctx.t1.token });
    const v = await http.get(`/api/votes/${pid()}`, { token: ctx.t1.token });
    t.ok(
      a.auction?.status === "resolved" && v.grant?.status === "awarded",
      `8s after both backstops returned ok: auction ${a.auction?.status}, grant ${v.grant?.status}`,
    );
  });

  await t.test("admin Eden controls on an unknown challenge are 404", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    const bodies = {
      otc: {
        userId: ctx.t1.user.id,
        description: "E2E ghost",
        legs: [{ symbol: "AERIUM", quantity: 1, price: 1 }],
        cashToTrader: 0,
        expiresSec: 30,
      },
      vote: { title: "E2E ghost", description: "ghost", durationSec: 30 },
      grant: { symbol: "AERIUM", description: "ghost", prize: 1, durationSec: 30 },
      auction: { durationSec: 30 },
    };
    const got = [];
    for (const [path, body] of Object.entries(bodies)) {
      const r = await http.request("POST", `/api/admin/${ghost}/${path}`, { token: ctx.admin.token, body });
      got.push(`${path} ${r.status}`);
    }
    t.ok(got.every((s) => s.endsWith(" 404")), got.join(", "));
  });

  await t.test("a scripted event flipped live before startsAt keeps the market closed", async () => {
    const created = await http.post(
      "/api/challenges",
      {
        name: `E2E Early ${nowId("")}`,
        description: "Isolated pre-start probe — ended after the test.",
        type: "new_eden",
        config: scriptedEdenConfig(),
        scoring: { kind: "directional", pnlWeight: 1 },
        startsAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      },
      { token: ctx.admin.token },
    );
    ctx.createdIds.push(created.id);
    await http.post(`/api/challenges/${created.id}/status`, { status: "live" }, { token: ctx.admin.token });
    await http.post(`/api/challenges/${created.id}/join`, {}, { token: ctx.t1.token });
    // Reconcile claims live rows every few seconds.
    await sleep(8000);
    const ack = await http.request("POST", "/api/orders", {
      token: ctx.t1.token,
      body: { challengeId: created.id, symbol: "AERIUM", side: "buy", type: "limit", quantity: 1, price: 500 },
    });
    await sleep(3000);
    const book = await http.get(`/api/market/${created.id}/AERIUM/orderbook`);
    const rested = (book.bids ?? []).some((l) => l.price === 500);
    const botLevels =
      (book.bids ?? []).filter((l) => l.price !== 500).length + (book.asks ?? []).length;
    await http.post(`/api/challenges/${created.id}/status`, { status: "ended" }, { token: ctx.admin.token });
    t.ok(
      !rested && botLevels === 0,
      `20 min before startsAt: order ${ack.status}${ack.body?.error ? ` ${ack.body.error}` : ""}, rested ${rested}, bot levels ${botLevels}`,
    );
  });

  await t.test("bond bought below face value does not mint PnL", async () => {
    if (!pid()) return t.skip("bond pnl", "probe missing");
    const before = await http.get(`/api/portfolio/${pid()}`, { token: ctx.t3.token });
    await http.post(
      "/api/markets/bonds/purchase",
      { challengeId: pid(), bondId: "discount", quantity: 1 },
      { token: ctx.t3.token },
    );
    const after = await poll(
      async () => {
        const p = await http.get(`/api/portfolio/${pid()}`, { token: ctx.t3.token });
        return p.bonds?.some((b) => b.bondId === "discount") ? p : null;
      },
      { timeout: 15_000, label: "discount bond held" },
    );
    t.approx(after.cash, before.cash - 200, 1, `bond price not debited: ${before.cash} → ${after.cash}`);
    t.approx(
      after.pnl,
      before.pnl,
      1,
      `buying at 200 a bond marked at its 250 face moved PnL ${before.pnl} → ${after.pnl}`,
    );
  });

  await t.test("bond purchase is refused when cash cannot cover it", async () => {
    if (!pid()) return t.skip("bond cash", "probe missing");
    const before = await http.get(`/api/portfolio/${pid()}`, { token: ctx.t3.token });
    const r = await http.request("POST", "/api/markets/bonds/purchase", {
      token: ctx.t3.token,
      body: { challengeId: pid(), bondId: "whale", quantity: 1 },
    });
    if (r.status === 409) return;
    t.eq(r.status, 202);
    const held = await poll(
      async () => {
        const p = await http.get(`/api/portfolio/${pid()}`, { token: ctx.t3.token });
        return p.bonds?.some((b) => b.bondId === "whale") ? p : null;
      },
      { timeout: 5_000, label: "whale bond" },
    ).catch(() => null);
    t.ok(
      !held,
      `$50,000 bond settled with $${Math.round(before.cash)} cash; cash is now ${held?.cash}`,
    );
  });

  await t.test("bond purchase requires enrollment", async () => {
    if (!pid() || !ctx.fresh2) return t.skip("bond enrollment", "probe or unenrolled user missing");
    const r = await http.request("POST", "/api/markets/bonds/purchase", {
      token: ctx.fresh2.token,
      body: { challengeId: pid(), bondId: "discount", quantity: 1 },
    });
    if (r.status === 403) return t.eq(r.body?.error, "not_enrolled");
    await sleep(3000);
    const cat = await http.get(`/api/markets/${pid()}/bonds`, { token: ctx.fresh2.token });
    const ghost = cat.holdings?.some((h) => h.bondId === "discount");
    const portfolio = await http.request("GET", `/api/portfolio/${pid()}`, { token: ctx.fresh2.token });
    throw new Error(
      `non-participant bond purchase returned ${r.status}${ghost ? ", created a bond holding" : ""}${
        portfolio.status === 200 ? `, and enrolled them (portfolio cash ${portfolio.body.cash})` : ""
      }`,
    );
  });

  await t.test("exercise delivers the underlying at strike and assigns the writer", async () => {
    if (!ctx.exercise) return t.skip("exercise", "no option position");
    const r = await ctx.exercise;
    if (r.error) throw r.error;
    t.eq(r.ack.status, "accepted");
    const sym = ctx.call.symbol;
    const holder = await poll(
      async () => {
        const p = await http.get(`/api/portfolio/${pid()}`, { token: ctx.t1.token });
        return qty(p, "AERIUM") === 1 && qty(p, sym) === 0 ? p : null;
      },
      { timeout: 15_000, label: "holder receives 1 AERIUM" },
    );
    t.approx(
      r.before.cash - holder.cash,
      ctx.call.strike,
      5,
      `holder paid ${r.before.cash - holder.cash}, strike ${ctx.call.strike}`,
    );
    const writer = await poll(
      async () => {
        const p = await http.get(`/api/portfolio/${pid()}`, { token: ctx.t2.token });
        return qty(p, "AERIUM") === -1 && qty(p, sym) === 0 ? p : null;
      },
      { timeout: 15_000, label: "writer assigned -1 AERIUM" },
    );
    t.ok(writer);
  });

  await t.test("OTC cap check ignores working orders that acceptance cancels", async () => {
    if (!ctx.exercise || !pid()) return t.skip("otc cap", "no exercised position");
    const cap = ctx.probe.config.eden.rules.positionCap;
    const held = qty(await http.get(`/api/portfolio/${pid()}`, { token: ctx.t1.token }), "AERIUM");
    const rest = cap - held - 2;
    // Each order is clamped to maxOrderQuantity, so build the working size from slices.
    for (let left = rest; left > 0; ) {
      const size = Math.min(left, ctx.probe.config.maxOrderQuantity);
      const bid = await http.post(
        "/api/orders",
        { challengeId: pid(), symbol: "AERIUM", side: "buy", type: "limit", quantity: size, price: 1 },
        { token: ctx.t1.token },
      );
      left -= bid.quantity ?? size;
    }
    await poll(
      async () => {
        const book = await http.get(`/api/market/${pid()}/AERIUM/orderbook`);
        return (book.bids ?? []).find((l) => l.price === 1)?.quantity >= rest ? true : null;
      },
      { label: `${rest} lots working at 1` },
    );
    const offer = await http.post(
      `/api/admin/${pid()}/otc`,
      {
        userId: ctx.t1.user.id,
        description: "E2E cap",
        legs: [{ symbol: "AERIUM", quantity: 3, price: 1000 }],
        cashToTrader: 0,
        expiresSec: 30,
      },
      { token: ctx.admin.token },
    );
    const r = await http.request("POST", `/api/otc/${offer.offer.id}/respond`, {
      token: ctx.t1.token,
      body: { action: "accept" },
    });
    await http.post("/api/orders/cancel-all", { challengeId: pid() }, { token: ctx.t1.token }).catch(() => {});
    t.eq(
      r.status,
      200,
      `accept returned ${r.status} ${r.body?.error ?? ""}: ${held} held + 3 fits the cap of ${cap} once the ${rest} working lots are cancelled`,
    );
  });
}

async function exerciseAtExpiry(ctx, call, expiresAt) {
  const pid = ctx.probe.id;
  await sleep(Math.max(0, expiresAt - Date.now() + 500));
  await poll(
    async () => {
      const { contracts } = await http.get(`/api/options/${pid}`);
      return contracts.find((c) => c.symbol === call.symbol)?.status === "exercise_window" ? true : null;
    },
    { timeout: 10_000, interval: 250, label: "exercise window opens" },
  );
  const before = await http.get(`/api/portfolio/${pid}`, { token: ctx.t1.token });
  const ack = await http.post(
    "/api/options/exercise",
    { challengeId: pid, symbol: call.symbol, quantity: 1 },
    { token: ctx.t1.token },
  );
  return { before, ack };
}
