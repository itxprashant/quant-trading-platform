import { http, nowId, poll, scriptedEdenConfig, sleep } from "../lib.mjs";

const MINUTE5_HEADLINE = "Refinery strike in Sector 4 cuts Aerium output by 12%.";

/**
 * Scripted New Eden runs on the real game clock (60 s per game minute in
 * production), so it starts before the other suites and a background watcher
 * catches the timed actions: minute 0 open, the 2.5 Deal Desk offer (15 s
 * reply window) and the minute 5 headline. `suiteScriptedEden` asserts last.
 */
export async function startScriptedEden(ctx) {
  const obs = { errors: [] };
  ctx.scriptObs = obs;
  try {
    const created = await http.post(
      "/api/challenges",
      {
        name: `E2E Script ${nowId("")}`,
        description: "Isolated scripted New Eden e2e — ended after the run.",
        type: "new_eden",
        config: scriptedEdenConfig(),
        scoring: { kind: "directional", pnlWeight: 1 },
      },
      { token: ctx.admin.token },
    );
    ctx.createdIds.push(created.id);
    obs.id = created.id;
    await http.post(
      `/api/challenges/${created.id}/status`,
      { status: "scheduled" },
      { token: ctx.admin.token },
    );
    // OTC offers go to traders enrolled by the scheduled time.
    for (const tr of [ctx.t1, ctx.t2, ctx.t3]) {
      await http.post(`/api/challenges/${created.id}/join`, {}, { token: tr.token });
    }
    obs.liveAt = Date.now();
    await http.post(
      `/api/challenges/${created.id}/status`,
      { status: "live" },
      { token: ctx.admin.token },
    );
    console.log(`Scripted New Eden ${created.id} is live; watcher running in background.`);
    ctx.scriptWatch = watch(ctx, obs).catch((err) => obs.errors.push(`watcher: ${err.message}`));
  } catch (err) {
    obs.errors.push(`start: ${err.message}`);
    ctx.scriptWatch = Promise.resolve();
  }
}

async function note(obs, key, fn) {
  try {
    obs[key] = await fn();
  } catch (err) {
    obs[key] = { error: err.message, status: err.status, body: err.body };
  }
}

async function sleepUntil(ts) {
  const ms = ts - Date.now();
  if (ms > 0) await sleep(ms);
}

