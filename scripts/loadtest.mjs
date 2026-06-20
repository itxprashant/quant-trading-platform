#!/usr/bin/env node
/**
 * Load-test harness for the Quanta platform.
 *
 * Spins up many concurrent WebSocket clients (to exercise the gateway fan-out)
 * plus a pool of order-placing clients (to exercise API + matching engine), and
 * reports throughput, latency percentiles, and error rates.
 *
 * Requires Node 22+ (uses global WebSocket + fetch). No dependencies.
 *
 * Env:
 *   API_URL        default http://localhost:8000
 *   WS_URL         default ws://localhost:8080
 *   CHALLENGE_ID   required (a LIVE challenge id)
 *   CLIENTS        WS connections to open       (default 200)
 *   ORDER_CLIENTS  order-placing users          (default 8)
 *   DURATION       seconds to run               (default 20)
 *   ORDER_RATE     orders/sec per order client  (default 5)
 *   USERS          comma list of usernames      (default trader1..trader8)
 *   PASSWORD       shared password              (default trader1234)
 *   CONNECT_BATCH  WS connects per 100ms        (default 50)
 *
 * Example:
 *   CHALLENGE_ID=<id> CLIENTS=1000 DURATION=30 node scripts/loadtest.mjs
 */

const API = process.env.API_URL ?? "http://localhost:8000";
const WS = process.env.WS_URL ?? "ws://localhost:8080";
const CHALLENGE_ID = process.env.CHALLENGE_ID;
const CLIENTS = Number(process.env.CLIENTS ?? 200);
const ORDER_CLIENTS = Number(process.env.ORDER_CLIENTS ?? 8);
const DURATION = Number(process.env.DURATION ?? 20);
const ORDER_RATE = Number(process.env.ORDER_RATE ?? 5);
const PASSWORD = process.env.PASSWORD ?? "trader1234";
const CONNECT_BATCH = Number(process.env.CONNECT_BATCH ?? 50);
const USERS = (
  process.env.USERS ??
  Array.from({ length: 8 }, (_, i) => `trader${i + 1}`).join(",")
).split(",");

if (!CHALLENGE_ID) {
  console.error("CHALLENGE_ID is required (must be a LIVE challenge).");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;

async function login(username) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${username} failed: ${res.status}`);
  return (await res.json()).token;
}

async function getSymbols() {
  const res = await fetch(`${API}/api/market/${CHALLENGE_ID}/symbols`);
  if (!res.ok) throw new Error(`symbols fetch failed: ${res.status}`);
  return res.json();
}

const stats = {
  wsOpen: 0,
  wsFailed: 0,
  wsClosed: 0,
  msgs: 0,
  firstMsgLatency: [],
  orders: 0,
  ordersOk: 0,
  orders429: 0,
  ordersErr: 0,
  orderLatency: [],
};

async function main() {
  console.log(
    `Load test → API=${API} WS=${WS}\n  challenge=${CHALLENGE_ID} clients=${CLIENTS} orderClients=${ORDER_CLIENTS} duration=${DURATION}s`,
  );

  const tokens = [];
  for (const u of USERS) {
    try {
      tokens.push(await login(u));
    } catch (e) {
      console.warn(`  ! ${e.message}`);
    }
  }
  if (tokens.length === 0) throw new Error("no users could log in");
  const symbols = await getSymbols();
  console.log(`  logged in ${tokens.length} users; ${symbols.length} symbols`);

  const sockets = [];
  let connected = 0;
  const tConnectStart = Date.now();

  for (let i = 0; i < CLIENTS; i++) {
    const token = tokens[i % tokens.length];
    const openedAt = Date.now();
    let gotFirst = false;
    try {
      const ws = new WebSocket(`${WS}/ws?token=${token}`);
      ws.onopen = () => {
        stats.wsOpen++;
        connected++;
        ws.send(JSON.stringify({ type: "subscribe", challengeId: CHALLENGE_ID }));
      };
      ws.onmessage = () => {
        stats.msgs++;
        if (!gotFirst) {
          gotFirst = true;
          stats.firstMsgLatency.push(Date.now() - openedAt);
        }
      };
      ws.onclose = () => stats.wsClosed++;
      ws.onerror = () => stats.wsFailed++;
      sockets.push(ws);
    } catch {
      stats.wsFailed++;
    }
    if ((i + 1) % CONNECT_BATCH === 0) await sleep(100);
  }

  // Wait briefly for connections to settle.
  await sleep(1500);
  console.log(
    `  WS connected=${connected}/${CLIENTS} in ${((Date.now() - tConnectStart) / 1000).toFixed(1)}s`,
  );

  // Order load.
  const endAt = Date.now() + DURATION * 1000;
  const orderLoops = [];
  for (let i = 0; i < ORDER_CLIENTS; i++) {
    const token = tokens[i % tokens.length];
    orderLoops.push(orderLoop(token, symbols, endAt));
  }

  // Progress ticker.
  const ticker = setInterval(() => {
    console.log(
      `  …msgs=${stats.msgs} orders=${stats.orders} ok=${stats.ordersOk} 429=${stats.orders429} err=${stats.ordersErr} conns=${connected}`,
    );
  }, 5000);

  await Promise.all(orderLoops);
  clearInterval(ticker);

  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* noop */
    }
  }
  await sleep(500);

  const fml = stats.firstMsgLatency.sort((a, b) => a - b);
  const ol = stats.orderLatency.sort((a, b) => a - b);
  console.log("\n=== Results ===");
  console.log(`WS connections opened : ${stats.wsOpen} (failed ${stats.wsFailed})`);
  console.log(`Messages received     : ${stats.msgs} (${(stats.msgs / DURATION).toFixed(0)}/s)`);
  console.log(
    `First-msg latency ms  : p50=${pct(fml, 50)} p95=${pct(fml, 95)} p99=${pct(fml, 99)}`,
  );
  console.log(`Orders sent           : ${stats.orders}`);
  console.log(
    `  ok=${stats.ordersOk}  rate-limited(429)=${stats.orders429}  errors=${stats.ordersErr}`,
  );
  console.log(
    `Order latency ms      : p50=${pct(ol, 50)} p95=${pct(ol, 95)} p99=${pct(ol, 99)}`,
  );
  process.exit(0);
}

async function orderLoop(token, symbols, endAt) {
  const intervalMs = 1000 / ORDER_RATE;
  while (Date.now() < endAt) {
    const sym = symbols[Math.floor(Math.random() * symbols.length)];
    const side = Math.random() > 0.5 ? "buy" : "sell";
    const drift = (Math.random() - 0.5) * 2;
    const price = Math.max(0.01, Number((sym.price + drift).toFixed(2)));
    const body = {
      challengeId: CHALLENGE_ID,
      symbol: sym.symbol,
      side,
      type: "limit",
      quantity: 1 + Math.floor(Math.random() * 5),
      price,
    };
    const t0 = Date.now();
    try {
      const res = await fetch(`${API}/api/orders`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      stats.orders++;
      stats.orderLatency.push(Date.now() - t0);
      if (res.status === 429) stats.orders429++;
      else if (res.ok) stats.ordersOk++;
      else stats.ordersErr++;
    } catch {
      stats.orders++;
      stats.ordersErr++;
    }
    await sleep(intervalMs);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
