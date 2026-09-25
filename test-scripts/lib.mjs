/**
 * Shared HTTP / WebSocket / assertion helpers for production feature tests.
 * No extra dependencies — Node 22+ (global fetch + WebSocket).
 */

export const API = process.env.API_URL ?? "https://quanta.devclub.in";
export const WS = process.env.WS_URL ?? "wss://quanta.devclub.in";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function nowId(prefix = "e2e") {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */
export class HttpError extends Error {
  constructor(status, body, path, method) {
    super(`${method} ${path} → ${status}${body?.error ? ` ${body.error}` : ""}`);
    this.status = status;
    this.body = body;
    this.path = path;
    this.method = method;
  }
}

export function createClient(base = API) {
  return {
    async request(method, path, { token, body, query } = {}) {
      const url = new URL(path.startsWith("http") ? path : `${base}${path}`);
      if (query) {
        for (const [k, v] of Object.entries(query)) {
          if (v != null) url.searchParams.set(k, String(v));
        }
      }
      const headers = {};
      if (body != null) headers["content-type"] = "application/json";
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      return { status: res.status, headers: res.headers, body: parsed, ok: res.ok };
    },
    async json(method, path, opts = {}) {
      const r = await this.request(method, path, opts);
      if (!r.ok) throw new HttpError(r.status, r.body, path, method);
      return r.body;
    },
    get: (path, opts) => createClient(base).json("GET", path, opts),
    post: (path, body, opts = {}) =>
      createClient(base).json("POST", path, { ...opts, body }),
    patch: (path, body, opts = {}) =>
      createClient(base).json("PATCH", path, { ...opts, body }),
    del: (path, opts) => createClient(base).json("DELETE", path, opts),
  };
}

export const http = createClient();

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */
export async function login(username, password) {
  const body = await http.post("/api/auth/login", { username, password });
  if (!body?.token || !body?.user) {
    throw new Error(`login ${username}: unexpected body`);
  }
  return body;
}

export async function register(input) {
  return http.post("/api/auth/register", input);
}

/* ------------------------------------------------------------------ *
 * Polling
 * ------------------------------------------------------------------ */
/**
 * Wait until the engine is actually matching (a canary bid appears on the book).
 * `_active/list` is set by the API at go-live, before the runner starts, so it
 * is not a readiness signal. Commands sent before XREAD begins are dropped
 * (`lastId = "$"`); this retries a fresh canary every second.
 */
export async function awaitEngine(_adminToken, traderToken, challengeId, symbol) {
  const acks = [];
  try {
    await poll(
      async () => {
        const ack = await http.post(
          "/api/orders",
          {
            challengeId,
            symbol,
            side: "buy",
            type: "limit",
            quantity: 1,
            price: 0.01,
          },
          { token: traderToken },
        );
        acks.push(ack.orderId);
        await sleep(900);
        const book = await http.get(`/api/market/${challengeId}/${symbol}/orderbook`);
        return (book.bids ?? []).some((l) => l.price === 0.01) ? book : null;
      },
      { timeout: 25_000, interval: 100, label: "engine processing canary order" },
    );
  } finally {
    for (const id of acks) {
      await http.del(`/api/orders/${id}`, { token: traderToken }).catch(() => {});
    }
  }
}

/** Wait until the caller's order reaches one of `statuses`. */
export async function waitStatus(token, challengeId, orderId, statuses, label = "order status") {
  return poll(
    async () => {
      const rows = await http.get("/api/orders", { token, query: { challengeId } });
      const o = rows.find((r) => r.id === orderId);
      return o && statuses.includes(o.status) ? o : null;
    },
    { timeout: 20_000, interval: 400, label },
  );
}

export async function poll(fn, { timeout = 15_000, interval = 400, label = "condition" } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label} (${timeout}ms)`);
}

/* ------------------------------------------------------------------ *
 * WebSocket
 * ------------------------------------------------------------------ */
export function openWs(token) {
  const url = token
    ? `${WS}/ws?token=${encodeURIComponent(token)}`
    : `${WS}/ws`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    const waiters = [];
    let opened = false;

    const client = {
      ws,
      messages,
      send(msg) {
        ws.send(JSON.stringify(msg));
      },
      subscribe(challengeId) {
        client.send({ type: "subscribe", challengeId });
      },
      ping() {
        client.send({ type: "ping" });
      },
      waitFor(pred, timeout = 10_000, label = "ws message") {
        for (const m of messages) {
          if (pred(m)) return Promise.resolve(m);
        }
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const i = waiters.indexOf(entry);
            if (i >= 0) waiters.splice(i, 1);
            rej(new Error(`ws timeout: ${label}`));
          }, timeout);
          const entry = { pred, res, timer };
          waiters.push(entry);
        });
      },
      ofType(type, timeout = 10_000) {
        return client.waitFor((m) => m.type === type, timeout, `type=${type}`);
      },
      close() {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
    };

    ws.addEventListener("open", () => {
      opened = true;
      resolve(client);
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) {
          clearTimeout(waiters[i].timer);
          waiters[i].res(msg);
          waiters.splice(i, 1);
        }
      }
    });
    ws.addEventListener("error", (err) => {
      if (!opened) reject(err);
    });
    ws.addEventListener("close", () => {
      if (!opened) reject(new Error("ws closed before open"));
    });
  });
}

/* ------------------------------------------------------------------ *
 * Challenge factories (isolated — never mutate existing live events)
 * ------------------------------------------------------------------ */
export function directionalConfig(overrides = {}) {
  return {
    symbols: [
      { symbol: "E2EA", name: "E2E Alpha", initialPrice: 100, volatility: 0.1, tickSize: 0.01 },
      { symbol: "E2EB", name: "E2E Beta", initialPrice: 50, volatility: 0.1, tickSize: 0.01 },
    ],
    startingCash: 0,
    minPosition: -50,
    maxPosition: 50,
    maxOrderQuantity: 20,
    maxOrdersPerSecond: 20,
    maxVolumePerMinute: 2000,
    allowMargin: true,
    autonomousPrice: false,
    ...overrides,
  };
}

export function mmConfig(overrides = {}) {
  return {
    symbols: [
      { symbol: "MMX", name: "MM Probe", initialPrice: 75, volatility: 0.2, tickSize: 0.01 },
    ],
    startingCash: 0,
    minPosition: -100,
    maxPosition: 100,
    maxOrderQuantity: 40,
    maxOrdersPerSecond: 10,
    maxVolumePerMinute: 1000,
    allowMargin: true,
    autonomousPrice: false,
    ...overrides,
  };
}

export function edenConfig(overrides = {}) {
  return {
    symbols: [
      { symbol: "AERIUM", name: "Aerium", initialPrice: 1000, volatility: 0.2, tickSize: 0.5 },
      { symbol: "HELION", name: "Helion", initialPrice: 250, volatility: 0.2, tickSize: 0.1 },
    ],
    startingCash: 10_000,
    minPosition: -100,
    maxPosition: 100,
    maxOrderQuantity: 20,
    maxOrdersPerSecond: 10,
    maxVolumePerMinute: 1000,
    allowMargin: true,
    autonomousPrice: false,
    eden: {
      rules: {
        enabled: true,
        costOfCarryPerUnitPerMinute: 1,
        loanRepayMultiplier: 2,
        marginCallThreshold: 0,
        forcedLiquidation: false,
        positionCap: 100,
      },
      bots: {
        hftMarketMakers: 0,
        momentumTraders: 0,
        vegaSnipers: 0,
        parityArbers: 0,
        spread: 1,
        quoteSize: 5,
        intensity: 0,
      },
      options: {
        enabled: true,
        underlyings: ["AERIUM"],
        cycleMinutes: 5,
        exerciseWindowSec: 15,
        autoCycle: false,
        strikeSteps: 1,
      },
      bonds: [
        {
          id: "standard",
          name: "E2E Treasury",
          price: 200,
          faceValue: 250,
          couponPer5Min: 5,
          maxPerUser: 2,
        },
      ],
      etfs: [
        {
          symbol: "ORB",
          name: "Orbital",
          basket: [
            { symbol: "AERIUM", weight: 1 },
            { symbol: "HELION", weight: 2 },
          ],
        },
      ],
      auctionDurationSec: 8,
      auctionWinnerFraction: 0.5,
      premiumLeadSec: 8,
      premiumAccessMinutes: 5,
    },
    ...overrides,
  };
}

/** Mirrors the admin form's "New Eden playbook preset" (scripted 130-minute event). */
export function scriptedEdenConfig() {
  return {
    symbols: [
      { symbol: "AERIUM", name: "Aerium", initialPrice: 1000, volatility: 0, tickSize: 0.5 },
    ],
    startingCash: 10_000,
    minPosition: -100,
    maxPosition: 100,
    maxOrderQuantity: 50,
    maxOpenOrders: 25,
    maxOrdersPerSecond: 8,
    maxVolumePerMinute: 1000,
    allowMargin: true,
    autonomousPrice: true,
    bots: { marketMakers: 0, noiseTraders: 0, spread: 0.5, quoteSize: 5, intensity: 0.5 },
    eden: {
      eventScript: true,
      rules: {
        enabled: true,
        costOfCarryPerUnitPerMinute: 1,
        loanRepayMultiplier: 2,
        marginCallThreshold: 0,
        forcedLiquidation: true,
        positionCap: 100,
      },
      bots: {
        hftMarketMakers: 2,
        momentumTraders: 4,
        vegaSnipers: 1,
        parityArbers: 1,
        spread: 1,
        quoteSize: 10,
        intensity: 0.5,
      },
      options: {
        enabled: false,
        underlyings: ["AERIUM"],
        cycleMinutes: 5,
        exerciseWindowSec: 15,
        autoCycle: true,
        strikeSteps: 1,
      },
      bonds: [],
      etfs: [],
      auctionDurationSec: 30,
      auctionWinnerFraction: 0.3,
      premiumLeadSec: 10,
      premiumAccessMinutes: 15,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Test harness
 * ------------------------------------------------------------------ */
export function createHarness() {
  const results = [];
  let currentSuite = "";

  function record(name, status, detail, ms) {
    results.push({ suite: currentSuite, name, status, detail, ms });
    const icon = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
    const extra = detail ? ` — ${detail}` : "";
    console.log(`  [${icon}] ${name}${extra}`);
  }

  const t = {
    suite(name) {
      currentSuite = name;
      console.log(`\n▸ ${name}`);
    },
    async test(name, fn) {
      const start = Date.now();
      try {
        await fn();
        record(name, "pass", "", Date.now() - start);
      } catch (err) {
        record(name, "fail", err.message ?? String(err), Date.now() - start);
      }
    },
    skip(name, reason = "") {
      record(name, "skip", reason, 0);
    },
    eq(actual, expected, msg) {
      if (!Object.is(actual, expected) && JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          msg ??
            `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
      }
    },
    neq(actual, expected, msg) {
      if (Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected)) {
        throw new Error(msg ?? `expected values to differ, both ${JSON.stringify(actual)}`);
      }
    },
    ok(cond, msg) {
      if (!cond) throw new Error(msg ?? "expected truthy");
    },
    includes(arrOrStr, value, msg) {
      const ok =
        typeof arrOrStr === "string"
          ? arrOrStr.includes(value)
          : Array.isArray(arrOrStr) && arrOrStr.includes(value);
      if (!ok) throw new Error(msg ?? `expected to include ${JSON.stringify(value)}`);
    },
    approx(actual, expected, eps = 1e-6, msg) {
      if (typeof actual !== "number" || Math.abs(actual - expected) > eps) {
        throw new Error(msg ?? `expected ≈ ${expected} (±${eps}), got ${actual}`);
      }
    },
    status(errOrRes, expected, msg) {
      const got = errOrRes instanceof HttpError ? errOrRes.status : errOrRes.status;
      if (got !== expected) {
        throw new Error(msg ?? `expected HTTP ${expected}, got ${got}`);
      }
    },
    async throws(fn, { status, error } = {}) {
      try {
        await fn();
      } catch (err) {
        if (status != null && !(err instanceof HttpError && err.status === status)) {
          throw new Error(
            `expected HTTP ${status}, got ${err instanceof HttpError ? err.status : err}`,
          );
        }
        if (error != null) {
          const code = err instanceof HttpError ? err.body?.error : undefined;
          if (code !== error) {
            throw new Error(`expected error "${error}", got ${JSON.stringify(err.body ?? err.message)}`);
          }
        }
        return err;
      }
      throw new Error("expected function to throw");
    },
    results,
    report() {
      const pass = results.filter((r) => r.status === "pass").length;
      const fail = results.filter((r) => r.status === "fail").length;
      const skip = results.filter((r) => r.status === "skip").length;
      console.log("\n════════════════════════════════════════");
      console.log(`  ${pass} passed  ${fail} failed  ${skip} skipped  (${results.length} total)`);
      if (fail) {
        console.log("\nFailures:");
        for (const r of results.filter((x) => x.status === "fail")) {
          console.log(`  • [${r.suite}] ${r.name}`);
          console.log(`      ${r.detail}`);
        }
      }
      console.log("════════════════════════════════════════\n");
      return { pass, fail, skip, results };
    },
  };

  return t;
}
