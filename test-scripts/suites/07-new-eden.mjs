import { http, edenConfig, nowId, poll, sleep, awaitEngine, waitStatus } from "../lib.mjs";

export async function suiteNewEden(t, ctx) {
  t.suite("New Eden economy");

  await t.test("create + start isolated New Eden challenge", async () => {
    const created = await http.post(
      "/api/challenges",
      {
        name: `E2E Eden ${nowId("")}`,
        description: "Isolated New Eden e2e — ended after the run.",
        type: "new_eden",
        config: edenConfig(),
        scoring: { kind: "directional", pnlWeight: 1 },
        // Loans amortize to endsAt and are refused without one.
        endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      },
      { token: ctx.admin.token },
    );
    t.eq(created.type, "new_eden");
    t.ok(created.config.eden?.rules?.enabled);
    t.ok(created.endsAt, "endsAt should persist");
    ctx.eden = created;
    ctx.createdIds.push(created.id);
    const live = await http.post(
      `/api/challenges/${created.id}/status`,
      { status: "live" },
      { token: ctx.admin.token },
    );
    t.eq(live.status, "live");
    ctx.eden = live;
    await http.post(`/api/challenges/${created.id}/join`, {}, { token: ctx.t1.token });
    await http.post(`/api/challenges/${created.id}/join`, {}, { token: ctx.t2.token });
    await http.post(`/api/challenges/${created.id}/join`, {}, { token: ctx.t3.token });
  });

  const cid = () => ctx.eden.id;

  await t.test("engine runner is processing the Eden book", async () => {
    await awaitEngine(ctx.admin.token, ctx.t1.token, cid(), "AERIUM");
  });

  await t.test("loan on a directional challenge is 409 not_eden", async () => {
    await t.throws(
      () =>
        http.post(
          "/api/loans/request",
          { challengeId: ctx.dir.id, principal: 100 },
          { token: ctx.t1.token },
        ),
      { status: 409, error: "not_eden" },
    );
  });

  await t.test("principal above cap is 400", async () => {
    await t.throws(
      () =>
        http.post(
          "/api/loans/request",
          { challengeId: cid(), principal: 2_000_000 },
          { token: ctx.t1.token },
        ),
      { status: 400, error: "principal_too_large" },
    );
  });

  await t.test("non-positive principal is 400", async () => {
    const r = await http.request("POST", "/api/loans/request", {
      token: ctx.t1.token,
      body: { challengeId: cid(), principal: 0 },
    });
    t.eq(r.status, 400);
  });

  await t.test("request loan: cash +principal, debt = principal × 2", async () => {
    const before = await http.get(`/api/portfolio/${cid()}`, { token: ctx.t1.token });
    const res = await http.post(
      "/api/loans/request",
      { challengeId: cid(), principal: 400 },
      { token: ctx.t1.token },
    );
    t.eq(res.loan.principal, 400);
    t.approx(res.loan.totalRepay, 800);
    t.eq(res.loan.status, "active");

    const after = await poll(
      async () => {
        const p = await http.get(`/api/portfolio/${cid()}`, { token: ctx.t1.token });
        return (p.loanDebt ?? 0) >= 800 && p.cash >= before.cash + 400 - 1e-6 ? p : null;
      },
      { timeout: 20_000, label: "loan reflected on portfolio" },
    );
    t.approx(after.loanDebt, 800, 1e-4);
    // Eden margin is cash-based: free cash is cash, not equity.
    t.approx(after.freeCash, after.cash, 1e-4);
    t.ok(after.loans.some((l) => l.id === res.loan.id));
    ctx.loanId = res.loan.id;
  });

  await t.test("admin can issue a loan for another trader", async () => {
    const res = await http.post(
      `/api/loans/${cid()}/issue`,
      { userId: ctx.t2.user.id, principal: 100 },
      { token: ctx.admin.token },
    );
    t.eq(res.loan.userId, ctx.t2.user.id);
    t.approx(res.loan.totalRepay, 200);
  });

  await t.test("trader cannot issue loans via admin endpoint", async () => {
    await t.throws(
      () =>
        http.post(
          `/api/loans/${cid()}/issue`,
          { userId: ctx.t1.user.id, principal: 50 },
          { token: ctx.t1.token },
        ),
      { status: 403 },
    );
  });

  await t.test("bond catalog + once-only purchase", async () => {
    const cat = await http.get(`/api/markets/${cid()}/bonds`, { token: ctx.t1.token });
    t.ok(cat.templates.some((b) => b.id === "standard"));
    const book = await http.get(`/api/portfolio/${cid()}`, { token: ctx.t1.token });
    const price = (book.freeCash ?? book.cash) + 1;
    const buy = await http.post(
      "/api/markets/bonds/purchase",
      { challengeId: cid(), bondId: "standard", price },
      { token: ctx.t1.token },
    );
    t.eq(buy.status, "accepted");

    const held = await poll(
      async () => {
        const c = await http.get(`/api/markets/${cid()}/bonds`, { token: ctx.t1.token });
        const h = c.holdings.find((x) => x.bondId === "standard" && x.quantity >= 1);
        return h ? c : null;
      },
      { timeout: 15_000, label: "bond holding" },
    );
    t.eq(held.holdings[0].quantity, 1);
    t.approx(held.holdings[0].price, price);

    await t.throws(
      () =>
        http.post(
          "/api/markets/bonds/purchase",
          { challengeId: cid(), bondId: "standard", price: price + 1 },
          { token: ctx.t1.token },
        ),
      { status: 409, error: "bond_limit" },
    );
  });

  await t.test("unknown bond is 400 unknown_bond", async () => {
    await t.throws(
      () =>
        http.post(
          "/api/markets/bonds/purchase",
          { challengeId: cid(), bondId: "nope", price: 1 },
          { token: ctx.t1.token },
        ),
      { status: 400, error: "unknown_bond" },
    );
  });

  await t.test("ETF NAV = 1×AERIUM + 2×HELION; window closed rejects create", async () => {
    const { etfs } = await http.get(`/api/markets/${cid()}/etfs`);
    const orb = etfs.find((e) => e.symbol === "ORB");
    t.ok(orb, "ORB listed");
    t.approx(orb.nav, 1000 + 2 * 250, 1);
    t.eq(orb.windowOpen, false);

    await t.throws(
      () =>
        http.post(
          "/api/markets/etfs/trade",
          { challengeId: cid(), etfSymbol: "ORB", action: "create", quantity: 1 },
          { token: ctx.t1.token },
        ),
      { status: 409, error: "window_closed" },
    );
  });

  await t.test("ETF create without the basket is refused (physical delivery)", async () => {
    await http.post(
      `/api/admin/${cid()}/etf-window`,
      { etfSymbol: "ORB", open: true },
      { token: ctx.admin.token },
    );
    await poll(
      async () => {
        const { etfs } = await http.get(`/api/markets/${cid()}/etfs`);
        const orb = etfs.find((e) => e.symbol === "ORB");
        return orb?.windowOpen ? orb : null;
      },
      { timeout: 12_000, label: "ETF window open" },
    );
    await http.post(
      "/api/markets/etfs/trade",
      { challengeId: cid(), etfSymbol: "ORB", action: "create", quantity: 1 },
      { token: ctx.t3.token },
    );
    await sleep(2500);
    const p = await http.get(`/api/portfolio/${cid()}`, { token: ctx.t3.token });
    t.ok(
      !p.positions.some((x) => x.symbol === "ORB" && x.quantity !== 0),
      "ORB was minted without delivering AERIUM + 2 HELION",
    );
  });

  await t.test("ETF create/redeem swaps the basket at NAV without moving cash", async () => {
    // t3 buys the basket (1 AERIUM + 2 HELION) from t2, then converts it.
    const legs = [
      { symbol: "AERIUM", quantity: 1, price: 1000 },
      { symbol: "HELION", quantity: 2, price: 250 },
    ];
    for (const leg of legs) {
      const sell = await http.post(
        "/api/orders",
        { challengeId: cid(), symbol: leg.symbol, side: "sell", type: "limit", ...leg },
        { token: ctx.t2.token },
      );
      await waitStatus(ctx.t2.token, cid(), sell.orderId, ["open"], `t2 ${leg.symbol} ask`);
      const buy = await http.post(
        "/api/orders",
        { challengeId: cid(), symbol: leg.symbol, side: "buy", type: "limit", ...leg },
        { token: ctx.t3.token },
      );
      await waitStatus(ctx.t3.token, cid(), buy.orderId, ["filled"], `t3 ${leg.symbol} fill`);
    }
    const qty = (p, s) => p.positions.find((x) => x.symbol === s)?.quantity ?? 0;
    const seeded = await poll(
      async () => {
        const p = await http.get(`/api/portfolio/${cid()}`, { token: ctx.t3.token });
        return qty(p, "AERIUM") === 1 && qty(p, "HELION") === 2 ? p : null;
      },
      { timeout: 15_000, label: "t3 holds the basket" },
    );

    await http.post(
      "/api/markets/etfs/trade",
      { challengeId: cid(), etfSymbol: "ORB", action: "create", quantity: 1 },
      { token: ctx.t3.token },
    );
    const created = await poll(
      async () => {
        const p = await http.get(`/api/portfolio/${cid()}`, { token: ctx.t3.token });
        return qty(p, "ORB") === 1 ? p : null;
      },
      { timeout: 15_000, label: "ETF created" },
    );
    t.eq(qty(created, "AERIUM"), 0, "create should take the AERIUM leg");
    t.eq(qty(created, "HELION"), 0, "create should take both HELION units");
    t.approx(created.cash, seeded.cash, 5, "create should not move cash beyond carry");

    await http.post(
      "/api/markets/etfs/trade",
      { challengeId: cid(), etfSymbol: "ORB", action: "redeem", quantity: 1 },
      { token: ctx.t3.token },
    );
    const redeemed = await poll(
      async () => {
        const p = await http.get(`/api/portfolio/${cid()}`, { token: ctx.t3.token });
        return qty(p, "ORB") === 0 && qty(p, "AERIUM") === 1 ? p : null;
      },
      { timeout: 15_000, label: "ETF redeemed" },
    );
    t.eq(qty(redeemed, "HELION"), 2, "redeem should return both HELION units");

    // Hand the basket back so later grant tests start from flat books.
    for (const leg of legs) {
      const sell = await http.post(
        "/api/orders",
        { challengeId: cid(), symbol: leg.symbol, side: "sell", type: "limit", ...leg },
        { token: ctx.t3.token },
      );
      await waitStatus(ctx.t3.token, cid(), sell.orderId, ["open"], `t3 ${leg.symbol} ask`);
      const buy = await http.post(
        "/api/orders",
        { challengeId: cid(), symbol: leg.symbol, side: "buy", type: "limit", ...leg },
        { token: ctx.t2.token },
      );
      await waitStatus(ctx.t2.token, cid(), buy.orderId, ["filled"], `t2 ${leg.symbol} buyback`);
    }
    await http.post(
      `/api/admin/${cid()}/etf-window`,
      { etfSymbol: "ORB", open: false },
      { token: ctx.admin.token },
    );
  });

  await t.test("open options cycle lists calls and puts around ATM", async () => {
    await http.post(
      `/api/admin/${cid()}/options/open`,
      { underlying: "AERIUM" },
      { token: ctx.admin.token },
    );
    const { contracts } = await poll(
      async () => {
        const r = await http.get(`/api/options/${cid()}`);
        return r.contracts?.length > 0 ? r : null;
      },
      { timeout: 15_000, label: "option contracts listed" },
    );
    t.ok(contracts.some((c) => c.optionType === "call"));
    t.ok(contracts.some((c) => c.optionType === "put"));
    t.ok(contracts.every((c) => c.underlying === "AERIUM"));
    t.ok(contracts.every((c) => c.status === "open"));
    ctx.optionContracts = contracts;
    const sample = contracts[0];
    t.ok(typeof sample.intrinsic === "number" || sample.intrinsic == null);
  });

  await t.test("exercise outside the window is 409", async () => {
    const sym = ctx.optionContracts?.[0]?.symbol;
    if (!sym) {
      t.skip("exercise", "no option contracts");
      return;
    }
    await t.throws(
      () =>
        http.post(
          "/api/options/exercise",
          { challengeId: cid(), symbol: sym, quantity: 1 },
          { token: ctx.t1.token },
        ),
      { status: 409, error: "not_in_exercise_window" },
    );
  });

  await t.test("Deal Desk: reject, accept, and bargain-at-fair", async () => {
    const rejectOffer = await http.post(
      `/api/admin/${cid()}/otc`,
      {
        userId: ctx.t1.user.id,
        description: "E2E reject me",
        legs: [{ symbol: "HELION", quantity: 1, price: 250 }],
        cashToTrader: 0,
        expiresSec: 30,
      },
      { token: ctx.admin.token },
    );
    const rejected = await http.post(
      `/api/otc/${rejectOffer.offer.id}/respond`,
      { action: "reject" },
      { token: ctx.t1.token },
    );
    t.eq(rejected.result, "rejected");

    const acceptOffer = await http.post(
      `/api/admin/${cid()}/otc`,
      {
        userId: ctx.t1.user.id,
        description: "E2E accept",
        legs: [{ symbol: "HELION", quantity: 2, price: 250 }],
        cashToTrader: 0,
        expiresSec: 30,
      },
      { token: ctx.admin.token },
    );
    const accepted = await http.post(
      `/api/otc/${acceptOffer.offer.id}/respond`,
      { action: "accept" },
      { token: ctx.t1.token },
    );
    // HTTP acceptance is provisional; the engine confirms and settles.
    t.eq(accepted.result, "accepted");
    const helion = (p) => p.positions.find((x) => x.symbol === "HELION")?.quantity ?? 0;
    const settled = await poll(
      async () => {
        const open = await http.get(`/api/otc/${cid()}`, { token: ctx.t1.token });
        if (open.some((o) => o.id === acceptOffer.offer.id)) return null;
        const p = await http.get(`/api/portfolio/${cid()}`, { token: ctx.t1.token });
        return helion(p) === 2 ? p : null;
      },
      { timeout: 15_000, label: "OTC accept settled (+2 HELION)" },
    );
    t.eq(helion(settled), 2);

    // Countering at exactly fair value never trips the reject probability.
    const bargainOffer = await http.post(
      `/api/admin/${cid()}/otc`,
      {
        userId: ctx.t1.user.id,
        description: "E2E bargain at fair",
        legs: [{ symbol: "HELION", quantity: 1, price: 250 }],
        cashToTrader: 0,
        expiresSec: 30,
      },
      { token: ctx.admin.token },
    );
    const bargained = await http.post(
      `/api/otc/${bargainOffer.offer.id}/respond`,
      { action: "bargain", counterCash: 0 },
      { token: ctx.t1.token },
    );
    t.eq(bargained.result, "accepted");
    const delayMs = Date.parse(bargained.settleAt) - Date.now();
    t.ok(delayMs > 2_500 && delayMs <= 6_000, `bargain should settle ~5s later, got ${delayMs}ms`);
    await poll(
      async () => {
        const p = await http.get(`/api/portfolio/${cid()}`, { token: ctx.t1.token });
        return helion(p) === 3 ? p : null;
      },
      { timeout: 20_000, label: "bargain settled after delay (+1 HELION)" },
    );

    await t.throws(
      () =>
        http.post(
          `/api/otc/${acceptOffer.offer.id}/respond`,
          { action: "accept" },
          { token: ctx.t2.token },
        ),
      { status: 403, error: "forbidden" },
    );
  });

  await t.test("blind auction: two bids, resolve, cutoff + premium", async () => {
    const opened = await http.post(
      `/api/admin/${cid()}/auction`,
      { durationSec: 8 },
      { token: ctx.admin.token },
    );
    t.ok(opened.auctionId);
    const a1 = await http.get(`/api/auctions/${cid()}`, { token: ctx.t1.token });
    t.eq(a1.auction.status, "open");
    t.eq(a1.auction.id, opened.auctionId);

    await http.post(
      `/api/auctions/${opened.auctionId}/bid`,
      { amount: 50 },
      { token: ctx.t1.token },
    );
    await http.post(
      `/api/auctions/${opened.auctionId}/bid`,
      { amount: 10 },
      { token: ctx.t2.token },
    );
    // Update sealed bid (last write wins).
    await http.post(
      `/api/auctions/${opened.auctionId}/bid`,
      { amount: 80 },
      { token: ctx.t1.token },
    );
    if (ctx.fresh2) {
      await t.throws(
        () =>
          http.post(
            `/api/auctions/${opened.auctionId}/bid`,
            { amount: 5 },
            { token: ctx.fresh2.token },
          ),
        { status: 403, error: "not_enrolled" },
      );
    }
    await t.throws(
      () =>
        http.post(
          `/api/auctions/${opened.auctionId}/bid`,
          { amount: 1e9 },
          { token: ctx.t2.token },
        ),
      { status: 409, error: "insufficient_cash" },
    );

    // Loan installments move cash and debt together, so cash + debt isolates the bid charge.
    const wealth = async (u) => {
      const p = await http.get(`/api/portfolio/${cid()}`, { token: u.token });
      return p.cash + (p.loanDebt ?? 0);
    };
    const t1Before = await wealth(ctx.t1);
    const t2Before = await wealth(ctx.t2);

    await http.post(
      `/api/admin/${cid()}/auction/${opened.auctionId}/resolve`,
      {},
      { token: ctx.admin.token },
    );
    const done = await poll(
      async () => {
        const a = await http.get(`/api/auctions/${cid()}`, { token: ctx.t1.token });
        return a.auction?.status === "resolved" ? a : null;
      },
      { timeout: 12_000, label: "auction resolved" },
    );
    t.ok(done.auction.cutoff != null);
    t.eq(done.myBid.amount, 80);
    // winnerFraction 0.5 of 2 bidders → 1 winner; highest bid (t1) wins.
    t.eq(done.myBid.won, true);
    t.eq(done.premium, true);

    const loser = await http.get(`/api/auctions/${cid()}`, { token: ctx.t2.token });
    t.eq(loser.myBid.won, false);
    t.eq(loser.premium, false);
    ctx.auctionId = opened.auctionId;

    // Paid auction: only the winner pays, and pays their own bid.
    const t1After = await poll(
      async () => {
        const w = await wealth(ctx.t1);
        return w <= t1Before - 75 ? w : null;
      },
      { timeout: 10_000, label: "winner charged the 80 bid" },
    );
    t.approx(t1Before - t1After, 80, 5);
    t.approx(await wealth(ctx.t2), t2Before, 5);
  });

  await t.test("bid after resolve is 409 auction_closed", async () => {
    await t.throws(
      () =>
        http.post(
          `/api/auctions/${ctx.auctionId}/bid`,
          { amount: 1 },
          { token: ctx.t1.token },
        ),
      { status: 409, error: "auction_closed" },
    );
  });

  await t.test("embargoed news is hidden on REST for non-premium traders", async () => {
    const msg = `E2E embargo ${nowId("")}`;
    const posted = await http.post(
      `/api/admin/${cid()}/news`,
      {
        message: msg,
        level: "urgent",
        feed: "news",
        kind: "signal",
        embargoSec: 20,
        fvEffects: [{ symbol: "AERIUM", delta: 5 }],
      },
      { token: ctx.admin.token },
    );
    t.ok(posted.item);
    t.ok(!("kind" in posted.item), "signal/noise kind leaked on the wire");

    const rest = await http.get(`/api/challenges/${cid()}/news`, { token: ctx.t2.token });
    t.ok(
      !rest.items.some((i) => i.message === msg),
      "embargoed headline leaked to a non-premium trader",
    );
    const asAdmin = await http.get(`/api/challenges/${cid()}/news`, {
      token: ctx.admin.token,
    });
    t.ok(asAdmin.items.some((i) => i.message === msg), "admin should see embargoed news");

    const fvs = await poll(
      async () => {
        const m = await http.get(`/api/admin/${cid()}/fair-value`, { token: ctx.admin.token });
        return m.AERIUM != null ? m : null;
      },
      { timeout: 15_000, label: "fair value after signal" },
    );
    t.ok(typeof fvs.AERIUM === "number");
  });

  await t.test("host set_fair_value", async () => {
    await http.post(
      `/api/admin/${cid()}/fair-value`,
      { symbol: "HELION", fairValue: 260 },
      { token: ctx.admin.token },
    );
    const fvs = await poll(
      async () => {
        const m = await http.get(`/api/admin/${cid()}/fair-value`, { token: ctx.admin.token });
        return Math.abs((m.HELION ?? 0) - 260) < 1e-6 ? m : null;
      },
      { timeout: 12_000, label: "FV HELION=260" },
    );
    t.approx(fvs.HELION, 260);
  });

  await t.test("policy vote: majority yes → passed + wealth tax command", async () => {
    const opened = await http.post(
      `/api/admin/${cid()}/vote`,
      {
        title: "E2E Solidarity",
        description: "Tax the top for the test.",
        durationSec: 20,
      },
      { token: ctx.admin.token },
    );
    t.ok(opened.proposalId);
    if (ctx.fresh2) {
      await t.throws(
        () =>
          http.post(
            `/api/votes/${opened.proposalId}/vote`,
            { choice: "no" },
            { token: ctx.fresh2.token },
          ),
        { status: 403, error: "not_enrolled" },
      );
    }
    await http.post(
      `/api/votes/${opened.proposalId}/vote`,
      { choice: "yes" },
      { token: ctx.t1.token },
    );
    await http.post(
      `/api/votes/${opened.proposalId}/vote`,
      { choice: "yes" },
      { token: ctx.t2.token },
    );
    // Flip t2 to no then back to yes — last write wins.
    await http.post(
      `/api/votes/${opened.proposalId}/vote`,
      { choice: "no" },
      { token: ctx.t2.token },
    );
    const mid = await http.get(`/api/votes/${cid()}`, { token: ctx.t2.token });
    t.eq(mid.myVote, "no");
    await http.post(
      `/api/votes/${opened.proposalId}/vote`,
      { choice: "yes" },
      { token: ctx.t2.token },
    );

    await http.post(
      `/api/admin/${cid()}/vote/${opened.proposalId}/close`,
      {},
      { token: ctx.admin.token },
    );
    const closed = await poll(
      async () => {
        const v = await http.get(`/api/votes/${cid()}`, { token: ctx.t1.token });
        return v.proposal?.status !== "open" ? v : null;
      },
      { timeout: 12_000, label: "vote closed" },
    );
    t.eq(closed.proposal.status, "passed");
    t.ok(closed.proposal.yes >= 2);
  });

  await t.test("vote after close is 409", async () => {
    const v = await http.get(`/api/votes/${cid()}`, { token: ctx.t1.token });
    await t.throws(
      () =>
        http.post(`/api/votes/${v.proposal.id}/vote`, { choice: "no" }, { token: ctx.t1.token }),
      { status: 409, error: "vote_closed" },
    );
  });

  await t.test("grant: largest holder wins the prize", async () => {
    // t1 hands its 3 OTC HELION to t2, leaving t2 the only positive holder.
    const sell = await http.post(
      "/api/orders",
      {
        challengeId: cid(),
        symbol: "HELION",
        side: "sell",
        type: "limit",
        quantity: 3,
        price: 250,
      },
      { token: ctx.t1.token },
    );
    await sleep(500);
    await http.post(
      "/api/orders",
      {
        challengeId: cid(),
        symbol: "HELION",
        side: "buy",
        type: "limit",
        quantity: 3,
        price: 250,
      },
      { token: ctx.t2.token },
    );
    await poll(
      async () => {
        const p = await http.get(`/api/portfolio/${cid()}`, { token: ctx.t2.token });
        return (p.positions.find((x) => x.symbol === "HELION")?.quantity ?? 0) >= 3 ? p : null;
      },
      { timeout: 15_000, label: "t2 long HELION" },
    );

    const opened = await http.post(
      `/api/admin/${cid()}/grant`,
      {
        symbol: "HELION",
        description: "E2E grant",
        prize: 500,
        durationSec: 10,
      },
      { token: ctx.admin.token },
    );
    t.ok(opened.grantId);
    const before = await http.get(`/api/portfolio/${cid()}`, { token: ctx.t2.token });
    await http.post(
      `/api/admin/${cid()}/grant/${opened.grantId}/award`,
      {},
      { token: ctx.admin.token },
    );
    const awarded = await poll(
      async () => {
        const v = await http.get(`/api/votes/${cid()}`, { token: ctx.t2.token });
        return v.grant?.status === "awarded" ? v : null;
      },
      { timeout: 15_000, label: "grant awarded" },
    );
    t.eq(awarded.grant.winnerId, ctx.t2.user.id);
    const after = await poll(
      async () => {
        const p = await http.get(`/api/portfolio/${cid()}`, { token: ctx.t2.token });
        return p.cash >= before.cash + 500 - 1 ? p : null;
      },
      { timeout: 12_000, label: "grant prize credited" },
    );
    t.ok(after.cash >= before.cash + 499);
  });

  await t.test("introduce ETF on a live directional challenge", async () => {
    const listed = await http.post(
      `/api/admin/${ctx.dir.id}/etfs`,
      {
        symbol: "BASK",
        name: "Basket",
        basket: [{ symbol: "E2EA", weight: 1 }],
      },
      { token: ctx.admin.token },
    );
    t.eq(listed.ok, true);
    t.eq(listed.symbol, "BASK");
  });
}