async function watch(ctx, obs) {
  const cid = obs.id;
  const ch = await poll(
    async () => {
      const c = await http.get(`/api/challenges/${cid}`, { token: ctx.admin.token });
      return c.startsAt && c.endsAt ? c : null;
    },
    { timeout: 30_000, label: "runner stamps startsAt/endsAt" },
  );
  obs.startsAt = Date.parse(ch.startsAt);
  obs.endsAt = Date.parse(ch.endsAt);
  const sec = (obs.endsAt - obs.startsAt) / 130 / 60;
  obs.secondMs = sec;
  const at = (gameSecond) => obs.startsAt + gameSecond * sec;

  await note(obs, "symbolsAtOpen", async () =>
    (await http.get(`/api/market/${cid}/symbols`)).map((s) => s.symbol),
  );
  await note(obs, "portfolioAtOpen", () =>
    http.get(`/api/portfolio/${cid}`, { token: ctx.t1.token }),
  );
  await note(obs, "bondsAtOpen", () =>
    http.get(`/api/markets/${cid}/bonds`, { token: ctx.t1.token }),
  );
  await note(obs, "botBook", () =>
    poll(
      async () => {
        const b = await http.get(`/api/market/${cid}/AERIUM/orderbook`);
        return b.bids?.length && b.asks?.length ? b : null;
      },
      { timeout: 30_000, interval: 1000, label: "bot quotes on AERIUM" },
    ),
  );
  await note(obs, "patchClock", async () => {
    const r = await http.request("PATCH", `/api/challenges/${cid}`, {
      token: ctx.admin.token,
      body: { endsAt: new Date(obs.endsAt + 3_600_000).toISOString() },
    });
    return { status: r.status, error: r.body?.error };
  });
  await note(obs, "patchConfig", async () => {
    const config = scriptedEdenConfig();
    config.startingCash = 999_999;
    const r = await http.request("PATCH", `/api/challenges/${cid}`, {
      token: ctx.admin.token,
      body: { config },
    });
    return { status: r.status, error: r.body?.error };
  });

  // Minute 2.5: one private offer per enrolled trader, 15 game seconds to reply.
  const traders = { t1: ctx.t1, t2: ctx.t2, t3: ctx.t3 };
  await sleepUntil(at(150) - 3_000);
  obs.otc = {};
  await poll(
    async () => {
      for (const [k, tr] of Object.entries(traders)) {
        if (obs.otc[k]) continue;
        const rows = await http.get(`/api/otc/${cid}`, { token: tr.token });
        const offer = rows.find((o) => o.status === "pending");
        if (offer) obs.otc[k] = { ...offer, seenAt: Date.now() };
      }
      return Object.keys(obs.otc).length === 3 ? true : null;
    },
    { timeout: 20_000, interval: 300, label: "minute 2.5 OTC offers" },
  ).catch((err) => obs.errors.push(err.message));

  if (obs.otc.t1) {
    await note(obs, "t1Reject", () =>
      http.post(`/api/otc/${obs.otc.t1.id}/respond`, { action: "reject" }, { token: ctx.t1.token }),
    );
  }
  if (obs.otc.t2) {
    await note(obs, "t2Accept", () =>
      http.post(`/api/otc/${obs.otc.t2.id}/respond`, { action: "accept" }, { token: ctx.t2.token }),
    );
    obs.t2Samples = [];
    // Long enough to see a margin call dump the block after settlement.
    const until = Date.now() + 25_000;
    while (Date.now() < until) {
      try {
        const p = await http.get(`/api/portfolio/${cid}`, { token: ctx.t2.token });
        obs.t2Samples.push({
          ts: Date.now(),
          cash: p.cash,
          aerium: p.positions.find((x) => x.symbol === "AERIUM")?.quantity ?? 0,
        });
      } catch (err) {
        obs.t2Samples.push({ ts: Date.now(), error: err.message });
      }
      await sleep(1000);
    }
    await note(obs, "t2After", () => http.get(`/api/portfolio/${cid}`, { token: ctx.t2.token }));
  }
  if (obs.otc.t3) {
    await sleepUntil(Date.parse(obs.otc.t3.expiresAt) + 1_500);
    await note(obs, "t3AfterExpiry", async () => {
      const rows = await http.get(`/api/otc/${cid}`, { token: ctx.t3.token });
      return rows.some((o) => o.id === obs.otc.t3.id);
    });
  }

  // Minute 4:50 premium release must not reach traders without premium access.
  await sleepUntil(at(300) - 4 * sec);
  await note(obs, "newsBefore5", async () => {
    const r = await http.get(`/api/challenges/${cid}/news`, { token: ctx.t1.token });
    return r.items.map((i) => i.message);
  });
  await sleepUntil(at(300));
  await note(obs, "news5", () =>
    poll(
      async () => {
        const r = await http.get(`/api/challenges/${cid}/news`, { token: ctx.t1.token });
        return r.items.find((i) => i.message === MINUTE5_HEADLINE) ?? null;
      },
      { timeout: 20_000, interval: 500, label: "minute 5 headline" },
    ),
  );
  await note(obs, "fvAfter5", () =>
    poll(
      async () => {
        const m = await http.get(`/api/admin/${cid}/fair-value`, { token: ctx.admin.token });
        return m.AERIUM >= 1049 ? m : null;
      },
      { timeout: 15_000, label: "AERIUM FV +50" },
    ),
  );
}

