import { createServer } from "node:http";
import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
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
  hasPremiumAccess,
  isMarketFrozen,
  isSymbolLocked,
} from "@qtp/bus";
import { isNewsEmbargoed, type NewsItem } from "@qtp/shared";
import { challengeNews, challenges, getDb } from "@qtp/db";
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
  isAdmin: boolean;
  subs: Set<string>;
  pendingNews: Map<string, ReturnType<typeof setTimeout>>;
  isAlive: boolean;
}

const db = getDb();
const redis = createRedis(env.redisUrl);

/** challengeId -> set of connections subscribed to it. */
const registry = new Map<string, Set<Conn>>();

const fanout = new Fanout(env.redisUrl, dispatch);

// Lightweight metrics counters.
const metrics = { messagesSent: 0, messagesDropped: 0, connectionsTotal: 0 };

function dispatch(challengeId: string, envelopes: BroadcastEnvelope[]): void {
  const conns = registry.get(challengeId);
  if (!conns || conns.size === 0) return;
  for (const env_ of envelopes) {
    // Embargoed live news: premium subscribers see it immediately, everyone
    // else only after the embargo lifts (the premium-feed lead time).
    if (
      env_.target === "all" &&
      env_.msg.type === "news" &&
      isEmbargoed(env_.msg.data, Date.now())
    ) {
      void dispatchEmbargoedNews(challengeId, conns, env_.msg).catch(
        console.error,
      );
      continue;
    }
    if (env_.target === "all") {
      for (const conn of conns) send(conn, env_.msg);
    } else {
      for (const conn of conns) {
        if (conn.userId === env_.target) send(conn, env_.msg);
      }
    }
  }
}

function isEmbargoed(item: NewsItem, now: number): boolean {
  return isNewsEmbargoed(item, now);
}

async function dispatchEmbargoedNews(
  challengeId: string,
  conns: Set<Conn>,
  msg: Extract<ServerMessage, { type: "news" }>,
): Promise<void> {
  const item = msg.data;
  for (const conn of conns) {
    const premium =
      conn.isAdmin || (await hasPremiumAccess(redis, challengeId, conn.userId));
    if (premium) {
      if (conn.subs.has(challengeId)) send(conn, msg);
    } else {
      scheduleNews(conn, challengeId, item);
    }
  }
}

function scheduleNews(conn: Conn, challengeId: string, item: NewsItem): void {
  const key = `${challengeId}:${item.id}`;
  if (!conn.subs.has(challengeId) || conn.pendingNews.has(key)) return;
  const timer = setTimeout(
    () => {
      conn.pendingNews.delete(key);
      if (conn.subs.has(challengeId))
        send(conn, { type: "news", challengeId, data: item });
    },
    Math.max(0, new Date(item.embargoUntil!).getTime() - Date.now()),
  );
  timer.unref();
  conn.pendingNews.set(key, timer);
}

function send(conn: Conn, msg: ServerMessage): void {
  if (conn.ws.readyState !== WebSocket.OPEN) return;
  // Host-only information must not leak through live broadcasts or snapshots.
  if (msg.type === "fair_value" && !conn.isAdmin) return;
  if (conn.ws.bufferedAmount > env.maxBufferedBytes) {
    // Slow consumer: drop the connection rather than buffer unbounded.
    metrics.messagesDropped += 1;
    conn.ws.terminate();
    return;
  }
  conn.ws.send(JSON.stringify(msg));
  metrics.messagesSent += 1;
}

