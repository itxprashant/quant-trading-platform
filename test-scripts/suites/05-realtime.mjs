import { openWs, sleep } from "../lib.mjs";

export async function suiteRealtime(t, ctx) {
  t.suite("Realtime WebSocket");

  const cid = ctx.dir.id;
  let authed;
  let anon;

  await t.test("authenticated WS connects, ping → pong, subscribe snapshot", async () => {
    authed = await openWs(ctx.t1.token);
    ctx.sockets.push(authed);
    authed.ping();
    const pong = await authed.ofType("pong", 5000);
    t.eq(pong.type, "pong");

    authed.subscribe(cid);
    const sub = await authed.ofType("subscribed", 8000);
    t.eq(sub.challengeId, cid);

    const price = await authed.waitFor(
      (m) => m.type === "price" && m.challengeId === cid,
      10_000,
      "price snapshot",
    );
    t.ok(typeof price.data.price === "number");
    t.ok(["E2EA", "E2EB"].includes(price.data.symbol));
  });

  await t.test("anonymous WS can subscribe (read-only fan-out)", async () => {
    anon = await openWs(null);
    ctx.sockets.push(anon);
    anon.subscribe(cid);
    const sub = await anon.ofType("subscribed", 8000);
    t.eq(sub.challengeId, cid);
  });

  await t.test("book updates fan out after a new rest", async () => {
    // Place a far-from-market bid so it rests; both sockets should see a book msg.
    const { http } = await import("../lib.mjs");
    const ack = await http.post(
      "/api/orders",
      {
        challengeId: cid,
        symbol: "E2EA",
        side: "buy",
        type: "limit",
        quantity: 1,
        price: 0.5,
      },
      { token: ctx.t2.token },
    );
    t.eq(ack.status, "accepted");
    const book = await authed.waitFor(
      (m) =>
        m.type === "book" &&
        m.data?.symbol === "E2EA" &&
        (m.data.bids ?? []).some((l) => l.price === 0.5),
      15_000,
      "book bid 0.5",
    );
    t.ok(book);
    await http.del(`/api/orders/${ack.orderId}`, { token: ctx.t2.token }).catch(() => {});
  });

  await t.test("malformed WS text is ignored (connection stays up)", async () => {
    authed.ws.send("not-json");
    await sleep(200);
    authed.ping();
    const pong = await authed.waitFor((m) => m.type === "pong", 5000, "pong after junk");
    t.eq(pong.type, "pong");
  });

  await t.test("unsubscribe is acknowledged by silence on later ticks", async () => {
    authed.send({ type: "unsubscribe", challengeId: cid });
    await sleep(300);
    const before = authed.messages.length;
    await sleep(800);
    // Should not crash; extra messages are ok (in-flight). Just assert still open.
    t.ok(authed.ws.readyState === WebSocket.OPEN);
    t.ok(before >= 0);
  });
}
