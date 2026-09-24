# New Eden — Full Event Simulation Guide

How to run **The New Eden Exchange** on Quantstorm with real players — from a local dry run through a production rehearsal to the live tournament.

This guide focuses on **simulation with humans on the platform**. The scripted timeline, economy rules, bots, and instruments are implemented in the engine; your job is to stand up the environment, enroll players on time, and stay out of the script’s way.

**Related docs**

| Document | Purpose |
|----------|---------|
| [`event.md`](../event.md) | Full host playbook — narrative, traps, and minute-by-minute script |
| [`new-eden-host-guide.md`](./new-eden-host-guide.md) | Manual host controls and admin API reference |
| [`EVENT-IMPLEMENTATION.md`](./EVENT-IMPLEMENTATION.md) | Implementation details, clock semantics, and rollout notes |

---

## 1. What the platform runs for you

When **New Eden playbook preset** (`config.eden.eventScript: true`) is enabled, the engine executes a fixed **130-game-minute** timeline:

| Category | Automated behavior |
|----------|-------------------|
| **Markets** | AERIUM opens at minute 0; NEURO at 30; ORBITAL ETF at 45; options at 70 |
| **News** | 24 ticker beats (12 signal / 12 noise) every 5 minutes outside halftime |
| **Auctions** | 7 blind premium-feed rounds at minutes 15, 30, 45, 75, 90, 105, 120 |
| **OTC Deal Desk** | 13 scheduled private offers (from minute 2.5, every 10 minutes; halftime skipped) |
| **Bonds** | Standard bond at 10m; Aerium-pegged bond at 18m |
| **ETF windows** | 30-second create/redeem windows every 10 minutes from 45m |
| **Halftime** | Freeze at 60m, reopen at 70m (positions retained; carry and loans continue) |
| **Policy vote** | Solidarity Tax opens at 80m, resolves at 81m |
| **Government grant** | AERIUM hoarding mission at 100m, awarded at 105m |
| **Bots** | HFT market makers, momentum traders, vega snipers, parity arbers |
| **Economy** | Cost of carry, margin calls, forced liquidation, predatory loans (2× repay bleed) |
| **Close** | Final halt, option expiry, debt closeout, durable rankings at 130m |

**Host rule:** Do **not** manually fire news, auctions, OTC offers, votes, or grants while the script is running — you will double events and confuse players.

Manual controls remain useful for emergencies (price override, account correction, freeze). See [`new-eden-host-guide.md`](./new-eden-host-guide.md).

---

## 2. Simulation modes

| Mode | Clock | Duration | Best for |
|------|-------|----------|----------|
| **Accelerated dry run** | `ENGINE_MINUTE_MS=6000` (6 s / game minute) | ~13 wall minutes | Smoke-test the full script locally |
| **Rehearsal** | `ENGINE_MINUTE_MS=60000` (default) | 130 wall minutes | Full player UX, real reaction windows |
| **Production event** | 60 s / game minute on the VM | 2 h 10 m | The actual tournament |

**Wall-time caveats (rehearsal and production only):**

- Option exercise after cycle close: **15 wall seconds**
- OTC bargain settlement delay: **5 wall seconds**

These do **not** scale with `ENGINE_MINUTE_MS`. An accelerated dry run validates the script and data flow, not interaction-window pressure.

---

## 3. Prerequisites

### Local stack

```bash
cd /path/to/quant-trading-platform
pnpm install
cp .env.example .env
pnpm infra:up          # Postgres + Redis
pnpm db:push           # Never approve destructive prompts
pnpm db:seed
```

Seeded accounts:

| Role | Username | Password |
|------|----------|----------|
| Admin | `admin` | `admin1234` |
| Traders | `trader1` … `trader8` | `trader1234` |

The seed also creates a **New Eden Exchange** challenge (`scheduled`, `eventScript: true`), but **does not enroll anyone into it** — only the live directional challenge gets auto-enrolled traders.

### Production

- Deployed stack at `https://quantstorm-2026.site` (or your instance)
- Admin login with production credentials
- All services (`api`, `engine`, `gateway`, `web`) running the same build
- **`ENGINE_MINUTE_MS=60000`** on every engine instance (default if unset)

---

## 4. Player onboarding

Real players need accounts **and** enrollment in the New Eden challenge **before minute 2.5** (first OTC slot).

### 4.1 Create accounts

