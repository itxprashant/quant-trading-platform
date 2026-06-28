import { createServer } from "node:http";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { WebSocket, WebSocketServer } from "ws";
import {
  createRedis,
  getBookSnapshot,
  getFairValues,
  getListedSymbols,
  getNewsFeed,
  getOptionContracts,
  getPrice,
} from "@qtp/bus";
import { challenges, getDb } from "@qtp/db";
import type {
  BroadcastEnvelope,
  ClientMessage,
  ServerMessage,
} from "@qtp/shared";
import { env } from "./env.js";
import { Fanout } from "./fanout.js";

interface Conn {
  ws: WebSocket;
  userId: string | null;
  subs: Set<string>;
  isAlive: boolean;
}

const db = getDb();
const redis = createRedis(env.redisUrl);

/** challengeId -> set of connections subscribed to it. */
const registry = new Map<string, Set<Conn>>();
/** Cache of challenge symbol lists for snapshot delivery. */
const symbolCache = new Map<string, string[]>();

const fanout = new Fanout(env.redisUrl, dispatch);

// Lightweight metrics counters.
const metrics = { messagesSent: 0, messagesDropped: 0, connectionsTotal: 0 };

function dispatch(challengeId: string, envelopes: BroadcastEnvelope[]): void {
  const conns = registry.get(challengeId);
  if (!conns || conns.size === 0) return;
  for (const env_ of envelopes) {
    if (env_.target === "all") {
      for (const conn of conns) send(conn, env_.msg);
    } else {
      for (const conn of conns) {
        if (conn.userId === env_.target) send(conn, env_.msg);
      }
    }
  }
}

function send(conn: Conn, msg: ServerMessage): void {
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  if (conn.ws.bufferedAmount > env.maxBufferedBytes) {
    // Slow consumer: drop the connection rather than buffer unbounded.
    metrics.messagesDropped += 1;
    conn.ws.terminate();
    return;
  }
  conn.ws.send(JSON.stringify(msg));
  metrics.messagesSent += 1;
}

async function symbolsFor(challengeId: string): Promise<string[]> {
  const cached = symbolCache.get(challengeId);
  if (cached) return cached;
  const row = await db.query.challenges.findFirst({
    where: eq(challenges.id, challengeId),
  });
  const symbols = row?.config.symbols.map((s) => s.symbol) ?? [];
  symbolCache.set(challengeId, symbols);
  return symbols;
}

async function sendSnapshot(conn: Conn, challengeId: string): Promise<void> {
  const symbols = await symbolsFor(challengeId);
  // Include dynamically-listed instruments (options / ETFs) so late joiners
  // see their books and marks too.
  const listed = await getListedSymbols(redis, challengeId);
  for (const symbol of [...symbols, ...listed]) {
    const price = await getPrice(redis, challengeId, symbol);
    if (price != null) {
      send(conn, {
        type: "price",
        challengeId,
        data: { symbol, price, change: 0, timestamp: Date.now() },
      });
    }
    const book = await getBookSnapshot(redis, challengeId, symbol);
    if (book) send(conn, { type: "book", challengeId, data: book });
  }
  // New Eden: deliver the current option contracts to late joiners.
  const contracts = await getOptionContracts(redis, challengeId);
  if (contracts.length > 0) {
    send(conn, {
      type: "option_cycle",
      challengeId,
      data: { contracts, ts: Date.now() },
    });
  }
  const news = await getNewsFeed(redis, challengeId);
  if (news.length > 0) {
    send(conn, { type: "news_feed", challengeId, data: news });
  }
  // New Eden: deliver current fair values so late joiners see them.
  const fvs = await getFairValues(redis, challengeId);
  for (const [symbol, fairValue] of Object.entries(fvs)) {
    send(conn, {
      type: "fair_value",
      challengeId,
      data: { symbol, fairValue, ts: Date.now() },
    });
  }
}

async function subscribe(conn: Conn, challengeId: string): Promise<void> {
  if (conn.subs.has(challengeId)) return;
  conn.subs.add(challengeId);
  let set = registry.get(challengeId);
  if (!set) {
    set = new Set();
    registry.set(challengeId, set);
  }
  set.add(conn);
  await fanout.add(challengeId);
  send(conn, { type: "subscribed", challengeId });
  await sendSnapshot(conn, challengeId);
}

async function unsubscribe(conn: Conn, challengeId: string): Promise<void> {
  if (!conn.subs.delete(challengeId)) return;
  const set = registry.get(challengeId);
  set?.delete(conn);
  if (set && set.size === 0) registry.delete(challengeId);
  await fanout.remove(challengeId);
}

function authenticate(url: string): string | null {
  try {
    const token = new URL(url, "http://localhost").searchParams.get("token");
    if (!token) return null;
    const payload = jwt.verify(token, env.jwtSecret) as { sub: string };
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

const server = createServer((req, res) => {
  if (req.url?.startsWith("/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", connections: countConnections() }));
    return;
  }
  if (req.url?.startsWith("/metrics")) {
    const mem = process.memoryUsage();
    const body = [
      "# HELP qtp_ws_connections Current open WebSocket connections.",
      "# TYPE qtp_ws_connections gauge",
      `qtp_ws_connections ${countConnections()}`,
      "# HELP qtp_ws_subscriptions Active challenge subscriptions.",
      "# TYPE qtp_ws_subscriptions gauge",
      `qtp_ws_subscriptions ${registry.size}`,
      "# HELP qtp_ws_connections_total Connections accepted since start.",
      "# TYPE qtp_ws_connections_total counter",
      `qtp_ws_connections_total ${metrics.connectionsTotal}`,
      "# HELP qtp_ws_messages_sent_total Messages sent to clients.",
      "# TYPE qtp_ws_messages_sent_total counter",
      `qtp_ws_messages_sent_total ${metrics.messagesSent}`,
      "# HELP qtp_ws_dropped_total Connections dropped for backpressure.",
      "# TYPE qtp_ws_dropped_total counter",
      `qtp_ws_dropped_total ${metrics.messagesDropped}`,
      "# HELP process_resident_memory_bytes Resident memory size in bytes.",
      "# TYPE process_resident_memory_bytes gauge",
      `process_resident_memory_bytes ${mem.rss}`,
      `process_uptime_seconds ${process.uptime()}`,
      "",
    ].join("\n");
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(body);
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: "/ws" });

type AliveWs = WebSocket & { isAlive?: boolean };

wss.on("connection", (ws: AliveWs, req) => {
  const conn: Conn = {
    ws,
    userId: authenticate(req.url ?? ""),
    subs: new Set(),
    isAlive: true,
  };
  ws.isAlive = true;
  metrics.connectionsTotal += 1;

  ws.on("pong", () => {
    ws.isAlive = true;
    conn.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "subscribe":
        void subscribe(conn, msg.challengeId);
        break;
      case "unsubscribe":
        void unsubscribe(conn, msg.challengeId);
        break;
      case "ping":
        send(conn, { type: "pong" });
        break;
    }
  });

  ws.on("close", () => {
    for (const challengeId of [...conn.subs]) void unsubscribe(conn, challengeId);
  });

  ws.on("error", () => ws.terminate());
});

function countConnections(): number {
  return wss.clients.size;
}

// Heartbeat: terminate connections that stop responding to pings.
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    const ws = client as AliveWs;
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, env.heartbeatMs);

server.listen(env.port, () => {
  console.log(`[gateway] listening on :${env.port}`);
});

async function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close();
  await fanout.close();
  await redis.quit().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
