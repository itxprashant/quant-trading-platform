# AGENTS.md — Quanta Quant Trading Platform

Guide for AI coding agents working in this repository. Read this before making changes.

## Project summary

**Quanta** is a competitive quant trading challenge platform: market-making contests, directional PnL races, and the scripted **New Eden Exchange** tournament format. Participants trade synthetic instruments in real time; organizers run events via an admin UI.

- **Production URL:** https://quanta.devclub.in
- **GitHub:** https://github.com/itxprashant/quant-trading-platform
- **Stack:** TypeScript monorepo (pnpm + turbo), Next.js 15, Fastify, Postgres 17, Redis 7, Docker
- **Design bar:** Dark trading-terminal aesthetic — see `PRODUCT.md` and `DESIGN.md`. Data-first, dense, no generic SaaS or neon crypto clichés.

### Challenge types

| Type | Slug enum | Scoring | Notes |
|------|-----------|---------|-------|
| **Directional** | `directional` | Mark-to-market PnL | Classic PnL race; seeded live demo challenge |
| **Market making** | `market_making` | Spread capture, quote uptime, inventory | MM metrics from engine |
| **New Eden** | `new_eden` | Directional PnL + extended economy | Scripted 130-minute tournament; bonds, options, ETF, OTC, auctions, votes, grants, specialized bots |

---

## Complete system architecture

### 1. High-level overview

Quanta is an event-driven trading platform: the **API** accepts authenticated REST requests, the **matching engine** owns order books and emits events, the **gateway** fans out real-time updates over WebSockets, and the **scoring worker** computes leaderboards. **Postgres** is the system of record; **Redis** is the command bus, event log, hot cache, pub/sub layer, and coordination plane.

```mermaid
flowchart TB
  subgraph clients [Clients]
    Browser[Browser / Next.js web]
  end

  subgraph edge [Edge — production VM]
    Nginx[nginx :443 TLS]
    Web[web :3000]
    API[api :8000]
    GW[gateway :8080]
  end

  subgraph workers [Background workers]
    Engine[engine — matching + bots + Eden timeline]
    Scoring[scoring — leaderboard]
    Migrate[migrate — one-shot schema/seed]
  end

  subgraph data [Data layer]
    PG[(Postgres 17)]
    Redis[(Redis 7)]
  end

  Browser -->|HTTPS /| Nginx --> Web
  Browser -->|HTTPS /api/*| Nginx --> API
  Browser -->|WSS /ws| Nginx --> GW

  API --> PG
  API -->|XADD commands| Redis
  Engine -->|XREAD commands| Redis
  Engine -->|XADD events| Redis
  Engine --> PG
  Engine -->|PUBLISH| Redis
  GW -->|SUBSCRIBE| Redis
  GW --> PG
  Scoring --> Redis
  Scoring --> PG
  Migrate --> PG
```

### 2. Production deployment topology

Current production is a **single Azure VM** running the full stack in Docker Compose. Images are built in **GitHub Actions** and pulled from **Azure Container Registry (ACR)** — do not compile on the VM for routine releases.

```mermaid
flowchart LR
  subgraph dev [Developer]
    Git[git push main]
  end

  subgraph github [GitHub]
    CI[ci.yml]
    Pub[publish-images.yml]
  end

  subgraph azure [Azure — southeastasia]
    ACR[quantadevclub.azurecr.io]
    VM[quanta-b2ms VM]
    NSG[NSG :22 :80 :443]
  end

  DNS[quanta.devclub.in] --> NSG --> VM
  Git --> CI
  Git --> Pub --> ACR
  ACR -->|docker pull| VM
```

| Layer | Components |
|-------|------------|
| **DNS / TLS** | `quanta.devclub.in` → `20.205.227.58`; Let's Encrypt via certbot |
| **Reverse proxy** | nginx — `/` → web, `/api/` → api, `/ws` → gateway |
| **App containers** | migrate, api, gateway, engine, scoring, web |
| **Data containers** | postgres (volume `qtp-pgdata`), redis (volume `qtp-redisdata`) |
| **Registry** | `quantadevclub.azurecr.io/quanta-{service}:sha-<commit>` |
| **Future scale-out** | `infra/terraform/` — AWS ECS + Aurora + ElastiCache skeleton |

Docker network: all services on internal bridge `internal`; only nginx exposes 80/443.

### 3. Runtime services

| Service | Port | Role | Stateful? |
|---------|------|------|-----------|
| **web** | 3000 | Next.js 15 App Router — trader dashboard, challenge pages, admin builder | No |
| **api** | 8000 | Fastify REST — auth, challenges, orders, market, portfolio, leaderboard, admin, Eden trader routes | No |
| **gateway** | 8080 | WebSocket server — subscribe to challenges, fan-out ticks/fills/book | No (in-memory conn registry) |
| **engine** | — | Per-challenge matching runners, lifecycle transitions, bots, New Eden timeline | Yes (in-memory books per challenge) |
| **scoring** | — | Periodic leaderboard recompute from positions + engine metrics | No |
| **migrate** | — | One-shot: `db:push` + `db:seed` on compose up | No |
| **nginx** | 80/443 | TLS termination, reverse proxy | No |
| **postgres** | 5432 | Durable relational state | Yes |
| **redis** | 6379 | Streams, pub/sub, hot cache, locks, rate limits | Yes (AOF enabled in prod) |

