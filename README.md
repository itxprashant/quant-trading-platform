# Quanta — Quant Trading Challenge Platform

A polished, customizable platform for running competitive quantitative trading
challenges (market making, directional PnL, and admin-configurable formats),
designed for thousands of concurrent users.

This is a ground-up rebuild of the Tryst '26 concept (see `PROJECT_CONTEXT.md`),
re-architected for scale and built to the design bar described in `DESIGN.md`.

## Architecture

```
Browser ── REST ──> API (Fastify)            ── Postgres (durable state)
   │                                           ── Redis (commands/events/state)
   └── WS ──> Gateway (stateless, fan-out) <── Redis pub/sub
                          ▲
   Matching Engine (single-writer per challenge) ──> Redis streams + Postgres
   Scoring Worker (consumes events) ───────────────> Redis leaderboard + Postgres
```

- **Single-writer matching engine per challenge.** Each challenge runs an
  isolated, in-memory, deterministic order book (price-time priority). No locks,
  correct under load, and naturally multi-event.
- **Stateless WebSocket gateways** subscribe to Redis pub/sub and fan out to
  clients; scale horizontally behind the load balancer. Slow consumers are
  dropped on backpressure (bounded send buffer).
- **Leader election** (Redis lock) guarantees exactly one engine owns a
  challenge across a pool of engine instances.
- **Autonomous agents.** Per-challenge market-maker bots quote two-sided
  liquidity and noise traders generate taker flow, so markets stay alive.
- **Pluggable scoring.** Directional PnL or market-making metrics (spread
  capture, quote uptime, inventory penalty) computed from engine-tracked stats.
- **Scale hardening.** Redis token-bucket rate limiting on the API, Prometheus
  metrics on API (`/api/metrics`) and gateway (`/metrics`), and ECS
  target-tracking autoscaling (CPU + active WS connections per task).

## Monorepo layout

```
apps/
  web/        Next.js frontend (trader + admin)
  api/        Fastify REST API (auth, challenges, orders, market, leaderboard)
  engine/     Matching engine service (per-challenge runners)
  gateway/    WebSocket fan-out service
  scoring/    Leaderboard / scoring worker
packages/
  shared/     Domain types, zod schemas, event/protocol/key definitions
  core/       Pure matching engine + scoring (unit-tested)
  bus/        Redis helpers (streams, pub/sub, hot state)
  db/         Drizzle ORM schema + client + migrations + seed
  config/     Shared tsconfig presets
infra/
  terraform/  AWS (ECS/Aurora/ElastiCache) skeleton
  docker/     Service + web Dockerfiles
```

## Local development

Prerequisites: Node 20+, pnpm 11+, Docker.

```bash
pnpm install
cp .env.example .env            # defaults target the docker-compose services
pnpm infra:up                   # Postgres + Redis
pnpm db:push                    # create schema
pnpm db:seed                    # admin + traders + sample challenges
pnpm dev                        # all apps via turbo
```

Then open http://localhost:3000.

Seeded logins: `admin / admin1234`, `trader1..8 / trader1234`.

> On some Linux kernels the Docker userland proxy resets Postgres connections;
> `docker-compose.override.yml` switches the dev databases to host networking to
> avoid this. Delete it where the default bridge works.

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Run every app in watch mode (turbo) |
| `pnpm build` | Build all packages and apps |
| `pnpm typecheck` | Type-check the whole workspace |
| `pnpm test` | Run unit tests (matching engine, etc.) |
| `pnpm db:push` / `db:seed` | Apply schema / seed data |
| `pnpm infra:up` / `infra:down` | Start / stop Postgres + Redis |

## Load testing

A dependency-free harness (Node 22+) drives concurrent WebSocket clients plus an
order-placing pool and reports throughput, latency percentiles, and error rates:

```bash
CHALLENGE_ID=<live-challenge-id> CLIENTS=1000 DURATION=30 \
  node scripts/loadtest.mjs
```

Tunables (env): `CLIENTS`, `ORDER_CLIENTS`, `ORDER_RATE`, `DURATION`, `USERS`,
`API_URL`, `WS_URL`. A local run of 300 sockets sustained ~45k msgs/s fan-out
with first-message p99 ≈ 66 ms and order p99 ≈ 34 ms.

## Status

- **Phase 0 — Foundation:** monorepo, design system, auth/RBAC, schema, IaC + CI.
- **Phase 1 — Real-time trading MVP:** matching engine, WS gateway, scoring,
  trader dashboard, live leaderboard.
- **Phase 2 — Challenges & multi-event:** config-driven challenges, lifecycle
  (draft → scheduled → live → paused → ended) with auto start/end, admin
  builder, enrollment, per-challenge engine isolation.
- **Phase 3 — Scoring & bots:** pluggable directional / market-making scoring,
  autonomous MM + noise bots, participant analytics (spread capture, quote
  uptime, realized PnL, volume).
- **Phase 4 — Scale hardening:** rate limiting, gateway backpressure,
  Prometheus metrics, ECS autoscaling, load-test harness, accessibility pass.