**Option A — self-registration (recommended for live events)**

1. Send players to `/login`.
2. Toggle **Register** and choose a username + password.
3. Rate limit: 10 registrations/min per IP.

**Option B — seeded traders**

Use `trader1` … `trader8` from `pnpm db:seed`. For more pre-made accounts, increase `{ length: 8 }` in `packages/db/src/seed.ts` and re-run `pnpm db:seed` (safe: `onConflictDoNothing`).

**Option C — bulk register via API**

```bash
API_URL=http://localhost:8000   # or https://quantstorm-2026.site

for i in $(seq 1 20); do
  curl -sS -X POST "$API_URL/api/auth/register" \
    -H 'content-type: application/json' \
    -d "{\"username\":\"player$i\",\"password\":\"player1234\"}" \
    | jq -r '.username // .error'
done
```

### 4.2 Enroll in the challenge

Enrollment gives each player **$10,000 starting cash** in that challenge.

The web UI has **no Join button**. Two paths:

**Explicit join (recommended before the open)**

```bash
CHALLENGE_ID=<uuid>
TOKEN=<player-jwt>

curl -sS -X POST "$API_URL/api/challenges/$CHALLENGE_ID/join" \
  -H "authorization: Bearer $TOKEN"
```

Bulk enroll all seeded traders:

```bash
API_URL=http://localhost:8000
CHALLENGE_ID=<uuid>
PASSWORD=trader1234

for u in trader{1..8}; do
  TOKEN=$(curl -sS -X POST "$API_URL/api/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"username\":\"$u\",\"password\":\"$PASSWORD\"}" | jq -r .token)
  curl -sS -X POST "$API_URL/api/challenges/$CHALLENGE_ID/join" \
    -H "authorization: Bearer $TOKEN"
  echo " joined $u"
done
```

**Implicit join (first order)**

Opening `/challenges/[id]` and placing any order auto-enrolls the player. This works for trading but **misses OTC offers** if the first order happens after minute 2.5.

> **Critical:** Scripted OTC offers go only to traders **enrolled by each slot’s scheduled time**. Have every participant call `/join` (or place a throwaway order) **before `startsAt`**.

Verify enrollment in the admin **Trader accounts** panel or `GET /api/admin/:challengeId/accounts`.

---

## 5. Challenge setup

### 5.1 Use the seeded challenge or create a new one

**Seeded:** Admin → `/admin` → **New Eden Exchange** → open detail page.

**New:** Admin → `/admin/new` → Type **New Eden Exchange** → enable **New Eden playbook preset**.

The preset configures:

- Starting instrument: **AERIUM** only (FV 1000 at open)
- Starting cash: **$10,000**
- Position cap: **100 units** per symbol
- Cost of carry: **$1/unit/minute**
- Loan repay multiplier: **2×**
- Margin call at **$0 free cash**, forced liquidation **on**
- Default bot counts: 2 HFT makers, 4 momentum, 1 vega, 1 parity arb

Bonds and ETFs are **not** in the initial config — the script lists them at minutes 10, 18, and 45.

### 5.2 Set the schedule

On the challenge form:

1. **Starts at** — pick the real open time (required for the engine to auto-start).
2. **Ends at** — auto-set to **startsAt + 130 minutes** when the playbook preset is on.
3. Save while still `draft` or `scheduled`.

Once live, **`startsAt`, `endsAt`, and `eventScript` are immutable**. Set the clock correctly before going live.

### 5.3 Dry-run reset

After a test run, reset trading state without deleting users:

- Admin form **Reset**, or `POST /api/admin/:challengeId/reset`

Reset clears orders, positions, news, loans, bonds, OTC, options, auctions, votes, grants, and Redis hot state. Re-set **Starts at** for the real event.

---

## 6. Pre-flight checklist

Complete this **before** `startsAt`:

- [ ] Stack healthy: `GET /api/health`, WebSocket connects at `/ws?token=…`
- [ ] Challenge type `new_eden`, **playbook preset enabled**
- [ ] `startsAt` and `endsAt` saved (130-minute span)
- [ ] Every player has an account and has **joined** the challenge
- [ ] Enrollment count matches expected headcount in **Trader accounts**
- [ ] Players know the URL: `/challenges/[id]` (trading terminal)
- [ ] Host has admin tab open: `/admin/[id]`
- [ ] Brief players on panels: **News**, **Deal Desk**, **Auction**, **Bank**, **Markets** (bonds/ETF), **Options** (from minute 70), **Vote**, grant banner
- [ ] Optional: run `scripts/loadtest.mjs` against a **non-scripted** live challenge to validate gateway capacity — do not load-test the scripted event itself during a rehearsal