### 4. Order flow (write path)

How a limit order travels from click to fill notification:

```
1. Trader POST /api/orders  (JWT in Authorization header)
2. API validates input (Zod), checks challenge is live, rate-limits user
3. API inserts order row (status=open) in Postgres
4. API XADD EngineCommand → Redis stream qtp:cmd:{challengeId}
5. Engine ChallengeRunner reads command stream (consumer group)
6. Engine matches against in-memory order book (packages/core)
7. Engine updates cash/positions/orders in Postgres (persistence layer)
8. Engine XADD EngineEvent → Redis stream qtp:evt:{challengeId}
9. Engine updates hot Redis state (price, book snapshot, trader metrics)
10. Engine PUBLISH → Redis channel qtp:bc:{challengeId}
11. Gateway receives pub/sub message, fans out to subscribed WS clients
12. Scoring worker (async loop) reads metrics/prices, recomputes leaderboard
13. Scoring SET qtp:lb:{challengeId} + PUBLISH leaderboard update
```

**Invariant:** Only the engine process holding `qtp:lock:engine:{challengeId}` mutates the order book for that challenge.

### 5. Real-time flow (read path)

```
1. Client opens WSS /ws?token=<JWT>
2. Gateway verifies JWT, registers connection
3. Client sends { type: "subscribe", challengeId }
4. Gateway adds conn to challenge registry, sends snapshot (price + book from Redis)
5. Gateway Fanout subscribes to qtp:bc:{challengeId} on Redis pub/sub
6. On each engine broadcast envelope → JSON message to subscribed clients
7. Slow clients (bufferedAmount > limit) are terminated (backpressure)
```

WebSocket message types are defined in `packages/shared/src/ws.ts` (`ClientMessage`, `ServerMessage`).

### 6. Challenge lifecycle

Managed by the engine's reconcile loop (`apps/engine/src/index.ts`):

```
draft → scheduled → live → paused → ended
         ↑ auto-start      ↑ admin    ↑ auto-end or admin
         (startsAt)                   (endsAt)
```

| Status | Trading | Engine runner | Redis `qtp:active-challenges` |
|--------|---------|---------------|-------------------------------|
| draft | No | No | No |
| scheduled | No | No (until startsAt) | No |
| live | Yes | Yes (if lock acquired) | Yes |
| paused | No | Runner stopped | No |
| ended | No | Runner stopped | No |

Each challenge has isolated: command stream, event stream, broadcast channel, order books, bots, and leaderboard.

**New Eden freeze (halftime):** Status stays `live` but `challenges.frozen = true`. Matching and new risk stop; the timeline, cost of carry, bond coupons, and loan deductions continue. This is **not** the same as `paused` (which tears down the runner). Halftime is scripted at game minutes 60–70.

### 7. Redis data model

Central naming in `packages/shared/src/keys.ts`:

| Key / pattern | Type | Writer | Reader | Purpose |
|---------------|------|--------|--------|---------|
| `qtp:cmd:{challengeId}` | Stream | API | Engine | Order/cancel/admin commands |
| `qtp:evt:{challengeId}` | Stream | Engine | Scoring (future replay) | Durable event log |
| `qtp:bc:{challengeId}` | Pub/sub | Engine | Gateway | Real-time fan-out |
| `qtp:price:{cid}:{symbol}` | String | Engine | Gateway, API, Scoring | Last trade/mid price |
| `qtp:phist:{cid}:{symbol}` | Sorted set | Engine | API (charts) | Price history (max 1000) |
| `qtp:book:{cid}:{symbol}` | String (JSON) | Engine | Gateway | Order book snapshot |
| `qtp:lock:engine:{cid}` | String + TTL | Engine | Engine | Leader election |
| `qtp:active-challenges` | Set | Engine | Engine, Scoring | Pool membership |
| `qtp:lb:{cid}` | String (JSON) | Scoring | API, Gateway | Leaderboard snapshot |
| `qtp:metrics:{cid}` | Hash | Engine | Scoring | Per-trader MM metrics JSON |
| `qtp:rl:{bucket}:{userId}` | String | API | API | Token-bucket rate limit |

### 8. Postgres data model

Schema in `packages/db/src/schema.ts` (Drizzle ORM):

