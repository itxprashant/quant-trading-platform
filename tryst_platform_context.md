# Tryst26 Quant Trading Challenge — Project Context

> **Generated:** 2026-06-20  
> **Repository:** [the7emerald/tryst26-quant-trading-challenge](https://github.com/the7emerald/tryst26-quant-trading-challenge)  
> **Purpose:** Real-time multi-stock trading simulation for a quant trading competition (Tryst '26 / DevClub)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [Technology Stack](#technology-stack)
4. [Repository Structure](#repository-structure)
5. [Trading Rules & Game Mechanics](#trading-rules--game-mechanics)
6. [Backend (FastAPI)](#backend-fastapi)
7. [Frontend (Next.js)](#frontend-nextjs)
8. [API Reference](#api-reference)
9. [WebSocket Protocol](#websocket-protocol)
10. [Data Model](#data-model)
11. [Redis State & Keys](#redis-state--keys)
12. [Order Matching Engine](#order-matching-engine)
13. [Price Engine](#price-engine)
14. [Authentication & Authorization](#authentication--authorization)
15. [Admin Console](#admin-console)
16. [Mock / Offline Development Mode](#mock--offline-development-mode)
17. [Environment Configuration](#environment-configuration)
18. [Running Locally](#running-locally)
19. [Utility Scripts & Testing](#utility-scripts--testing)
20. [Known TODOs & Future Work](#known-todos--future-work)
21. [Recent Git History](#recent-git-history)
22. [Uncommitted Work in Progress](#uncommitted-work-in-progress)

---

## Executive Summary

This project is a **full-stack real-time trading simulation** where participants compete on PnL (profit and loss) across multiple synthetic stocks (`X1`, `X2`, `X3` by default). Key characteristics:

- **Limit-order book** with price-time priority matching
- **Multi-stock** support with per-stock positions and shared leaderboard
- **Real-time updates** via WebSockets (prices, order book, trades, portfolio)
- **Autonomous price movement** simulating external market forces
- **Admin controls** for price drift, data resets, and user management
- **Horizontal scaling** via Redis (shared state + pub/sub across Gunicorn workers)
- **PostgreSQL** for persistent user accounts, orders, trades, and positions

Production deployment appears to target `https://quant.devclub.in/backend` (referenced in registration scripts).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Frontend (Next.js 16)                           │
│  Pages: /, /login, /dashboard, /dashboard/[symbol], /leaderboard,       │
│         /setprice (admin)                                               │
│  Auth: JWT in localStorage │ WebSocket: ws://host/ws?token=...          │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTP REST + WebSocket
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Backend (FastAPI 2.0, async)                         │
│  Routers: auth, orders, market, portfolio, leaderboard, admin           │
│  Order Engine │ Price Engine │ WebSocket Manager                        │
└───────────────┬─────────────────────────────┬───────────────────────────┘
                │                             │
                ▼                             ▼
┌───────────────────────────┐   ┌─────────────────────────────────────────┐
│   PostgreSQL (asyncpg)    │   │              Redis                       │
│   users, orders, trades,  │   │  prices, price history, drift targets,  │
│   user_positions          │   │  leader lock, ws pub/sub channels       │
└───────────────────────────┘   └─────────────────────────────────────────┘
```

### Cross-Worker WebSocket Flow

1. Any worker publishes broadcast messages to Redis channel `ws:broadcast`
2. User-specific messages go to `ws:user:{user_id}`
3. Each Gunicorn worker runs a pub/sub listener that relays to local WebSocket clients
4. Per-client send queues + dedicated sender tasks prevent blocking

### Autonomous Price Leader Election

Only **one worker** runs the autonomous price background task at a time, using Redis key `autonomous_leader` with 10-second TTL. The leader refreshes the lock and batch-broadcasts price updates for all stocks.

---

## Technology Stack

| Layer | Technology | Version / Notes |
|-------|-----------|-----------------|
| Frontend framework | Next.js (App Router) | 16.1.6 |
| UI | React | 19.2.3 |
| Styling | Tailwind CSS | v4 |
| Charts | Custom SVG (PriceChart) + Recharts dep | — |
| HTTP client | Axios | ^1.13.5 |
| Icons | lucide-react | ^0.563.0 |
| Backend framework | FastAPI | ≥0.109.0 |
| ASGI server | Uvicorn | ≥0.27.0 |
| ORM | SQLAlchemy (async) | ≥2.0.0 |
| Database driver | asyncpg | ≥0.29.0 |
| Cache / pub-sub | Redis | ≥5.0.0 |
| Auth | python-jose (JWT) + passlib/bcrypt | — |
| Validation | Pydantic v2 | ≥2.0.0 |

---

## Repository Structure

```
tryst26-quant-trading-challenge/
├── backend/
│   ├── main.py                 # FastAPI app, lifespan, WebSocket endpoint
│   ├── auth.py                 # JWT utilities, get_current_user
│   ├── database.py             # PostgreSQL async engine, init_db, reset helpers
│   ├── redis_client.py         # Redis connection pool
│   ├── models.py               # SQLAlchemy models
│   ├── schemas.py              # Pydantic request/response schemas
│   ├── stock_config.py         # Env-driven stock & limit configuration
│   ├── order_engine.py         # Matching engine + Redis-backed price engine
│   ├── websocket_manager.py    # Connection manager + Redis pub/sub relay
│   ├── routers/
│   │   ├── auth.py             # Register, login
│   │   ├── orders.py           # Place, list, cancel orders
│   │   ├── market.py           # Stocks, orderbook, prices, history
│   │   ├── portfolio.py        # User portfolio stats
│   │   ├── leaderboard.py      # Rankings by PnL
│   │   └── admin.py            # Price drift, resets, user management
│   ├── register_users.py       # CLI user registration (IPv4 forced)
│   ├── bulk_register.py        # Bulk register A1..L40 → credentials.csv
│   ├── update_password.py      # Admin password update via API
│   ├── load_test.py            # Load testing with virtual users
│   ├── test.py                 # Trader bot simulation
│   ├── test_position_limits.py # Position limit validation tests
│   ├── test_ws.py              # WebSocket smoke test
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── src/
│   │   ├── app/                # Next.js App Router pages
│   │   ├── components/         # UI components
│   │   ├── contexts/           # AuthContext
│   │   └── lib/                # api, websocket, config, mockData
│   ├── package.json
│   └── .env.example
├── patch_main.py               # WebSocket patch utilities (legacy)
├── patch_ws.py
├── patch_ws_main.py
├── TODO                        # Feature backlog
└── PROJECT_CONTEXT.md          # This file
```

---

## Trading Rules & Game Mechanics

| Rule | Value |
|------|-------|
| Stocks | `X1`, `X2`, `X3` (configurable via `STOCKS` env) |
| Initial price | $100.00 per stock (configurable) |
| Starting cash | $0.00 |
| Starting position | 0 shares per stock |
| Position limits | **-50 to +50** per stock per user |
| Max order quantity | 1–50 shares per order |
| Margin | **Allowed** — cash balance can go negative |
| PnL formula | `cash_balance + Σ(position_i × current_price_i)` |
| Matching | Highest bid vs lowest ask; trade price = **ask price** |
| Leaderboard | All users except `admin`, ranked by total PnL |

---

## Backend (FastAPI)

### Application Entry (`main.py`)

- **Title:** Trading Simulation API v2.0.0
- **Lifespan startup:**
  1. Initialize Redis
  2. Initialize prices in Redis (if not present)
  3. Create DB tables + migrate `last_login` column
  4. Start WebSocket broadcaster + Redis pub/sub listener
  5. Start autonomous price background task
- **CORS:** Configurable via `CORS_ORIGINS` (default `*`)
- **Health:** `GET /`, `GET /api/health`
- **WebSocket:** `GET /ws?token=<optional JWT>`

### Routers

| Prefix | File | Auth Required |
|--------|------|---------------|
| `/api/auth` | `routers/auth.py` | No (register/login) |
| `/api/orders` | `routers/orders.py` | Yes |
| `/api/market` | `routers/market.py` | No (public market data) |
| `/api/portfolio` | `routers/portfolio.py` | Yes |
| `/api/leaderboard` | `routers/leaderboard.py` | No |
| `/api/admin` | `routers/admin.py` | Yes + username `admin` |

---

## Frontend (Next.js)

### Routes

| Path | Component | Auth | Description |
|------|-----------|------|-------------|
| `/` | `app/page.tsx` | Optional | Landing page with trading rules |
| `/login` | `app/login/page.tsx` | No | Sign in (registration removed from UI) |
| `/dashboard` | `app/dashboard/page.tsx` | Yes | Stock market overview |
| `/dashboard/[symbol]` | `app/dashboard/[symbol]/page.tsx` | Yes | Full trading UI for one stock |
| `/leaderboard` | `app/leaderboard/page.tsx` | No | Live PnL rankings (polls every 2s) |
| `/setprice` | `app/setprice/page.tsx` | Admin | Price drift, resets, user management |

### Key Components

| Component | Purpose |
|-----------|---------|
| `PriceChart` | SVG bar chart of price history + live WebSocket updates |
| `OrderBook` | Bid/ask ladder with depth visualization |
| `TradingPanel` | Buy/sell form with quick quantity buttons |
| `TraderStats` | Cash, positions, PnL with live portfolio updates |
| `ProtectedRoute` | Redirects unauthenticated users to `/login` |
| `MockDevBanner` | Dev navigation banner when `USE_MOCK=true` |

### State Management

- **Auth:** React Context (`AuthContext`) — JWT + user stored in `localStorage`
- **Real-time:** Singleton `wsClient` in `lib/websocket.ts`
- **API:** Centralized Axios instance in `lib/api.ts` with auth interceptor

### Trading Dashboard Layout (`/dashboard/[symbol]`)

```
┌──────────────────────────────┬──────────────┐
│         PriceChart           │ TraderStats  │
│         (8 cols)             │   (4 cols)   │
├──────────────┬───────────────┴──────────────┤
│  OrderBook   │       TradingPanel           │
│  (4 cols)    │         (8 cols)             │
└──────────────┴──────────────────────────────┘
```

---

## API Reference

### Authentication

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| POST | `/api/auth/register` | `{ username, password }` | `UserResponse` |
| POST | `/api/auth/login` | Form: `username`, `password` | `{ access_token, token_type }` |
| POST | `/api/auth/login/json` | `{ username, password }` | `{ access_token, token_type }` |

### Orders (Bearer token required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/orders` | Place order: `{ stock_symbol, order_type, quantity, price }` |
| GET | `/api/orders` | List user's orders (`?stock_symbol=` optional) |
| GET | `/api/orders/open` | List open/partial orders |
| DELETE | `/api/orders/{order_id}` | Cancel order |

### Market (public)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/market/stocks` | All stocks + current prices |
| GET | `/api/market/{symbol}/orderbook` | Aggregated bid/ask book |
| GET | `/api/market/{symbol}/current-price` | Current price |
| GET | `/api/market/{symbol}/price-history?limit=100` | Historical prices from Redis |

### Portfolio (Bearer token required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/portfolio` | `{ cash_balance, positions, current_prices, pnl }` |

### Leaderboard (public)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/leaderboard` | Ranked entries + current prices |

### Admin (Bearer token + username `admin`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/admin/setprice` | `{ stock_symbol, target_price, speed }` — set price drift |
| GET | `/api/admin/setprice/status` | Drift status for all stocks |
| POST | `/api/admin/reset/orders` | Truncate orders (+ cascaded trades) |
| POST | `/api/admin/reset/trades` | Truncate trades |
| POST | `/api/admin/reset/positions` | Truncate user_positions |
| POST | `/api/admin/reset/balances` | Reset all cash to $0 |
| POST | `/api/admin/reset/prices` | Reset Redis prices to initial config |
| POST | `/api/admin/reset/all` | Full trading state reset |
| GET | `/api/admin/users` | List all users with last_login |
| DELETE | `/api/admin/users/all` | Delete all users except admin |
| DELETE | `/api/admin/users/by-name/{username}` | Delete specific user |
| DELETE | `/api/admin/users/before?before=ISO` | Delete inactive users |
| PUT | `/api/admin/users/{username}/password` | Update user password |

---

## WebSocket Protocol

**Endpoint:** `ws://<host>/ws?token=<JWT>` (token optional for public price feeds)

### Client → Server

| Message | Purpose |
|---------|---------|
| `"ping"` | Keep-alive (server responds with `"pong"`) |
| `"pong"` | Response to server ping |

### Server → Client

All structured messages are JSON:

```json
{
  "type": "<message_type>",
  "data": { ... }
}
```

| Type | Data Fields | Trigger |
|------|-------------|---------|
| `price_update` | `stock_symbol`, `price`, `price_change`, `timestamp` | Trade or autonomous tick |
| `prices_batch_update` | `updates: { symbol: { price, price_change } }`, `timestamp` | Autonomous batch (decomposed client-side) |
| `orderbook_update` | `stock_symbol`, `bids[]`, `asks[]` | Order placed/cancelled/trade |
| `trade` | `stock_symbol`, `id`, `quantity`, `price`, `timestamp` | Trade execution |
| `portfolio_update` | `cash_balance`, `positions`, `current_prices`, `pnl` | Trade affecting user |
| `order_update` | order fields | (Defined, user-targeted) |

### Connection Behavior

- Initial connection sends one `price_update` per stock
- Server sends `"ping"` every 30s on idle; client sends ping every 25s
- Client reconnects with exponential backoff (max 10 attempts)
- Per-client send queue (max 100 messages); overflow triggers disconnect

---

## Data Model

### PostgreSQL Tables

#### `users`

| Column | Type | Notes |
|--------|------|-------|
| id | Integer PK | — |
| username | String UNIQUE | — |
| password_hash | String | bcrypt |
| cash_balance | Float | Default 0; can be negative |
| created_at | DateTime | — |
| last_login | DateTime | Updated on login |

#### `user_positions`

| Column | Type | Notes |
|--------|------|-------|
| id | Integer PK | — |
| user_id | FK → users | — |
| stock_symbol | String | — |
| position | Integer | -50 to +50 |
| **Unique** | `(user_id, stock_symbol)` | — |

#### `orders`

| Column | Type | Notes |
|--------|------|-------|
| id | Integer PK | — |
| user_id | FK → users | — |
| stock_symbol | String | — |
| order_type | Enum | `buy` / `sell` |
| quantity | Integer | Original qty |
| remaining_quantity | Integer | Unfilled qty |
| price | Float | Limit price |
| status | Enum | `open`, `filled`, `partially_filled`, `cancelled` |
| created_at | DateTime | Price-time priority |

#### `trades`

| Column | Type | Notes |
|--------|------|-------|
| id | Integer PK | — |
| stock_symbol | String | — |
| buy_order_id, sell_order_id | FK → orders | — |
| buyer_id, seller_id | FK → users | — |
| quantity | Integer | — |
| price | Float | Execution price |
| executed_at | DateTime | — |

> **Note:** Price history was moved from PostgreSQL to Redis sorted sets.

---

## Redis State & Keys

| Key Pattern | Type | Purpose |
|-------------|------|---------|
| `price:{symbol}` | String (float) | Current price |
| `price_dir:{symbol}` | String | Legacy direction flag |
| `price_history:{symbol}` | Sorted Set | JSON entries, score = epoch timestamp (max 500) |
| `drift_target:{symbol}` | String (float) | Admin-set target price |
| `drift_speed:{symbol}` | String (int 1–10) | Drift speed |
| `autonomous_leader` | String | Leader election lock (TTL 10s) |
| `ws:broadcast` | Pub/Sub channel | Global WebSocket broadcasts |
| `ws:user:{user_id}` | Pub/Sub channel | User-specific messages |

**Default Redis URL:** `redis://localhost:6379/0`

---

## Order Matching Engine

Located in `backend/order_engine.py`.

### Matching Rules

1. **Buy order** matches against lowest ask where `ask.price <= buy.price`
2. **Sell order** matches against highest bid where `bid.price >= sell.price`
3. **Trade price:** Ask price when buyer initiates; sell price when seller initiates
4. **Priority:** Best price first, then FIFO by `created_at`
5. **Partial fills** supported; status becomes `partially_filled`
6. **Position limits** enforced during matching — orders auto-cancelled if limit hit

### Trade Side Effects

On execution:
1. Update buyer/seller cash balances
2. Update positions
3. Update order remaining quantities and statuses
4. Create trade record
5. Update price via delta formula (see below)
6. Parallel broadcast: price, trade, orderbook, portfolio (buyer + seller)

---

## Price Engine

### Trade-Driven Price Update

```
delta = (trade_price - current_price) × trade_quantity × 0.9 / 50
new_price = max(0.01, current_price + delta)
```

### Autonomous Price Movement

- Runs every `AUTONOMOUS_PRICE_MIN_INTERVAL`–`AUTONOMOUS_PRICE_MAX_INTERVAL` seconds (default 0.1–2s)
- **Random walk:** ±`AUTONOMOUS_MAX_CHANGE` (default $0.50)
- **Drift mode** (admin-set): Biased movement toward target at speed 1–10
  - Speed 1 ≈ $0.05/tick; Speed 10 ≈ $1.50/tick
  - Clears drift keys when target reached

---

## Authentication & Authorization

- **JWT** with HS256, default 1440-minute expiry
- Token payload: `{ sub: username, user_id: id, exp }`
- Password hashing: bcrypt via passlib
- **Admin role:** Hardcoded check for `username == "admin"` (no separate role column)
- Frontend stores token in `localStorage`; Axios attaches `Authorization: Bearer`
- 401 responses redirect to `/login` (except in mock mode)

---

## Admin Console

**URL:** `/setprice`

Features:
1. **Market Manipulation** — Set drift target price and speed (1–10) per stock
2. **Data Reset** — Granular or full reset of orders, trades, positions, balances, prices
3. **User Management** — List users, delete by name, delete by last_login cutoff, delete all

Access control:
- Backend: `require_admin` dependency on all `/api/admin/*` routes
- Frontend: Redirects non-admin to `/dashboard`; mock mode bypasses for UI preview

---

## Mock / Offline Development Mode

Enable in `frontend/src/lib/config.ts`:

```typescript
export const USE_MOCK = true;
```

When enabled:
- All API calls return hardcoded data from `frontend/src/lib/mockData.ts`
- Auto-login as `demo_trader` without backend
- Login with username `admin` previews admin panel
- WebSocket connection skipped
- `MockDevBanner` shows quick navigation links

Mock stocks: X1 ($102.45), X2 ($98.72), X3 ($105.18)

---

## Environment Configuration

### Backend (`.env`)

```env
SECRET_KEY=
ALGORITHM=HS256
ACCESS_TOKEN_EXPIRE_MINUTES=1440

DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/trading
REDIS_URL=redis://localhost:6379/0

HOST=0.0.0.0
PORT=8000
CORS_ORIGINS=*

STOCKS=X1,X2,X3
DEFAULT_INITIAL_PRICE=100.0
INITIAL_PRICES=X1:100.0,X2:100.0,X3:100.0
MIN_POSITION=-50
MAX_POSITION=50
AUTONOMOUS_PRICE_MIN_INTERVAL=0.1
AUTONOMOUS_PRICE_MAX_INTERVAL=2
AUTONOMOUS_MAX_CHANGE=0.5
```

### Frontend (`.env`)

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_WS_URL=ws://localhost:8000
```

---

## Running Locally

### Prerequisites

- Node.js 20+
- Python 3.10+
- PostgreSQL
- Redis

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # configure DATABASE_URL, SECRET_KEY, REDIS_URL
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### Frontend

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
# → http://localhost:3000
```

### Production-style (multi-worker)

Run with Gunicorn + Uvicorn workers; Redis pub/sub ensures WebSocket broadcasts reach all clients regardless of which worker holds the connection.

---

## Utility Scripts & Testing

| Script | Purpose |
|--------|---------|
| `register_users.py` | Register users via API (interactive, single, or file bulk) |
| `bulk_register.py` | Generate A1..L40 users → `credentials.csv` |
| `update_password.py` | Admin password updates via API |
| `load_test.py` | Virtual users: register, login, poll, WebSocket, trade |
| `test.py` | Automated trader bots + final leaderboard |
| `test_position_limits.py` | Validates -50/+50 position enforcement |
| `test_ws.py` | WebSocket connectivity smoke test |
| `test_script.py` | General async test harness |

Default production base URL in scripts: `https://quant.devclub.in/backend`  
Scripts force **IPv4** to avoid Cloudflare IPv6 SSL handshake issues.

---

## Known TODOs & Future Work

From `TODO` file at repo root:

1. **Graph** — Price chart improvements
2. **Stock movement** — Enhanced autonomous/drift behavior
3. **Number of stocks** — Support for more configurable stocks

---

## Recent Git History

| Commit | Message |
|--------|---------|
| `336b605` | update password scripts |
| `3d674c8` | remove admin from leaderboard |
| `8d02429` | testing and registering scripts |
| `42d6afd` | register fix |
| `25de7af` | remove register page |
| `1c67bd8` | websocket patch |
| `29186bc` | remove reg and theme toggle UI |
| `95b6cd2` | login delete fix |
| `205a78e` | track user login time and delete users |
| `98f76cd` | add ui for admin reset options |
| `d474751` | redis persist |
| `d453eef` | graph issues fix |

**Default branch:** `main`  
**Remote:** `origin` → `https://github.com/the7emerald/tryst26-quant-trading-challenge`

---

## Uncommitted Work in Progress

As of documentation generation, the following local changes exist (not yet committed):

| File | Change |
|------|--------|
| `frontend/src/lib/config.ts` | **New** — `USE_MOCK` flag |
| `frontend/src/lib/mockData.ts` | **New** — Mock API responses |
| `frontend/src/lib/api.ts` | Mock mode branching for all API calls |
| `frontend/src/contexts/AuthContext.tsx` | Mock auto-login, skip WebSocket in mock |
| `frontend/src/components/MockDevBanner.tsx` | **New** — Dev navigation banner |
| `frontend/src/app/providers.tsx` | Renders MockDevBanner |
| `frontend/src/app/setprice/page.tsx` | Mock mode admin preview bypass |
| `frontend/package-lock.json` | Dependency lock updates |

This work enables **frontend-only development** without running the backend stack.

---

## Design Decisions Summary

| Decision | Rationale |
|----------|-----------|
| Redis for prices | Share state across Gunicorn workers; fast reads/writes |
| Redis pub/sub for WS | Cross-worker broadcast without sticky sessions |
| PostgreSQL for orders | ACID guarantees for matching engine |
| Per-stock positions table | Clean multi-stock model vs single position column |
| Margin allowed | Enables short selling within position limits |
| Admin by username | Simple competition setup without RBAC complexity |
| No registration UI | Users pre-registered via scripts for event control |
| Price history in Redis | Avoid DB writes on every tick; 500-entry cap per stock |

---

*End of project context document.*