---

## 7. Starting the simulation

### 7.1 Local accelerated dry run

```bash
# Terminal 1 — 6 seconds per game minute (~13 min total)
ENGINE_MINUTE_MS=6000 pnpm dev
```

Then:

1. Log in as `admin` → `/admin` → **New Eden Exchange**.
2. Set **Starts at** a minute or two ahead → Save.
3. Enroll traders (§4.2).
4. At `startsAt`, the engine flips the challenge **live** automatically.
5. Watch the script unfold on the admin page and in a trader tab.

If you manually **Start** before `startsAt`, the runner starts but keeps the market **frozen** until minute 0 — you cannot unfreeze early.

### 7.2 Full rehearsal or production (real-time)

```bash
# Local real-time
pnpm dev

# Production — ensure engine has ENGINE_MINUTE_MS=60000 (default)
# Deploy via CI registry; see AGENTS.md
```

Timeline for players and host:

| Wall time (from `startsAt`) | Game minute | What happens |
|----------------------------|-------------|--------------|
| 0:00 | 0 | AERIUM opens; trading begins |
| 0:02:30 | 2.5 | First OTC offers (DM modal in terminal) |
| 0:05 | 5 | First signal headline |
| 0:10 | 10 | Standard bond available; noise headline |
| 0:15 | 15 | Blind auction #1 + signal headline |
| 0:30 | 30 | NEURO lists; auction #2 |
| 0:45 | 45 | ORBITAL ETF lists; auction #3 |
| 1:00 | 60 | **Halftime freeze** — matching stops; carry/loans continue |
| 1:10 | 70 | Reopen; **options** go live |
| 1:20 | 80 | Solidarity Tax vote |
| 1:30 | 90 | Dis-correlation shock (AERIUM −300, NEURO +200) |
| 1:40 | 100 | Government grant mission on AERIUM |
| 2:00 | 120 | Bot volatility ×3; final auction |
| 2:10 | 130 | Trading halted; final rankings |

Full narrative and host traps: [`event.md`](../event.md).

---

## 8. What players do during the event

Each trader works from **`/challenges/[id]`** — a single terminal with real-time WebSocket updates.

| Panel | When it matters | Player action |
|-------|-----------------|---------------|
| **Order ticket / book** | Always | Limit orders on listed symbols |
| **News ticker** | Every 5m | Read headlines; infer signal vs noise |
| **Deal Desk** | From 2.5m | Accept / Reject / Bargain on OTC modals (15s deadline) |
| **Auction** | Premium rounds | Submit one sealed bid per round |
| **Bank** | When leveraged or margin-called | Request predatory loans |
| **Markets** | From 10m / 45m | Buy bonds; create/redeem ETF during 30s windows |
| **Options** | From 70m | Trade calls/puts; **Exercise** within 15s of cycle close |
| **Vote** | ~80m | Yes/No on Solidarity Tax |
| **Grant banner** | ~100m | Chase AERIUM inventory for the prize |
| **Portfolio** | Always | Monitor cash, positions, loan bleed |

There is no separate “premium feed” UI — auction winners receive embargoed news early via the same news stream.

---

## 9. Host role during simulation

With the script enabled, the host is mostly **monitoring**, not driving.

### Do

- Keep `/admin/[id]` open; watch status, enrollment, and live panels
- Monitor for stuck state after infra restarts (engine holds checkpoint recovery)
- Use **Trader accounts** only for genuine corrections
- Communicate out-of-band (Discord/Slack) for rules clarifications — the platform does not replace the Deal Desk DMs described in [`event.md`](../event.md) for *external* coordination, but **scripted OTC is in-app**
- After a dry run, **Reset** and re-schedule for the real event

### Do not

- Post manual news, open manual auctions, or push manual OTC while scripted
- Change `startsAt` / `endsAt` / playbook flag after go-live
- Pause the challenge expecting “halftime” — halftime is an in-script **freeze**, not `paused` status

### Optional manual overrides (emergencies)