| Table | Purpose |
|-------|---------|
| `users` | Accounts — username, password hash, role (`trader` \| `admin`) |
| `challenges` | Event config — type, status, symbols, limits, scoring, schedule, `frozen`, `leaderboardHidden`, `finalizedAt`, `finalResults` |
| `participants` | Enrollment — cash balance, loan debt per user per challenge |
| `orders` | Order intent + status (open → filled/cancelled) |
| `trades` | Executed fills (formerly referenced as `fills` in older docs) |
| `positions` | Per-symbol inventory per participant |
| `score_snapshots` | Historical leaderboard rows |
| `challenge_news` | Headlines — kind (signal/noise/neutral), FV effects, momentum, embargo |
| `fair_values` | Absolute fair value per symbol per challenge |
| `loans` | Predatory loan requests, funding, amortized repayment schedule |
| `bond_holdings` | Per-user bond inventory and coupon accrual |
| `option_cycles` | Options expiry cycles (open → exercise_window → expired) |
| `option_contracts` | Individual call/put series per cycle |
| `otc_offers` | Deal Desk private offers, responses, settlement state |
| `auctions` | Premium-feed blind auction rounds |
| `auction_bids` | Sealed bids per trader per auction |
| `vote_proposals` | Policy votes (e.g. Solidarity Tax) |
| `vote_ballots` | Per-trader yes/no ballots |
| `grant_missions` | Government grant missions (inventory hoarding prizes) |
| `engine_checkpoints` | Durable engine state snapshots for recovery |
| `event_actions` | Idempotency receipts for scripted timeline actions `(challenge_id, action_id)` |

Challenge `config` (JSONB) includes: symbols, starting cash, limits, bots, and for New Eden an `eden` block (rules, bonds, ETFs, options, auction settings, `eventScript`).  
Challenge `scoring` (JSONB) selects directional PnL vs market-making weights.

### 9. Matching engine internals

| Layer | Location | Responsibility |
|-------|----------|----------------|
| **Pure matching** | `packages/core/src/engine.ts`, `order-book.ts` | Price-time priority book, match loop, atomic multi-leg batches |
| **Scoring math** | `packages/core/src/scoring.ts` | Directional PnL + MM composite score |
| **Margin / options math** | `packages/core/src/margin.ts`, `options.ts` | Solvency, option intrinsic/exercise |
| **Runner** | `apps/engine/src/runner.ts` | Command loop, persistence, event emission, Eden integration |
| **Classic bots** | `apps/engine/src/bots.ts` | Market-maker quotes + noise traders (non-Eden) |
| **Eden bots** | `apps/engine/src/eden-bots.ts` | HFT MM, momentum, vega sniper, parity arb |
| **Eden settlements** | `apps/engine/src/eden-settlements.ts` | Cost of carry, loans, margin calls, forced liquidation |
| **Options manager** | `apps/engine/src/options-manager.ts` | Cycles, exercise window, assignment |
| **Markets manager** | `apps/engine/src/markets-manager.ts` | Bonds, ETF create/redeem windows |
| **Event timeline** | `apps/engine/src/event-timeline.ts` | Dispatches scripted actions; recovery + receipts |
| **Event executor** | `apps/engine/src/event-executor.ts` | Listings, news, OTC, auctions, votes, grants |
| **Final scoring** | `apps/engine/src/final-scoring.ts` | End-of-event MtM, debt closeout, durable rankings |
| **Persistence** | `apps/engine/src/persistence.ts` | Postgres writes for fills, positions, cash, checkpoints |

Engine tick interval: `ENGINE_TICK_MS` (1000 ms prod, 250 ms local dev).  
Game-minute interval (New Eden carry/loans/timeline): `ENGINE_MINUTE_MS` (default 60 000 ms). **Not the same variable.**

### 10. Scoring system

`apps/scoring` polls active challenges on an interval:

1. Load participants, positions, challenge scoring config from Postgres
2. Read current prices from Redis
3. Read per-trader metrics hash from Redis (spread capture, quote uptime, volume, realized PnL — tracked by engine)
4. `computeScore()` from `@qtp/core` → ranked entries
5. Write `qtp:lb:{challengeId}` and broadcast leaderboard WS message
6. Periodically persist `score_snapshots` to Postgres

Challenge types: **`directional`**, **`market_making`**, **`new_eden`** (directional-style PnL on the extended economy).

### 11. API surface

Fastify app in `apps/api/src/app.ts`. Routes under `apps/api/src/routes/`:

| Prefix | Auth | Purpose |
|--------|------|---------|
| `/api/auth` | Public | Login, register → JWT |
| `/api/challenges` | Mixed | List, detail, join, admin lifecycle |
| `/api/orders` | Trader | Place, cancel, list open (auto-enrolls on first order) |
| `/api/market` | Trader | Prices, book, history, symbols |
| `/api/portfolio` | Trader | Cash, positions, MM metrics, loan debt |
| `/api/leaderboard` | Public/trader | Rankings (403 `leaderboard_hidden` for non-admins while the host hides them) |
| `/api/loans` | Trader | Request predatory loans (New Eden) |
| `/api/options` | Trader | List cycles/contracts, exercise |
| `/api/markets` | Trader | Bonds, ETF create/redeem |
| `/api/otc` | Trader | Deal Desk offers — accept/reject/bargain |
| `/api/auctions` | Trader | Premium-feed blind auction bids |
| `/api/votes` | Trader | Policy vote ballots |
| `/api/admin` | Admin | CRUD challenges, lifecycle, Eden host console (24+ endpoints) |
| `/api/health` | Public | Health check |
| `/api/metrics` | Public | Prometheus metrics |

