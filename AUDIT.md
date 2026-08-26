# Quanta — Bug & Security Audit

**Date:** 2026-08-04
**Commit audited:** `6652c98` (main)
**Scope:** `apps/` (api, engine, gateway, scoring, web), `packages/` (core, bus, db, shared), `infra/`, `scripts/`, `.github/workflows/`
**Out of scope:** `dashboard-ref/` (untracked, unrelated Next.js app — see L-13)

Method: full manual review of all 12.3k lines of first-party TypeScript, plus infrastructure and CI configuration. Two findings (C-2, H-5) were confirmed by executing the compiled matching engine directly; the transcript is in [Appendix A](#appendix-a--exploit-verification).

---

## Executive summary

| Severity | Count |
|----------|-------|
| Critical | 4 |
| High | 9 |
| Medium | 14 |
| Low | 13 |
| **Total** | **40** |

The platform is well structured — clean service boundaries, Zod validation at every API entry point, parameterised queries throughout (no SQL injection found), no `dangerouslySetInnerHTML` or `eval` anywhere in the frontend, bcrypt password hashing, and an atomic Lua-scripted rate limiter. The problems are concentrated in three places:

1. **Authentication trust anchors.** A default administrator account with a password published in the repository is seeded into production on every deploy, and there is no way to change any password through the application. Both the API and the gateway silently fall back to a hardcoded JWT signing secret if the environment variable is absent.

2. **Competitive integrity of the matching engine.** A trader can match against their own resting order. Because a trade drags the reference price 90% of the way toward the print, and portfolios are marked to that price, one self-matched 1-lot order moved a test account's PnL from $1,000 to $437,590. The same path inflates `spreadCapture`, which is the dominant term in market-making scoring. Separately, the `allowMargin: false` setting is accepted by the admin UI and stored in the database but is never read by the engine, so no solvency check exists anywhere in the order path.

3. **State durability around the engine.** The engine holds cash, positions, and order books purely in memory and rehydrates only prices and loan debt on start. Any restart, deploy, or lock handover resets every trader to their starting balance with no positions — and the persistence layer then writes that reset state back over Postgres. Commands published while the engine is down are skipped permanently because the command stream is read from `$` rather than through a consumer group.

For an event running in front of live participants, C-1 through C-4 and H-1 through H-4 should all be closed before the next competition.

---

## Critical

### C-1 — Default admin account with a public password is seeded into production

**Location:** `packages/db/src/seed.ts:20-38`, `infra/docker/Dockerfile.migrate:26`, `docker-compose.prod.yml` (`migrate` service)

The `migrate` container runs `pnpm db:push && pnpm db:seed` on every `docker compose up -d`, and the seed unconditionally inserts an administrator:

```20:38:packages/db/src/seed.ts
  const [admin] = await db
    .insert(users)
    .values({
      username: "admin",
      displayName: "Administrator",
      email: "admin@quanta.local",
      passwordHash: hash("admin1234"),
      role: "admin",
    })
```

Eight trader accounts follow with the password `trader1234`. Both passwords are printed by the seed script, documented in `AGENTS.md`, and committed to a public GitHub repository.

**Impact:** Anyone who reads the repository can log in to `https://quanta.devclub.in` as an administrator. Admin capability includes setting prices directly, moving fair value, issuing loans and grants to arbitrary users, creating OTC deals, posting news, deleting all trading data for a challenge, and reading the full user list. Because the account was created on the first production deploy, `onConflictDoNothing` will not overwrite it — but it will not fix it either.

**Compounding factor:** the API exposes no password-change or password-reset endpoint (`apps/api/src/routes/auth.ts` has only `register`, `login`, `me`). Even a diligent operator cannot rotate this credential through the product; it requires a direct `UPDATE` against the `users` table.

**Fix:**
1. Immediately rotate the production admin password (direct SQL `UPDATE users SET password_hash = ... WHERE username = 'admin'` with a fresh bcrypt hash) and verify no unexpected admin rows exist: `SELECT id, username, created_at, last_login_at FROM users WHERE role = 'admin'`.
2. Gate seeding behind an explicit opt-in — `if (process.env.SEED_DEMO_DATA !== "true") return;` — and remove `db:seed` from the production `migrate` command.
3. When demo seeding is enabled, read the passwords from environment variables and fail if they are unset.
4. Add `POST /api/auth/password` (authenticated, requires current password) and an admin-initiated reset.

---

### C-2 — Self-matching enables arbitrary price, PnL, and score manipulation

**Location:** `packages/core/src/engine.ts:510-567` (`placeOrder` match loop)

The match loop never compares the incoming order's `userId` against the resting order's `userId`. A trader can therefore rest a limit order at any price and immediately take it themselves. Three separate mechanisms amplify this:

- `updatePriceFromTrade` (`engine.ts:774-792`) moves the symbol's reference price 90% of the distance to the trade price on every print, with no price band, collar, or reference-to-market sanity check. `zPlaceOrderInput` only requires `price` to be positive.
- `portfolioOf` marks all inventory to that manipulated price, and `computeScore` for `directional` challenges is `pnl × pnlWeight`.
- `recordSpreadCapture` (`engine.ts:760-772`) credits the maker side of the wash trade, so the attacker also inflates the primary market-making score component.

**Verified impact** (full transcript in Appendix A): an attacker holding 49 units, after a single self-matched 1-lot order at price 10000:

| Metric | Before | After |
|--------|--------|-------|
| Reference price | 100 | 9,010 |
| Attacker PnL | $1,000 | $437,590 |
| `spreadCapture` | 0 | 9,900 |

This is a complete compromise of the leaderboard for both challenge types, achievable by any enrolled participant with two API calls. It also corrupts every other participant's mark-to-market and can trigger spurious margin calls and forced liquidations across the field.

**Fix:**
1. Reject self-matches in the match loop. Either skip the level (`if (best.userId === cmd.userId) break;` — simplest, prevents the fill) or cancel-newest per exchange convention. Extend `packages/core/src/engine.test.ts` with a regression test.
2. Add a price collar: reject limit orders more than N% away from the current reference price or fair value, and clamp `updatePriceFromTrade` so a single print cannot move the mark beyond a configured band.
3. Consider marking positions to the book mid (already computed via `midFromBook`) rather than last trade, which is far harder to move with a 1-lot.

---

### C-3 — Engine restart or failover resets every trader's cash and positions, then overwrites Postgres

**Location:** `apps/engine/src/runner.ts:154-194` (`start`), `apps/engine/src/persistence.ts:110-152` (`flush`)

`ChallengeEngine` keeps accounts entirely in memory and lazily creates them with `startingCash` and no positions (`engine.ts:860-878`). `ChallengeRunner.start()` rehydrates only three things from durable storage: last price, fair value, and aggregate loan debt. It never loads `challenge_participants.cash` or the `positions` rows.

Consequently, whenever a runner is (re)created — process restart, container redeploy, `refreshLocks` losing the Redis lock for one cycle, a challenge briefly leaving `live` status via pause/resume, or another engine replica claiming the challenge — every trader silently reverts to their starting balance with a flat book. Within 250 ms (`ENGINE_FLUSH_MS`), `Persistence.flush()` upserts that reset state over the real balances in Postgres, so the durable record is destroyed too. Resting orders in the DB are also orphaned: the in-memory book is empty but the rows remain `open`.

**Impact:** total, unrecoverable loss of competition state from any routine deploy or transient failure. This is the highest-consequence non-security bug in the codebase.

**Fix:** add a rehydration step to `ChallengeRunner.start()` that loads participants (cash, loanDebt) and positions (qty, avgPrice) into the engine before the command loop starts, and replays open orders back onto the book. `ChallengeEngine` needs a `restoreAccount(userId, {cash, positions})` entry point alongside the existing `restorePrice` / `setLoanDebt`. Until that lands, treat every engine restart during a live event as requiring a manual state rebuild.

---

### C-4 — Hardcoded fallback JWT secret in both API and gateway

**Location:** `apps/api/src/env.ts:3-6`, `apps/gateway/src/env.ts:6-8`

```3:6:apps/api/src/env.ts
  jwtSecret:
    process.env.JWT_SECRET ??
    "dev-only-change-me-0000000000000000000000000000000000000000",
```

Both services fall back to the same literal, which is committed to a public repository and duplicated in `.env.example`. Nothing validates secret length, entropy, or that the value differs from the default. `docker-compose.prod.yml` guards the API with `${JWT_SECRET:?set JWT_SECRET}` but passes the gateway a bare `${JWT_SECRET}`, so the two can diverge.

**Impact:** any deployment path that misses the environment variable — running `node dist/server.js` directly, a systemd unit, a Kubernetes manifest, a developer pointing a local API at the production database — signs and accepts tokens under a publicly known key. Forging `{"sub": "<any-uuid>", "role": "admin"}` is then trivial and grants full administrative access.

**Fix:** remove both defaults and fail fast at startup:

```ts
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be set to a random value of at least 32 characters");
}
```

Also add the `:?` guard to the gateway's compose entry so the two services can never disagree, and rotate the production secret (this invalidates all live sessions — do it between events).

---

## High

### H-1 — Rate limiting keyed on a client-controlled header

**Location:** `apps/api/src/ratelimit.ts:22-27`

```22:27:apps/api/src/ratelimit.ts
    const identity =
      by === "user" && req.user?.sub
        ? req.user.sub
        : (req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ??
          req.ip);
```

The code takes the *first* element of `X-Forwarded-For`, which is the value supplied by the client. Fastify's `trustProxy` is not configured, so `req.ip` is the nginx container address and would be useless as a fallback anyway.

**Impact:** the login limiter (`10 / 60s`, the only brute-force control on `/api/auth/login` and `/register`) is bypassed entirely by varying the header per request — unlimited credential stuffing against a user base whose seeded passwords are `trader1234`. The inverse also holds: with the header absent, every user shares one bucket keyed on the nginx IP, so a single client can lock all traders out of authentication.

**Fix:** set `Fastify({ trustProxy: true })` (nginx already appends `X-Forwarded-For` correctly with `$proxy_add_x_forwarded_for`) and use `req.ip` exclusively. Add per-username throttling and exponential backoff on repeated login failures.

---

### H-2 — Gateway accepts anonymous connections and unbounded, unvalidated subscriptions

**Location:** `apps/gateway/src/index.ts:166-178`, `188-197`, `241-281`

`authenticate()` returns `null` when the token is missing or invalid, and the connection handler accepts the socket anyway with `userId: null`. `subscribe()` then takes `msg.challengeId` straight off the wire with no shape validation, no existence check, no `draft` check, and no participation check, and calls `fanout.add()` — which issues a real Redis `SUBSCRIBE` per distinct string.

**Impact:**
- **Denial of service.** One anonymous socket can send millions of `{"type":"subscribe","challengeId":"<random>"}` messages, each adding an entry to the `registry` map, the `Fanout.refcount` map, and Redis's subscription table. There is no per-connection subscription cap, no per-IP connection cap, and no message rate limit. Gateway and Redis memory both grow without bound.
- **Information disclosure.** Any unauthenticated client can subscribe to any challenge, including drafts and challenges they have not joined, and receive the full `target: "all"` feed: prices, books, trade prints, news, fair values, and leaderboards. Per-user messages are correctly filtered by `userId`, so private data (portfolio, alerts, OTC offers) is not exposed.

**Fix:** close sockets with an invalid or absent token (`ws.close(4401)`); validate `challengeId` against the UUID pattern; verify the challenge exists and is not `draft`; cap subscriptions per connection (2–3 is plenty) and connections per IP; add a token-bucket on inbound messages.

---

### H-3 — Commands issued while the engine is down are silently discarded

**Location:** `apps/engine/src/runner.ts:68` (`lastId = "$"`), `apps/engine/src/runner.ts:243-266`, `packages/bus/src/streams.ts:69-96`

The runner reads the command stream with a plain `XREAD` starting from `$` (new messages only), despite `AGENTS.md` documenting a consumer group. Every runner construction resets `lastId` to `$`.

**Impact:** orders, cancels, loan issuances, OTC settlements, and admin fair-value commands enqueued during any engine gap are dropped permanently. The API has already returned `202 Accepted` and written an `open` row to the `orders` table, so the trader sees a working order that will never match or cancel. Combined with C-3, a deploy during a live event both resets balances and loses in-flight commands.

**Fix:** switch to `XREADGROUP` with a per-challenge consumer group and `XACK` after processing (the helpers already exist for the event stream in `streams.ts:99-145`), and reclaim pending entries with `XAUTOCLAIM` on start. Reconcile `open` orders in the DB against the engine's book at startup.

---

### H-4 — Admin "reset challenge" is a no-op against a running engine

**Location:** `apps/api/src/routes/admin.ts:665-720`

The handler deletes trades, orders, positions, news, loans, bonds, OTC offers, options, auctions, votes, and grants from Postgres, clears Redis, and then signals the engine:

```717:717:apps/api/src/routes/admin.ts
    await app.redis.publish(`qtp:control:${challengeId}`, "reset");
```

No service subscribes to `qtp:control:*` — a repository-wide search returns this single line. The live runner therefore keeps every account balance, position, order book, and metric in memory, and `Persistence.flush()` rewrites the deleted rows within 250 ms. The reset also leaves `challenge_participants.cash` untouched (only `loanDebt` is zeroed), so even if the engine did reload, traders would resume with their pre-reset cash against a wiped position book.

**Impact:** an operator resetting between heats believes state is clean when it is not. PnL carries over, positions reappear, and the leaderboard is wrong for the entire following session.

**Fix:** implement the control-channel subscriber in `ChallengeRunner` (rebuild the engine, clear books/accounts/metrics, restart from config), or have the reset flip the challenge out of `live` so the runner stops, then clear state, then restore. Also reset `participants.cash` to `startingCash` and delete `score_snapshots` for the challenge.

---

### H-5 — `allowMargin` is dead configuration; no solvency check exists in the order path

**Location:** `packages/core/src/engine.ts:40` (declared), `packages/shared/src/schemas.ts:219`, `apps/web/src/components/admin/ChallengeForm.tsx:270`

`allowMargin` is defined in the Zod schema, exposed as a dropdown in the admin challenge builder, persisted to the database, and threaded into `EngineConfig` — and then never read. `placeOrder` validates symbol, quantity, order type, price presence, and position capacity, but never cash. `applyFill` simply does `acct.cash -= price * deltaQty`.

**Verified** (Appendix A): with `allowMargin: false` and $1,000 starting cash, a market buy of 50 units at $100 fills completely and leaves the account at **−$4,000**.

**Impact:** an operator who disables margin gets no enforcement and no error — a silent configuration failure. Every challenge is effectively infinite-leverage. Off-book paths are worse still: `MarketsManager.purchaseBond` and `etfTrade` call `adjustCash` with no balance check at all.

**Fix:** enforce the flag in the match loop — compute post-fill free cash via the existing `margin.freeCash()` helper and stop filling when `allowMargin` is false and the fill would take it negative. Apply the same guard to bond purchases and ETF creates. Remove the option from the admin UI until it is enforced.

---

### H-6 — Unfunded and unbounded off-book settlement (bonds, ETF create/redeem)

**Location:** `apps/engine/src/markets-manager.ts:231-332`, `packages/shared/src/schemas.ts:523-536`

- `zPurchaseBondInput.quantity` and `zEtfTradeInput.quantity` are `int().positive()` with **no upper bound**, unlike order quantity which is capped by `maxOrderQuantity`.
- `purchaseBond` debits `tpl.price * quantity` with no cash check. The only cap is `maxPerUser`.
- Bond face value is added to `bondValue` and counted in PnL (`runner.ts:1079-1080`) while cash falls by the purchase price. The seeded `Treasury 5Y` bond costs 950 and has face value 1000, so each unit is an instant, riskless **+$50 of PnL** with no market risk and no maturity or redemption to ever reverse it.
- `etfTrade` with `action: "create"` mints units at NAV without taking the basket components from the trader — it is just an unbounded, uncollateralised purchase at NAV, bypassing `maxOrderQuantity` and the position caps. When the ETF's book price exceeds NAV (which the config allows, since ETFs are freely tradeable), this is a riskless arbitrage of unlimited size, rate-limited only to 10 requests per 10 seconds.

**Fix:** add `.max()` bounds to both schemas, enforce a cash check before every `adjustCash` debit, require basket delivery on ETF create (and return the basket on redeem), and either give bonds a maturity that removes `bondValue` or stop counting face value in PnL before maturity.

---

### H-7 — Persistence drops trades and order updates when a flush fails

**Location:** `apps/engine/src/persistence.ts:76-158`

`flush()` drains `tradeBuf` and `pendingOrders` into locals and clears the buffers *before* opening the transaction. The `catch` block re-queues only `affectedUsers`:

```154:158:apps/engine/src/persistence.ts
    } catch (err) {
      // Re-queue affected users so the next flush retries their sync.
      for (const u of users) this.affectedUsers.add(u);
      throw err;
    }
```

**Impact:** one transient database error (connection reset, deadlock, brief failover) permanently loses that batch of trade records and order status transitions. Cash and positions eventually re-sync because users are retried, but the `trades` table — the audit trail used for dispute resolution and post-event analysis — develops silent holes, and orders remain stuck in stale statuses. The `throw` also propagates into an unhandled rejection inside the `setInterval` callback in `runner.ts:208-212`, where only a `.catch` on `flush()` saves it.

**Fix:** re-queue `tradesToInsert` and `orderUpdates` alongside the users, with a bounded retry/backoff and a dead-letter log if a batch fails repeatedly.

---

### H-8 — Leaderboard values options, ETFs, and bonds at zero

**Location:** `apps/scoring/src/index.ts:32-79`

The scoring worker builds `priceMap` from `challenge.config.symbols` only. It then values every position row with `priceMap.get(p.symbol) ?? 0`. Option series and ETFs are listed dynamically (`addListedSymbol`, tracked in `qtp:listed:*`) and never appear in `config.symbols`, so **every option and ETF position contributes exactly $0 to the ranked PnL**. Bond face value is likewise absent, though `ChallengeRunner.portfolio()` adds it.

**Impact:** in a New Eden event — the format built specifically around options, ETFs, and bonds — the leaderboard systematically penalises anyone holding those instruments, and diverges from the PnL each trader sees in their own portfolio panel and in the WebSocket `portfolio` message. Two authoritative sources disagree in front of competitors.

**Fix:** merge `getListedSymbols()` into the price map, fall back to the fair-value key for instruments without a last price, and include `bond_holdings` face value so the worker matches `runner.portfolio()`. Better still, have the engine publish the authoritative per-user PnL and let the worker rank rather than recompute.

---

### H-9 — Unhandled promise rejections in engine command processing can kill the process

**Location:** `apps/engine/src/runner.ts:268-358`

Eight command branches dispatch with bare `void`:

```319:335:apps/engine/src/runner.ts
      case "add_symbol":
        void this.addSpotSymbol(cmd.config, cmd.locked, cmd.ts);
        return [];
      ...
      case "purchase_bond":
        void this.markets?.purchaseBond(cmd.userId, cmd.bondId, cmd.quantity, cmd.ts);
        return [];
```

None has a `.catch`. Under Node 20+ the default `--unhandled-rejections=throw` terminates the process. `addSpotSymbol`, `purchaseBond`, `etfTrade`, `settleOtc`, `awardGrant`, and `applyWealthTax` all perform Redis and Postgres I/O that can reject.

**Impact:** a single failed Redis write from a trader-triggered command crashes the engine. Docker restarts it, which then triggers C-3 (full state reset). The same pattern appears in `OptionsManager.schedule` callbacks and `MarketsManager.ensureWindowLoop`.

**Fix:** attach `.catch()` to every fire-and-forget call (a small `fireAndForget(promise, context)` helper keeps it tidy) and register a `process.on("unhandledRejection")` handler that logs rather than exits while the underlying causes are fixed.

---

## Medium

### M-1 — Draft challenges are readable by anonymous users
`apps/api/src/routes/challenges.ts:45-62`. The list endpoint correctly hides drafts from non-admins (`ne(challenges.status, "draft")`), but `GET /api/challenges/:idOrSlug` has no `preHandler` and no status filter. Since slugs are derived deterministically from the challenge name (`slugify`), an unauthenticated user can guess them and read the full config: symbol set, initial prices, volatilities, bot counts and intensities, bond and ETF definitions, options parameters, and scoring weights. Competitors gain material advance knowledge of an unreleased event. Add `optionalAuth` and return 404 for drafts to non-admins, mirroring the `/:id/news` handler which already does this correctly.

### M-2 — Production CORS defaults to wildcard with credentials
`docker-compose.prod.yml` (`api.environment`) sets `CORS_ORIGINS: ${CORS_ORIGINS:-*}`, and `apps/api/src/app.ts:43-48` maps `*` to `origin: true` (reflect any origin) with `credentials: true`. Impact is limited today because auth is a Bearer token from `localStorage` rather than a cookie, so there is no ambient authority to abuse — but the configuration is wrong, would become exploitable the moment cookie auth is introduced, and permits any site to freely read public API responses. Remove the `:-*` default and require an explicit origin list.

### M-3 — Unauthenticated data endpoints
No auth on `GET /api/market/:challengeId/*` (symbols, price, history, orderbook), `GET /api/options/:challengeId`, `GET /api/markets/:challengeId/etfs`, `GET /api/leaderboard/:challengeId`, and `GET /api/metrics`. Market data for a public competition is arguably fine, but `/api/metrics` exposes per-route request counts, RSS, heap usage, and uptime to the internet via the `/api/` nginx location, and the gateway's `/health` and `/metrics` are similarly open. Restrict metrics to the internal network or require a bearer token.

### M-4 — No enrollment or lifecycle checks on Eden actions
Any authenticated user can vote on a proposal (`votes.ts:102`), bid in an auction (`auctions.ts:40`), respond to OTC offers, exercise options, and request loans for **any** challenge, whether or not they joined it. `loans.ts` `disburse()` checks only `challenge.type === "new_eden"` — not `status`, so loans can be drawn against a `draft`, `paused`, or `ended` challenge. Add a participant lookup and a `status === "live"` check to each mutating Eden route (orders, options, bonds, and ETFs already check status).

### M-5 — Eden resolvers are in-process timers with race-prone idempotency
`apps/api/src/eden-ops.ts:206-210` schedules auction, vote, and grant resolution with `setTimeout(...).unref()` inside the API process. Timers are lost on restart (auctions never resolve; the lazy backstops in `auctions.ts:26-34` and `votes.ts:25-43` only fire if someone happens to poll the endpoint) and duplicated if the API is ever scaled beyond one replica. The idempotency guard is a read-then-write (`if (auction.status !== "open") return` … later `update`), so two concurrent resolutions — for example the timer and a lazy poll — can both pass the check and double-grant premium access or double-award a grant prize. Move scheduling to the engine (which already holds a per-challenge lock) or use a conditional update (`UPDATE ... WHERE status = 'open' RETURNING *`) as the claim.

### M-6 — Datastores exposed on all interfaces in development
`docker-compose.yml` publishes `5432:5432` and `6379:6379`, which Docker binds to `0.0.0.0`. Redis has no `requirepass` and Postgres uses `qtp:qtp`. `docker-compose.override.yml` escalates this by putting both containers in `network_mode: host`. An unauthenticated Redis instance reachable from the local network is a well-known remote-code-execution vector (`CONFIG SET dir` / module loading). Bind to `127.0.0.1:5432` and `127.0.0.1:6379`, and set a Redis password even in development. Production is not directly affected — nothing but nginx publishes ports there — but Redis inside the prod network is also unauthenticated, so any container compromise yields full command-bus control.

### M-7 — Containers run as root; no healthchecks or resource limits on app services
Neither `Dockerfile.service` nor `Dockerfile.web` nor `Dockerfile.migrate` sets `USER`, so all six application containers run as uid 0. `docker-compose.prod.yml` defines healthchecks for postgres and redis only, and no `mem_limit`/`cpus` anywhere — a memory leak in the gateway (see H-2) can starve the entire single-VM stack. Add `USER node`, per-service healthchecks against the existing `/api/health` and `/health` endpoints, and resource limits.

### M-8 — Unattended `db:push` against the production database on every deploy
The `migrate` service runs `drizzle-kit push`, which diffs the schema and applies changes directly, rather than applying reviewed migration files. Renaming or removing a column in `packages/db/src/schema.ts` can therefore drop production data with no review gate and no backup step, on a container that runs automatically as part of `up -d`. Switch production to `drizzle-kit generate` + `drizzle-kit migrate` with the generated SQL committed and reviewed, and take a `pg_dump` before each migration.

### M-9 — Session management gaps
JWTs are stateless with a 24-hour TTL (`JWT_EXPIRES_IN=86400`), there is no revocation list, and "logout" only removes the token from `localStorage` — a stolen token remains valid for up to a day. There is no password change, no reset, and no account lockout. The token is also passed as a WebSocket query parameter (`useRealtime.ts:220`), so it lands in nginx access logs and any intermediary log. Shorten the TTL with a refresh mechanism, add a `jti` denylist in Redis for logout, and move the WS token to the `Sec-WebSocket-Protocol` header or a short-lived single-use ticket.

### M-10 — Auction bids cost nothing
`resolveAuctionRound` (`eden-ops.ts:28-105`) grants premium access to winners but never debits their cash, and `zAuctionBidInput.amount` has no upper bound. The optimal strategy is to bid an arbitrarily large number every round and always win, with no consequence — which defeats the entire sealed-bid mechanic. Either escrow the bid on submission and charge winners (a `pay_auction` engine command), or cap bids against the bidder's free cash at resolution time.

### M-11 — Missing nginx hardening
`infra/nginx/conf.d/*.conf` sets no HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, or CSP; leaves `server_tokens` on; and applies no `limit_req` / `limit_conn`. The `/ws` location forwards `X-Real-IP` but not `X-Forwarded-For`. Add the standard header set, `server_tokens off`, and connection/request limiting as a second layer under the application rate limiter.

### M-12 — Cancel marks the order cancelled before the engine confirms
`apps/api/src/routes/orders.ts:201-216` sets `status: "cancelled", remainingQuantity: 0` in Postgres and *then* publishes the cancel command. If the order fills in the interval, the engine emits `filled`, and whichever write lands last wins — the order history can show a cancelled order that actually traded, or vice versa. Make the engine the sole writer of terminal order status; have the API only enqueue the command and return `202`.

### M-13 — Money is represented in floating point end to end
All monetary columns are `doublePrecision` and all arithmetic is JS `number`. `roundTick` (`engine.ts:915-917`) does `Math.round(price / tick) * tick`, which reintroduces representation error at every step. Cash accumulates error across thousands of fills, and `pnl` comparisons in the leaderboard sort can be decided by floating-point noise between traders who are nominally tied. For a scored competition, use integer minor units (cents/ticks) internally or `numeric` columns with a decimal library.

### M-14 — Gateway symbol cache is never invalidated
`apps/gateway/src/index.ts:108-117` caches `config.symbols` per challenge forever. When an admin introduces a symbol live (`POST /api/admin/:challengeId/symbols`), existing gateway processes never pick it up. Snapshots happen to still work because `getListedSymbols()` covers dynamically-listed instruments, but the cache is a latent correctness trap. Add a TTL or invalidate on the `symbol_listed` broadcast.

---

## Low

| ID | Finding | Location |
|----|---------|----------|
| L-1 | `cancelledIds` grows without bound — an order cancelled after it already filled is added and never removed, leaking memory over a long event. | `packages/core/src/engine.ts:116, 618-636` |
| L-2 | `pushNews` is a non-atomic read-modify-write on a single Redis key, written by both the API and the engine's news scheduler; concurrent posts silently lose items. Use a `LIST` with `LPUSH`/`LTRIM`. | `packages/bus/src/state.ts:304-315` |
| L-3 | Scheduled news loses `kind` and `embargoUntil` when published by the engine, so a scheduled premium-embargoed headline reaches everyone immediately. | `apps/engine/src/runner.ts:385-392` |
| L-4 | After failover, option series are restored with `initialPrice: r.strike` instead of their last mark, so option prices jump discontinuously. | `apps/engine/src/options-manager.ts:435-438` |
| L-5 | `jwt.verify` is called without an `algorithms` allowlist. Not exploitable with an HMAC string key, but pin `["HS256"]` defensively. | `apps/gateway/src/index.ts:192` |
| L-6 | `users.email` has no unique index despite being collected and validated — unlimited duplicate registrations per address. | `packages/db/src/schema.ts:74` |
| L-7 | `?limit=abc` on market history produces `NaN`, which reaches `ZRANGE` and returns a 500. Validate with `z.coerce.number()` as the news route does. | `apps/api/src/routes/market.ts:48-53` |
| L-8 | Validation errors echo full Zod issue paths and messages, disclosing internal schema shape. Fine for a competition, worth trimming in production. | `apps/api/src/util.ts:11-19` |
| L-9 | `app.authenticate` sends 401 without returning the reply, unlike `requireAdmin` which returns it. Fastify's `reply.sent` check makes this safe today, but the inconsistency is one refactor away from an auth bypass. | `apps/api/src/auth.ts:43-52` |
| L-10 | OTC `counterCash` is unvalidated and unbounded. `bargainRejectProbability` clamps to 1.0 at 25% overreach so large demands are always rejected, but the input should still be range-checked. | `apps/api/src/routes/otc.ts:109-136` |
| L-11 | `.env.prod` is `scp`'d to the VM as `.env` with default permissions and no explicit `chmod 600`. | `scripts/registry-vm-deploy.sh:43-46` |
| L-12 | Gateway `/health` and `/metrics` are unauthenticated and reachable if the port is ever exposed; they leak connection counts and memory. | `apps/gateway/src/index.ts:199-235` |
| L-13 | `dashboard-ref/` is an untracked second Next.js application (~90 files) sitting inside the repo with its own auth, database layer, and trading API routes. It is not audited here and must not be committed or built into any image; confirm `.dockerignore` and `.gitignore` cover it. | repo root |

---

## What was checked and found clean

- **SQL injection** — every query goes through Drizzle's parameterised builder. No `sql.raw`, no string-concatenated SQL, no `.execute()` with interpolation.
- **XSS** — no `dangerouslySetInnerHTML`, `innerHTML`, `eval`, or `new Function` anywhere in `apps/web`. All user- and admin-supplied strings (news messages, challenge names, display names) render through React's escaping.
- **Password storage** — bcrypt with cost factor 10, compared with `bcrypt.compare`; hashes never leave the API (`toPublic` strips them).
- **Login enumeration** — `/login` returns the same `invalid_credentials` error for unknown users and wrong passwords.
- **Order ownership** — cancel checks `order.userId !== req.user.sub` (403), OTC response checks offer ownership, and the engine independently verifies book ownership in `cancelOrder`.
- **Admin route protection** — `adminRoutes` applies `app.requireAdmin` as a plugin-scoped `preHandler` hook, so every route under `/api/admin` is covered including ones added later.
- **Rate limiter correctness** — the Redis counter is incremented and expired inside a single Lua script, so it is atomic and correct across horizontally scaled API nodes. (The identity it keys on is the problem — see H-1.)
- **Engine leader election** — `acquireEngineLock` uses `SET NX PX` and `refreshEngineLock` uses a compare-and-set Lua script, correctly preventing two engines from writing one challenge's book.
- **Bot isolation** — bots use non-UUID synthetic ids, and every persistence, metrics, and leaderboard path filters on a UUID regex, so bots cannot appear in rankings or the database.
- **Secret hygiene in git** — `.gitignore` covers `.env`, `.env.prod`, `.acr-github-secrets.env`, and `*.tfvars`; no credentials are committed. CI passes ACR credentials via GitHub secrets, and `azure-deploy.sh` generates `JWT_SECRET` and `POSTGRES_PASSWORD` with `openssl rand`.

---

## Remediation plan

**Before the next live event**

| Order | Finding | Effort |
|-------|---------|--------|
| 1 | C-1 — rotate the admin password now; gate seeding behind an env flag; ship a password-change endpoint | S |
| 2 | C-4 — remove hardcoded JWT fallbacks, fail fast, rotate the production secret | S |
| 3 | C-2 — block self-matching, add a price collar, add regression tests | M |
| 4 | H-1 — enable `trustProxy` and key rate limits on `req.ip` | S |
| 5 | C-3 — rehydrate engine accounts and positions from Postgres on start | M |
| 6 | H-3 — move the command loop to a consumer group with `XACK` | M |
| 7 | H-2 — reject anonymous WS connections; validate and cap subscriptions | S |
| 8 | H-4 — make challenge reset actually reach the running engine | M |

**Next iteration**

H-5 (enforce `allowMargin`), H-6 (bound and fund off-book settlement), H-7 (retry failed flushes), H-8 (price all instruments in scoring), H-9 (catch fire-and-forget rejections), M-1 (hide draft configs), M-2 (explicit CORS origins), M-4 (enrollment and lifecycle checks), M-10 (charge auction winners).

**Hardening backlog**

M-3, M-5 through M-9, M-11 through M-14, and the Low table. M-13 (floating-point money) is the largest single piece of work and is best scheduled alongside a scoring-model revision.

---

## Appendix A — Exploit verification

Run against the compiled engine at `packages/core/dist/engine.js` on commit `6652c98`.

```js
const cfg = {
  challengeId: "c1",
  symbols: [{ symbol: "X1", initialPrice: 100, volatility: 0.5, tickSize: 0.01 }],
  startingCash: 1000, minPosition: -50, maxPosition: 50, maxOrderQuantity: 50,
  allowMargin: false,               // margin explicitly DISABLED
};

// H-5: buy 50 @ 100 with only $1,000 of cash
const e = new ChallengeEngine(cfg);
e.placeOrder({ orderId: "mm", userId: "maker",  symbol: "X1", side: "sell",
               orderType: "limit",  quantity: 50, price: 100, ts: 1 });
e.placeOrder({ orderId: "t1", userId: "poor",   symbol: "X1", side: "buy",
               orderType: "market", quantity: 50, price: null, ts: 2 });

// C-2: rest an absurd ask, then lift it yourself
e2.placeOrder({ orderId: "a2", userId: "attacker", symbol: "X1", side: "sell",
                orderType: "limit", quantity: 1, price: 10000, ts: 3 });
e2.placeOrder({ orderId: "a3", userId: "attacker", symbol: "X1", side: "buy",
                orderType: "limit", quantity: 1, price: 10000, ts: 4 });
```

Output:

```
[1] allowMargin=false -> cash: -4000 position: 50
[2] before wash -> price: 100 pnl: 1000.00
[2] self-trade executed: true -> price: 9010
[2] after wash -> pnl: 437590.00 spreadCapture: 9900.00
```

The margin flag is ignored, and one self-matched 1-lot order multiplies the attacker's PnL by 437× while inflating the market-making score component from 0 to 9,900.