See [`new-eden-host-guide.md`](./new-eden-host-guide.md): price drift/set, account edit, freeze/unfreeze (blocked during scripted pre-open and halftime), reset.

---

## 10. Validating the simulation

### Quick automated check

The repo includes black-box suites that create isolated `E2E *` challenges (they never touch your rehearsal event):

```bash
# Against local dev
API_URL=http://localhost:8000 WS_URL=ws://localhost:8080 node test-scripts/run.mjs

# Against production (creates and cleans up its own challenges)
node test-scripts/run.mjs
```

Suite `09-eden-script.mjs` specifically watches a scripted New Eden through early timeline beats (open, first OTC, first headline).

### Manual acceptance during rehearsal

Confirm with real players:

- [ ] All enrolled traders received cash = $10,000 at join
- [ ] OTC modal appears by minute 2.5 with Accept/Reject/Bargain
- [ ] Signal headline moves prices; noise headline moves bots but not FV
- [ ] Auction round: bid → cutoff published → early news for winners
- [ ] Halftime at 60m stops matching; reopen at 70m enables options
- [ ] Vote and grant banners appear; tax/grant cash changes on portfolio
- [ ] Final leaderboard and “Trading halted” message at 130m

---

## 11. Production deployment notes

For a production simulation on `quantstorm-2026.site`:

1. Merge to `main` and wait for **Publish Docker Images** CI.
2. Deploy: `REGISTRY=quantadevclub.azurecr.io IMAGE_TAG=sha-$(git rev-parse --short HEAD) ./scripts/registry-vm-deploy.sh`
3. Confirm `ENGINE_MINUTE_MS` is consistent across engine containers.
4. Create or reset the New Eden challenge in admin; set production `startsAt`.
5. Share player link: `https://quantstorm-2026.site/challenges/[id]`
6. Enroll players via §4.2 before the open.

If schema changed, run migrate via compose (`db:push` in migrate image) before writers start — see [`EVENT-IMPLEMENTATION.md`](./EVENT-IMPLEMENTATION.md).

---

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Challenge never goes live | `startsAt` is null | Set **Starts at** and save |
| Player sees no portfolio / OTC | Not enrolled | `POST /api/challenges/:id/join` before 2.5m |
| Double headlines or auctions | Host fired manual actions during script | Reset; do not duplicate scripted ops |
| Options exercise feels “too fast” in dry run | 15s wall window does not scale | Rehearse at real-time clock |
| Prices flat / no bots | Engine not holding lock or challenge not live | Check engine logs; confirm Redis |
| `event_clock_immutable` on save | Editing schedule after start | Reset challenge or create a new one |
| Trader cannot register | Rate limit | Wait or register from another IP |
| Halftime confusion | Expecting `paused` status | Normal — status stays `live`, market frozen |

---

## 13. End-to-end recipe (copy-paste)

**Local accelerated simulation with 8 real players:**

```bash
pnpm infra:up && pnpm db:push && pnpm db:seed
ENGINE_MINUTE_MS=6000 pnpm dev
```

1. Admin → `/admin` → **New Eden Exchange** → note challenge ID from URL.
2. Set **Starts at** → Save.
3. Run bulk enroll script from §4.2.
4. Open 8 browser profiles (or incognito tabs) → `/login` as `trader1`…`trader8`.
5. Each opens `/challenges/[id]` before `startsAt`.
6. Admin watches `/admin/[id]`; do not touch scripted controls.
7. After ~13 minutes, confirm final rankings → **Reset** → set real `startsAt` for the live event.

---

## 14. Quick reference

| Item | Value |
|------|-------|
| Challenge type | `new_eden` |
| Script length | 130 game minutes |
| Starting cash | $10,000 |
| Instruments (timeline) | AERIUM → NEURO (30m) → ORBITAL ETF (45m) → options (70m) |
| Admin console | `/admin/[challengeId]` |
| Trader terminal | `/challenges/[challengeId]` |
| Join API | `POST /api/challenges/:id/join` |
| Game clock env | `ENGINE_MINUTE_MS` (default 60000) |
| Engine tick env | `ENGINE_TICK_MS` (unrelated to game minutes) |

For minute-by-minute narrative, traps, and external host choreography (e.g. blind-auction cutoff announcements), use [`event.md`](../event.md). For API-level host levers, use [`new-eden-host-guide.md`](./new-eden-host-guide.md).