Rate limiting: Redis token bucket via `apps/api/src/ratelimit.ts` (orders bucket: 25/s per user; auth register: 10/min per IP).

**Enrollment:** `POST /api/challenges/:id/join` (trader JWT). The web UI has no Join button — first order also enrolls. For New Eden scripted OTC (first slot at game minute 2.5), players must join **before** `startsAt`.

### 12. Authentication & authorization

```
Login → API signs JWT (JWT_SECRET, default 86400s TTL)
      → Web stores token (localStorage)
      → REST: Authorization: Bearer <token>
      → WS: ?token=<token> query param on /ws
Roles: trader (trade + view), admin (+ challenge management)
```

`JWT_SECRET` must be identical on **api** and **gateway**. CORS enforced on API via `CORS_ORIGINS`.

### 13. Frontend architecture

Next.js App Router (`apps/web/src/app/`):

| Route | Audience | Purpose |
|-------|----------|---------|
| `/` | All | Challenge list |
| `/challenges` | All | Event register with format guide |
| `/login` | All | Login + self-registration |
| `/challenges/[id]` | Trader | Trading terminal — markets + rankings (left), book/portfolio/ticket row, toggleable chart, Eden panels, news feed (right); event timers in the top bar |
| `/admin` | Admin | Challenge list + lifecycle controls |
| `/admin/new`, `/admin/[id]` | Admin | Challenge builder + live operations |

**Trader components** (`apps/web/src/components/trade/`): `MarketList`, `Leaderboard` (compact sidebar variant; hidden state), `TradeTicket`, `OrderBook`, `PriceChart`, `PortfolioPanel`, `OpenOrders`, `NewsFeed` (market news + announcements, filter tabs, `Early` tags), `EventTimers`, `BankPanel`, `OptionsPanel` (docked order ticket + option book), `MarketsPanel`, `DealDesk`, `AuctionPopup`, `VotePanel`, `GrantBanner`, `AlertStack` (alerts + news toasts).

**Admin components** (`apps/web/src/components/admin/`): `ChallengeForm` (playbook preset), `EdenHostConsole`, `AccountEditor`; live ops also use `LiveControls`, `NewsControls`, `FreezeControls`, `AddInstrumentControls` on the `[id]` page. The `[id]` header has the leaderboard visibility toggle (`POST /api/admin/:id/leaderboard-visibility { hidden }`), available in every status.

Event timers (`EventTimers`, selectors in `lib/eden.ts`) use the headline-free `eden-clock.ts` / `eden-presets.ts` exports of `@qtp/shared`. The package is `sideEffects: false`, so the web bundle tree-shakes the scripted headlines away — never reference `EDEN_EVENT_NEWS` / `EDEN_EVENT_ACTIONS` from web code, or the script leaks to the browser.

Real-time: `hooks/useRealtime.ts` manages WS connection, subscriptions, message dispatch.  
API client: `lib/api.ts`. Config: `lib/config.ts` reads `NEXT_PUBLIC_*` (build-time).

### 14. CI/CD pipeline architecture

```
Push to main
  ├── ci.yml          → pnpm install → build → typecheck → test → db:push → db:seed
  └── publish-images  → matrix build (6 services) → push to ACR
                          ├── migrate   (Dockerfile.migrate)
                          ├── api       (Dockerfile.service SERVICE=api)
                          ├── gateway   (Dockerfile.service SERVICE=gateway)
                          ├── engine    (Dockerfile.service SERVICE=engine)
                          ├── scoring   (Dockerfile.service SERVICE=scoring)
                          └── web       (Dockerfile.web + NEXT_PUBLIC_*)
```