async function sendSnapshot(conn: Conn, challengeId: string): Promise<void> {
  // Read fresh config: symbols and ETFs can be introduced while a game is live.
  const challenge = await db.query.challenges.findFirst({
    where: eq(challenges.id, challengeId),
  });
  const symbols = challenge?.config.symbols.map((s) => s.symbol) ?? [];
  // Include dynamically-listed instruments (options / ETFs) so late joiners
  // see their books and marks too.
  const listed = await getListedSymbols(redis, challengeId);
  for (const symbol of new Set([...symbols, ...listed])) {
    const price = await getPrice(redis, challengeId, symbol);
    const spot = challenge?.config.symbols.find((s) => s.symbol === symbol);
    const etf = challenge?.config.eden?.etfs?.find((e) => e.symbol === symbol);
    if (spot || etf) {
      let nav = 0;
      for (const leg of etf?.basket ?? []) {
        nav +=
          leg.weight *
          ((await getPrice(redis, challengeId, leg.symbol)) ??
            challenge?.config.symbols.find((s) => s.symbol === leg.symbol)
              ?.initialPrice ??
            0);
      }
      send(conn, {
        type: "symbol_listed",
        challengeId,
        data: {
          config: spot ?? {
            symbol,
            name: etf?.name,
            initialPrice: Math.max(0.1, price ?? nav),
            volatility: 0,
            tickSize: 0.1,
          },
          kind: spot ? "spot" : "etf",
          locked: await isSymbolLocked(redis, challengeId, symbol),
          ts: Date.now(),
        },
      });
    }
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
  let news = await getNewsFeed(redis, challengeId, 50);
  if (news.length === 0) {
    const rows = await db
      .select()
      .from(challengeNews)
      .where(
        and(
          eq(challengeNews.challengeId, challengeId),
          or(
            isNull(challengeNews.publishAt),
            isNotNull(challengeNews.publishedAt),
          ),
        ),
      )
      .orderBy(desc(challengeNews.createdAt))
      .limit(50);
    news = rows.map((row) => ({
      id: row.id,
      challengeId,
      message: row.message,
      level: row.level,
      feed: row.feed,
      createdAt: row.createdAt.toISOString(),
      embargoUntil: row.embargoUntil?.toISOString() ?? null,
    }));
  }
  if (news.length > 0) {
    const premium =
      conn.isAdmin || (await hasPremiumAccess(redis, challengeId, conn.userId));
    const visible = premium
      ? news
      : news.filter((n) => !isEmbargoed(n, Date.now()));
    if (visible.length > 0) {
      send(conn, { type: "news_feed", challengeId, data: visible });
    }
    if (!premium) {
      for (const item of news) {
        if (isEmbargoed(item, Date.now()))
          scheduleNews(conn, challengeId, item);
      }
    }
  }
  if (!conn.isAdmin) return;
  // Fair values are only for the host console, never the premium trader feed.
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
  send(conn, {
    type: "market_status",
    challengeId,
    data: { frozen: await isMarketFrozen(redis, challengeId) },
  });
  await sendSnapshot(conn, challengeId);
}

async function unsubscribe(conn: Conn, challengeId: string): Promise<void> {
  if (!conn.subs.delete(challengeId)) return;
  for (const [key, timer] of conn.pendingNews) {
    if (key.startsWith(`${challengeId}:`)) {
      clearTimeout(timer);
      conn.pendingNews.delete(key);
    }
  }
  const set = registry.get(challengeId);
  set?.delete(conn);
  if (set && set.size === 0) registry.delete(challengeId);
  await fanout.remove(challengeId);
}

function authenticate(
  url: string,
): { userId: string; isAdmin: boolean } | null {
  try {
    const token = new URL(url, "http://localhost").searchParams.get("token");
    if (!token) return null;
    const payload = jwt.verify(token, env.jwtSecret);
    if (typeof payload === "string" || typeof payload.sub !== "string")
      return null;
    return { userId: payload.sub, isAdmin: payload.role === "admin" };
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
  const identity = authenticate(req.url ?? "");
  const conn: Conn = {
    ws,
    userId: identity?.userId ?? null,
    isAdmin: identity?.isAdmin ?? false,
    subs: new Set(),
    pendingNews: new Map(),
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
        void subscribe(conn, msg.challengeId).catch(console.error);
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
    for (const challengeId of [...conn.subs])
      void unsubscribe(conn, challengeId);
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