export async function suiteScriptedEden(t, ctx) {
  t.suite("Scripted New Eden timeline");
  const obs = ctx.scriptObs;
  if (!obs?.id) {
    t.skip("scripted timeline", obs?.errors?.join("; ") || "not started");
    return;
  }
  const remaining = obs.startsAt ? obs.startsAt + 300 * obs.secondMs + 20_000 - Date.now() : 0;
  if (remaining > 0) {
    console.log(`  … waiting ${Math.ceil(remaining / 1000)}s for game minute 5`);
  }
  await ctx.scriptWatch;
  const cid = obs.id;
  const failed = (v) => v && typeof v === "object" && "error" in v && !Array.isArray(v);

  await t.test("going live stamps startsAt and a 130-game-minute endsAt", async () => {
    t.ok(obs.startsAt, `runner never stamped the clock: ${obs.errors.join("; ")}`);
    t.ok(Math.abs(obs.startsAt - obs.liveAt) < 15_000, "startsAt should be the go-live time");
    t.ok(obs.secondMs >= 1 && obs.secondMs <= 1000, `odd game second ${obs.secondMs}ms`);
  });

  await t.test("minute 0 opens AERIUM only, $10,000 cash, no bonds yet", async () => {
    t.ok(!failed(obs.symbolsAtOpen), JSON.stringify(obs.symbolsAtOpen));
    t.eq(obs.symbolsAtOpen, ["AERIUM"]);
    t.approx(obs.portfolioAtOpen.cash, 10_000, 1e-6);
    t.eq(obs.bondsAtOpen.templates?.length ?? 0, 0, "bonds list before minute 10");
  });

  await t.test("HFT bots quote a two-sided AERIUM book", async () => {
    t.ok(!failed(obs.botBook), obs.botBook?.error);
  });

  await t.test("clock and config are immutable once started", async () => {
    t.eq(obs.patchClock.status, 409);
    t.eq(obs.patchClock.error, "event_clock_immutable");
    t.eq(obs.patchConfig.status, 409);
    t.eq(obs.patchConfig.error, "started_event_config_immutable");
  });

  await t.test("minute 2.5 Deal Desk offer reaches every enrolled trader", async () => {
    const got = Object.keys(obs.otc ?? {});
    t.eq(got.sort(), ["t1", "t2", "t3"], `offers seen for ${got.join(",") || "nobody"}`);
    for (const offer of Object.values(obs.otc)) {
      t.eq(offer.legs.length, 1);
      t.eq(offer.legs[0].symbol, "AERIUM");
      t.eq(offer.legs[0].quantity, 5);
      t.approx(offer.legs[0].price, 1000, 25, `offer price ${offer.legs[0].price} should be ~FV`);
      const window = (Date.parse(offer.expiresAt) - (obs.startsAt + 150 * obs.secondMs)) / obs.secondMs;
      t.approx(window, 40, 1.5, `reply window ${window} game seconds`);
    }
  });

  await t.test("rejecting the scripted offer returns rejected", async () => {
    t.ok(!failed(obs.t1Reject), JSON.stringify(obs.t1Reject));
    t.eq(obs.t1Reject.result, "rejected");
  });

  await t.test("accepting binds and the engine settles 5 AERIUM for ~$5,000 without a margin call", async () => {
    t.ok(!failed(obs.t2Accept), JSON.stringify(obs.t2Accept));
    t.eq(obs.t2Accept.result, "accepted");
    const samples = (obs.t2Samples ?? []).filter((s) => !s.error);
    // Settlement is off-book but still counts toward the trader's volume.
    const volume = obs.t2After?.metrics?.volume ?? 0;
    const held = samples.some((s) => s.aerium === 5 || s.cash < 6_000);
    t.ok(
      held || volume >= 5,
      `no settlement observed (volume ${volume}): ${JSON.stringify(samples.slice(-3))}`,
    );
    const last = samples.at(-1);
    t.ok(
      volume < 10 && !(held && last && last.aerium < 5),
      `block was liquidated after settlement: cash ${obs.t2After?.cash}, trades ${obs.t2After?.metrics?.trades}, volume ${volume}, realized ${obs.t2After?.metrics?.realizedPnl}`,
    );
  });

  await t.test("an ignored offer drops out of the list after expiry", async () => {
    t.eq(obs.t3AfterExpiry, false);
  });

  await t.test("premium release at 4:50 does not reach non-premium traders", async () => {
    t.ok(!failed(obs.newsBefore5), JSON.stringify(obs.newsBefore5));
    t.ok(!obs.newsBefore5.includes(MINUTE5_HEADLINE), "minute 5 headline leaked early");
  });

  await t.test("minute 5 public headline publishes without its signal/noise label", async () => {
    t.ok(!failed(obs.news5), obs.news5?.error);
    t.ok(!("kind" in obs.news5) || obs.news5.kind == null, "kind leaked to traders");
  });

  await t.test("minute 5 signal moves AERIUM fair value to 1050", async () => {
    t.ok(!failed(obs.fvAfter5), obs.fvAfter5?.error);
    t.approx(obs.fvAfter5.AERIUM, 1050, 1);
  });

  await t.test("ending early publishes a stable final result that matches portfolios", async () => {
    await http.post(`/api/challenges/${cid}/status`, { status: "ended" }, { token: ctx.admin.token });
    // Reconcile claims the ended event and finish() persists finalResults.
    await sleep(10_000);
    const first = await http.get(`/api/leaderboard/${cid}`);
    await sleep(5_000);
    const second = await http.get(`/api/leaderboard/${cid}`);
    t.ok(Array.isArray(first) && first.length >= 3, `final board: ${JSON.stringify(first)}`);
    t.eq(second, first, "final leaderboard kept changing after the event ended");
    for (const tr of [ctx.t1, ctx.t2, ctx.t3]) {
      const row = first.find((e) => e.userId === tr.user.id);
      t.ok(row, `${tr.user.username} missing from final results`);
      const p = await http.get(`/api/portfolio/${cid}`, { token: tr.token });
      t.approx(p.pnl, row.pnl, 0.01, `${tr.user.username} portfolio pnl ${p.pnl} vs final ${row.pnl}`);
    }
  });
}