**Deploy:** `registry-vm-deploy.sh` rsyncs compose/nginx → VM → `docker compose pull` → `up -d`.  
See [Deployment — use the CI registry route](#deployment--use-the-ci-registry-route).

### 15. Monorepo dependency graph

```
apps/web        → @qtp/shared, @qtp/config
apps/api        → @qtp/shared, @qtp/core, @qtp/bus, @qtp/db
apps/gateway    → @qtp/shared, @qtp/bus, @qtp/db
apps/engine     → @qtp/shared, @qtp/core, @qtp/bus, @qtp/db
apps/scoring    → @qtp/shared, @qtp/core, @qtp/bus, @qtp/db
packages/bus    → @qtp/shared
packages/db     → @qtp/shared
packages/core   → @qtp/shared
```

Build orchestration: **turbo** (`turbo.json`) + **pnpm workspaces** (`pnpm-workspace.yaml`).

### 16. Architecture invariants (do not break)

1. **Single engine writer per challenge** — Redis lock + one `ChallengeRunner` per live challenge.
2. **Commands via Redis stream, not direct engine calls** — API never invokes engine in-process.
3. **Gateway is read-only for trading state** — no order placement over WS.
4. **Postgres is source of truth** for orders, fills, positions, users; Redis is ephemeral hot state.
5. **Per-challenge isolation** — streams, channels, books, bots, leaderboards are keyed by `challengeId`.
6. **Web public URLs are build-time** — changing API/WS URLs requires rebuilding the web image in CI.
7. **Production deploys use CI registry** — pull pre-built images; on-VM compile is fallback only.
8. **Scripted New Eden immutability** — once live, `startsAt`, `endsAt`, and `eventScript` cannot change; do not duplicate scripted ops with manual host actions.
9. **Event action IDs are versioned** — never renumber `eden-v1/*` actions in `packages/shared/src/eden-event.ts` for running events.

---

## New Eden Exchange

The flagship scripted tournament ("The New Eden Exchange"). Full narrative playbook: [`event.md`](event.md).

### Scripted vs manual host mode

| Mode | Config | Behavior |
|------|--------|----------|
| **Scripted** | `config.eden.eventScript: true` | Engine runs versioned 130-game-minute timeline autonomously |
| **Manual** | `eventScript: false` | Host drives news, auctions, OTC, etc. via admin console |

Enable via admin **New Eden playbook preset** (`ChallengeForm.tsx`). Seeded challenge **New Eden Exchange** has `eventScript: true` but no `startsAt` until configured.

### Timeline summary (scripted)

Source of truth: `packages/shared/src/eden-event.ts` (`EDEN_EVENT_VERSION = "eden-v1"`).

| Game minute | Event |
|-------------|-------|
| 0 | AERIUM opens (FV 1000) |
| 10 / 18 | Standard bond / Aerium-pegged bond listed |
| 30 | NEURO lists (FV 500) |
| 45 | ORBITAL ETF lists (2 AERIUM + 1 NEURO); ETF windows every 10m |
| 60–70 | Halftime freeze (status stays `live`) |
| 70 | Options open (AERIUM calls/puts, 5-min cycles) |
| 15, 30, 45, 75, 90, 105, 120 | Premium blind auctions |
| 2.5 … 122.5 | OTC Deal Desk slots (13 total; 62.5 skipped in halftime) |
| 80–81 | Solidarity Tax vote |
| 89–90 | Vega bot prepare / Dis-correlation shock |
| 100–105 | Government grant on AERIUM |
| 120 | Bot volatility ×3 |
| 130 | Final halt, rankings, `finalResults` persisted |

24 news beats (12 signal / 12 noise) every 5 minutes outside halftime.

### Economy rules (`config.eden.rules`)

- **Cost of carry:** $1/unit/minute on absolute inventory
- **Predatory loans:** 2× repay amortized over remaining game minutes; halftime rescue loans at minute 60
- **Margin calls:** at `marginCallThreshold` (default $0 free cash); forced liquidation when enabled
- **Position cap:** 100 units per symbol (default)

### Clock semantics

| Variable | Default | Purpose |
|----------|---------|---------|
| `ENGINE_MINUTE_MS` | 60 000 | Game-minute for timeline, carry, loans, coupons |
| `ENGINE_TICK_MS` | 1000 prod / 250 dev | Price drift tick interval |

**Wall-time exceptions (do not scale with `ENGINE_MINUTE_MS`):** option exercise window = 15 wall seconds; OTC bargain settlement delay = 5 wall seconds.

Accelerated local dry run: `ENGINE_MINUTE_MS=6000 pnpm dev` (~13 wall minutes for full script).

### Documentation for running events

| Doc | Audience | Content |
|-----|----------|---------|
| [`docs/new-eden-simulation-guide.md`](docs/new-eden-simulation-guide.md) | Organizers | End-to-end simulation with real players — enrollment, dry run, production |
| [`docs/new-eden-host-guide.md`](docs/new-eden-host-guide.md) | Hosts | Manual admin controls + API reference (for manual mode or emergencies) |
| [`docs/EVENT-IMPLEMENTATION.md`](docs/EVENT-IMPLEMENTATION.md) | Engineers | Implementation details, recovery, schema backfill, release gates |
| [`event.md`](event.md) | Hosts | Full narrative playbook, traps, minute-by-minute script |

---

## Repository layout

```
apps/
  web/        Next.js 15 frontend (trader terminal + admin)
  api/        Fastify REST (auth, trading, Eden trader routes, admin)
  engine/     Matching engine + Eden timeline + bots (per-challenge runners)
  gateway/    WebSocket gateway (Redis fan-out)
  scoring/    Leaderboard / scoring worker

packages/
  shared/     Domain types, Zod schemas, WS protocol, Redis keys, eden-event schedule
  core/       Pure matching engine + scoring + Eden bot logic (Vitest)
  bus/        Redis streams, pub/sub, hot state helpers
  db/         Drizzle ORM schema, client, seed, backfill-eden migration tool
  config/     Shared tsconfig presets (@qtp/config)

docs/
  new-eden-simulation-guide.md   Run full event with real players
  new-eden-host-guide.md           Manual host controls + API
  EVENT-IMPLEMENTATION.md        Engineering rollout + recovery

test-scripts/                    Black-box production/local feature tests (Node 22+)
  run.mjs                        Orchestrator
  lib.mjs                        HTTP/WS helpers
  suites/                        01-public … 10-post-audit (incl. 07-new-eden, 09-eden-script)

infra/
  docker/     Dockerfile.service (api|gateway|engine|scoring), Dockerfile.web, Dockerfile.migrate
  nginx/      Reverse proxy + TLS (Let's Encrypt via certbot)
  azure/      cloud-init, CI-REGISTRY.md
  terraform/  AWS ECS/Aurora skeleton (future scale-out; prod demo uses single Azure VM)

scripts/
  registry-vm-deploy.sh, deploy-changed.sh, azure-deploy.sh, setup-*.sh
  changed-services.sh, lib/service-graph.sh
  loadtest.mjs                   WS + order load harness

Root reference files:
  event.md, comp_desc.txt          New Eden host playbook (narrative)
  tryst_platform_context.md        Original Tryst '26 event context
  PRODUCT.md, DESIGN.md            Product intent and visual register
  AUDIT.md                         Security/competitive-integrity audit (2026-08-04)

.github/workflows/
  ci.yml              Build, typecheck, test, db push/seed on PR/push
  publish-images.yml  Build + push all images to ACR on push to main
```

Package names use the `@qtp/*` scope (e.g. `@qtp/api`, `@qtp/shared`).

---

## Local development

**Prerequisites:** Node 20+, pnpm 11.8 (via `packageManager` in root `package.json`), Docker.

```bash
pnpm install
cp .env.example .env
pnpm infra:up          # Postgres + Redis (docker-compose.yml)
pnpm db:push
pnpm db:seed
pnpm dev               # all apps via turbo
```

Open http://localhost:3000.

**Seeded logins:** `admin / admin1234`, `trader1..8 / trader1234`

**Seeded challenges:**

| Name | Type | Status | Notes |
|------|------|--------|-------|
| Tryst Directional Open | directional | live | Traders 1–8 auto-enrolled |
| Liquidity Wars MM | market_making | scheduled | — |
| New Eden Exchange | new_eden | scheduled | `eventScript: true`; set `startsAt` before running |

| Command | Purpose |
|---------|---------|
| `pnpm build` | Build entire monorepo |
| `pnpm typecheck` | Type-check all packages |
| `pnpm test` | Unit tests (~330 across packages) |
| `pnpm db:push` / `db:seed` | Schema + seed data |
| `pnpm db:backfill-eden` | Legacy Eden migration tool (see EVENT-IMPLEMENTATION.md) |
| `pnpm infra:up` / `infra:down` | Local Postgres + Redis |
| `pnpm deploy:registry` | Production registry deploy (needs REGISTRY + IMAGE_TAG) |

On some Linux kernels, `docker-compose.override.yml` uses host networking for Postgres to avoid connection resets.

### New Eden local dry run

```bash
ENGINE_MINUTE_MS=6000 pnpm dev   # ~13 min full script
```

1. Admin → `/admin` → **New Eden Exchange** → set **Starts at** → Save.
2. Enroll players via `POST /api/challenges/:id/join` before open (see simulation guide).
3. Do not fire manual scripted controls during the run.
4. **Reset** after dry run; re-schedule for the real event.

---

## Testing

### Unit / integration (Vitest / tsx)

```bash
pnpm test                                                    # all packages via turbo
pnpm --filter @qtp/core exec vitest run                      # matching engine + Eden logic
pnpm --filter @qtp/db exec vitest run src/backfill-eden.test.ts  # 36 backfill tests (separate harness)
```

Approximate counts: core ~180, engine ~67, api ~57, scoring ~21, web ~5.

### Black-box feature tests (`test-scripts/`)

Hits deployed or local stack; creates isolated `E2E *` challenges; cleans up on exit.

```bash
node test-scripts/run.mjs
# Local: API_URL=http://localhost:8000 WS_URL=ws://localhost:8080 node test-scripts/run.mjs
```

Suites: public → auth → lifecycle → trading → realtime → admin → New Eden → edge → scripted Eden → post-audit.

### Load test

```bash
CHALLENGE_ID=<live-challenge-id> CLIENTS=1000 DURATION=30 node scripts/loadtest.mjs
```

Use a **non-scripted** challenge for load tests; do not load-test a live New Eden rehearsal.

---

## Production infrastructure (Azure single VM)

| Item | Value |
|------|-------|
| Resource group | `quanta-rg` |
| VM | `quanta-b2ms` (`Standard_D2s_v3`, 8 GB) |
| Region | `southeastasia` |
| Public IP | `20.205.227.58` |
| Domain | `quanta.devclub.in` (HTTPS via Let's Encrypt) |
| SSH | `ssh -i ~/.ssh/quanta_azure azureuser@20.205.227.58` |
| ACR | `quantadevclub.azurecr.io` |

Stack on VM: `docker compose -f docker-compose.prod.yml` — postgres, redis, migrate, api, gateway, engine, scoring, web, nginx.

Secrets live in `.env.prod` (gitignored, local only). Never commit `.env.prod`, `.acr-github-secrets.env`, or JWT/database passwords.

---

## Deployment — use the CI registry route

**Default for all production deploys:** build images in GitHub Actions, pull on the VM. Do **not** compile on the VM unless registry deploy is impossible (e.g. CI down, emergency hotfix).

### Standard release flow (~5–7 min total)

1. **Merge/push to `main`** — triggers CI + **Publish Docker Images** workflow (~2–3 min).
2. **Wait for Actions** — confirm `.github/workflows/publish-images.yml` succeeded.
3. **Deploy from registry:**

```bash
REGISTRY=quantadevclub.azurecr.io \
IMAGE_TAG=sha-$(git rev-parse --short HEAD) \
./scripts/registry-vm-deploy.sh
```

Or: `pnpm deploy:registry` (with `REGISTRY` and `IMAGE_TAG` exported).

Images published per service:

```
quantadevclub.azurecr.io/quanta-migrate:sha-<commit>
quantadevclub.azurecr.io/quanta-api:sha-<commit>
quantadevclub.azurecr.io/quanta-gateway:sha-<commit>
quantadevclub.azurecr.io/quanta-engine:sha-<commit>
quantadevclub.azurecr.io/quanta-scoring:sha-<commit>
quantadevclub.azurecr.io/quanta-web:sha-<commit>
```

Uses `docker-compose.prod.yml` + `docker-compose.registry.yml` (pull only, no `--build`).

### When CI / registry applies

| Change type | Action |
|-------------|--------|
| App code (api, engine, web, …) | Push to `main` → wait for publish → `registry-vm-deploy.sh` |
| `NEXT_PUBLIC_*` URL change | Update GitHub Actions **variables**, re-run publish (web image rebuild), then registry deploy |
| nginx / compose / `.env.prod` only | `registry-vm-deploy.sh` (no CI rebuild needed) |
| Schema (`packages/db`) | CI rebuild includes `migrate` image; registry deploy runs migrate on `up -d` |

### Fallback: on-VM build (slower, avoid for routine deploys)

Only when CI is unavailable or you need an uncommitted local patch:

```bash
./scripts/deploy-changed.sh              # rebuild only changed services (~3–8 min)
BUILD_ALL=1 SKIP_PROVISION=1 ./scripts/azure-deploy.sh   # full on-VM rebuild (~15–20 min)
```

See `scripts/changed-services.sh` and `scripts/lib/service-graph.sh` for dependency-aware service selection.

### First-time / infra setup

| Script | Purpose |
|--------|---------|
| `./scripts/azure-deploy.sh` | Provision VM + initial deploy |
| `./scripts/setup-ci-registry.sh` | Create ACR, VM docker login |
| `./scripts/setup-github-secrets.sh` | Push ACR creds to GitHub Actions |
| `./scripts/setup-https.sh --remote` | Certbot + TLS for `quanta.devclub.in` |

Full registry docs: `infra/azure/CI-REGISTRY.md`

### Deploy timing reference

| Method | Typical duration |
|--------|------------------|
| **CI publish + registry deploy** (recommended) | **~5–7 min** |
| `deploy-changed.sh` (one backend) | ~3–6 min |
| `deploy-changed.sh` (web only) | ~5–8 min |
| Full on-VM rebuild | ~15–20 min |

---

## CI/CD

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push/PR to `main` | install → build → typecheck → test → db:push → db:seed |
| `publish-images.yml` | Push to `main` | Parallel Docker build → push to ACR |

GitHub Actions variables (repo settings):

- `ACR_LOGIN_SERVER` = `quantadevclub.azurecr.io`
- `NEXT_PUBLIC_API_URL` = `https://quanta.devclub.in`
- `NEXT_PUBLIC_WS_URL` = `wss://quanta.devclub.in`

Secrets: `ACR_USERNAME`, `ACR_PASSWORD`

---

## Docker build notes

- **`Dockerfile.service`** — multi-stage; `SERVICE` build-arg (`api`, `gateway`, `engine`, `scoring`). Layers split: lockfiles → pnpm install → packages → single app source.
- **`Dockerfile.web`** — Next.js standalone output; requires `NEXT_PUBLIC_*` at build time.
- **`Dockerfile.migrate`** — one-shot `db:push` + `db:seed`.
- **`.dockerignore`** — excludes `node_modules`, `.next`, `dist`, `.env*`.

Backend entrypoints: `api` → `dist/server.js`; others → `dist/index.js` (set in compose).

---

## Code conventions for agents

1. **Minimize scope** — match existing patterns; don't refactor unrelated code.
2. **Monorepo imports** — use `@qtp/shared`, `@qtp/db`, etc.; build order follows turbo/pnpm workspace deps.
3. **Shared types/schemas** — add to `packages/shared` or `packages/db/schema.ts`, not duplicated in apps.
4. **Engine logic** — pure matching in `packages/core`; `apps/engine` is I/O, bots, persistence, Redis, timeline.
5. **Eden schedule** — action IDs and ordering live in `packages/shared/src/eden-event.ts`; executor in `apps/engine/src/event-executor.ts`.
6. **API routes** — Fastify plugins under `apps/api/src/routes/`; JWT auth via `@fastify/jwt`.
7. **Web** — App Router (`apps/web/src/app/`), components under `components/`, API client in `lib/api.ts`, realtime via `hooks/useRealtime.ts`.
8. **No secrets in git** — use `.env.example` for templates; production secrets in `.env.prod` only.
9. **Database** — never drop tables/databases without explicit user permission. Schema changes via Drizzle in `packages/db`.
10. **Tests** — run `pnpm test` before large engine changes; use `test-scripts/` for end-to-end acceptance.
11. **Design** — follow `PRODUCT.md` register: dense, calm, tabular numbers, semantic up/down without garish neon.

## Key files to read first

| Task | Start here |
|------|------------|
| Product/design intent | `PRODUCT.md`, `DESIGN.md` |
| New Eden narrative playbook | `event.md` |
| Run event with real players | `docs/new-eden-simulation-guide.md` |
| Manual host controls | `docs/new-eden-host-guide.md` |
| Eden implementation + rollout | `docs/EVENT-IMPLEMENTATION.md` |
| Eden event schedule (source of truth) | `packages/shared/src/eden-event.ts` |
| DB schema | `packages/db/src/schema.ts` |
| Matching engine | `packages/core/src/engine.ts`, `apps/engine/src/runner.ts` |
| Eden timeline + executor | `apps/engine/src/event-timeline.ts`, `event-executor.ts` |
| WS protocol | `packages/shared/src/ws.ts`, `apps/gateway/src/fanout.ts` |
| Auth | `apps/api/src/auth.ts`, `apps/web/src/lib/auth.ts` |
| Challenges lifecycle | `apps/api/src/routes/challenges.ts`, admin UI in `apps/web/src/app/admin/` |
| Admin Eden endpoints | `apps/api/src/routes/admin.ts` |
| Challenge form / playbook preset | `apps/web/src/components/admin/ChallengeForm.tsx` |
| Trader terminal | `apps/web/src/app/challenges/[id]/page.tsx` |
| Deploy / prod | `docker-compose.prod.yml`, `scripts/registry-vm-deploy.sh`, `infra/azure/CI-REGISTRY.md` |
| Security audit | `AUDIT.md` |
| Original event context | `tryst_platform_context.md` |
| E2E black-box tests | `test-scripts/run.mjs`, `test-scripts/README.md` |

## Environment variables

| Variable | Service | Notes |
|----------|---------|-------|
| `DATABASE_URL` | api, engine, gateway, scoring, migrate | Postgres connection string |
| `REDIS_URL` | api, gateway, engine, scoring | Redis connection |
| `JWT_SECRET` | api, gateway | Must match across services |
| `CORS_ORIGINS` | api | Production: `https://quanta.devclub.in` |
| `NEXT_PUBLIC_API_URL` | web (build) | Baked at Docker build |
| `NEXT_PUBLIC_WS_URL` | web (build) | Use `wss://` in production |
| `ENGINE_TICK_MS` | engine | Autonomous price tick (default 1000 ms prod) |
| `ENGINE_MINUTE_MS` | engine | **Game minute** for Eden timeline/carry/loans (default 60000) |
| `ENGINE_FLUSH_MS` | engine | Persistence flush interval |
| `ENGINE_BOT_MS` | engine | Bot action interval |
| `ENGINE_METRICS_MS` | engine | Trader-metrics publish interval |

See `.env.example` for local defaults. Add `ENGINE_MINUTE_MS` to `.env` explicitly when accelerating dry runs.

## What not to do

- Do **not** use on-VM `azure-deploy.sh` full rebuild as the default deploy path — use **CI registry deploy**.
- Do **not** commit `.env.prod`, `.acr-github-secrets.env`, or credentials.
- Do **not** delete production database objects without explicit user approval.
- Do **not** change `NEXT_PUBLIC_*` expecting runtime effect — rebuild and republish the **web** image.
- Do **not** force-push to `main` or amend pushed commits unless the user explicitly asks.
- Do **not** duplicate scripted New Eden operations with manual host actions while `eventScript` is enabled.
- Do **not** renumber or reorder `eden-v1/*` event action IDs for events already in flight.

## Status

Phases 0–5 complete: foundation, real-time trading MVP, challenges/multi-event, scoring/bots/analytics, rate limiting/observability/load test/accessibility, and **New Eden Exchange** (scripted 130-minute tournament with bonds, options, ETF, OTC, auctions, votes, grants, specialized bots, checkpoints, and recovery). Production demo runs on a single Azure VM; Terraform skeleton exists for future AWS ECS scale-out.

See `AUDIT.md` for known security and competitive-integrity findings to address before high-stakes live events.
