# New Eden — Full Event Simulation Guide

How to run **The New Eden Exchange** on Quantstorm with real players — from a local dry run through a production rehearsal to the live tournament.

The host runs the event from `/admin/[id]` while the engine keeps the economy, bots, and prices running underneath. There are three **event flows**:

- **Playbook cues** (semi-automatic, §1.2): the playbook is split into 46 cues (open, headlines, Deal Desk slots, auctions, listings, halftime, vote, shock, grant, close). You press **Run** for each one; the engine runs its steps with the playbook's own timing.
- **Host** (fully manual, §1.1): you build every beat yourself from the individual controls.
- **Scripted** (fully automated, §1.3): the 130-minute timeline runs by itself.

Your job is to stand up the environment, enroll players, pick a flow, and run the event. Pick the flow before the challenge starts; it cannot change once the event has run.

**Related docs**

| Document | Purpose |
|----------|---------|
| [`event.md`](../event.md) | Full host playbook — narrative, traps, and minute-by-minute script |
| [`new-eden-host-guide.md`](./new-eden-host-guide.md) | Every host control and its admin API request shape |
| [`EVENT-IMPLEMENTATION.md`](./EVENT-IMPLEMENTATION.md) | Implementation details, clock semantics, and rollout notes |

---

## 1. Event flows

The flow is the **Event flow** selector on the challenge form (`config.eden.playbookCues` for cues, `config.eden.eventScript` for scripted; if both are set, scripted wins). It can be changed while the challenge is `draft` or `scheduled`, and locks once the event has run.

### 1.1 Host (fully manual)

Nothing on the event timeline happens until you trigger it. These keep running on their own once the challenge is live:

| Runs automatically | Notes |
|--------------------|-------|
| **Economy** | Cost of carry every game minute, predatory-loan repayments, margin calls, forced liquidation |
| **Bots** | HFT market makers, momentum traders, vega snipers, parity arbers — from the saved bot counts |
| **Prices** | Autonomous random walk on every listed symbol, plus any drift you set |
| **Bond payouts** | Every game minute on bonds players hold |
| **ETF windows** | Once an ETF is listed, a 30-second create/redeem window opens every 10 game minutes; you can also open or close one by hand |
| **Option cycles** | Each cycle you open closes itself after its cycle length and opens a 15-second exercise window; the next cycle does not open until you open it |
| **Auction, vote, grant deadlines** | Each resolves on its own timer once you open it |
| **Close** | At **Ends at** (if set), or when you click **End**: trading halts, options expire, debt is closed out, final rankings are saved |

Switching to **Host** from another flow keeps the current instruments, cash, limits, and bot counts. It also turns off automatic option cycles, so **Open cycle** opens one cycle at a time.

### 1.2 Playbook cues (semi-automatic)

The playbook's beats are pre-built as **cues** on the **Playbook cues** panel (§8.4). Nothing happens until you run a cue; then the engine runs that cue's steps with the playbook's spacing, counted from your click. The headline text, fair-value effects, Deal Desk terms, auction rounds, vote, shock, and grant all come from the playbook, so there is nothing to type.

Choosing **Playbook cues** applies the same preset as scripted mode: AERIUM only at 1,000, the playbook economy, bots, and options. The bonds, NEURO, and ORBITAL come from their cues. When the challenge goes live, the market **stays frozen until you run Open market**. After that, the economy and bots run as in host mode. ETF windows open every 10 game minutes once ORBITAL lists, and option cycles roll on their own once **Reopen with options** has run.

Use the cue sheet rather than the manual controls for playbook beats. Manual controls still work for extras (an announcement, a price nudge, an account correction).

### 1.3 Scripted (fully automated)

The engine runs a fixed **130-game-minute** timeline by itself: listings at 10/18/30/45/70m, 24 headlines, 7 auctions, 13 OTC slots, halftime 60–70m, vote at 80m, shock at 90m, grant at 100m, close at 130m. The host only monitors. Full schedule: [`event.md`](../event.md) and `packages/shared/src/eden-event.ts`.

In scripted mode, **do not** fire manual news, auctions, OTC offers, votes, or grants — they double the scripted beats. Sections 5–8 cover host mode and call out where playbook cues differ.

---

## 2. Clock

| Mode | Clock | Best for |
|------|-------|----------|
| **Accelerated dry run** | `ENGINE_MINUTE_MS=6000` (6 s / game minute) | Checking controls and economy locally |
| **Rehearsal** | `ENGINE_MINUTE_MS=60000` (default) | Full player UX, real reaction windows |
| **Production event** | 60 s / game minute on the VM | The actual tournament |

In host mode the game minute drives carry, loan repayment, bond payouts, option cycle length, and the 10-minute ETF window cadence. Durations you type into the host desk (auction, vote, grant, OTC reply) are **wall seconds**. So are the 15-second option exercise window, the 30-second ETF window, and the 5-second OTC bargain settlement delay. None of these scale with `ENGINE_MINUTE_MS`.

With playbook cues, the spacing between steps inside a cue is game time and **does** scale: at 6 s per game minute, the grant's award lands 30 wall seconds after you run it, not 5 minutes. The OTC reply window, auction bidding, and vote are also game time inside a cue, so at 6 s per game minute a 15-second OTC reply shrinks to 1.5 s. Rehearse player-facing beats on the real-time clock.

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

The seed also creates a **New Eden Exchange** challenge (`scheduled`, flow **Scripted**), but **does not enroll anyone into it** — only the live directional challenge gets auto-enrolled traders. §5.1 switches its flow.

### Production

- Deployed stack at `https://quantstorm-2026.site` (or your instance)
- Admin login with production credentials
- All services (`api`, `engine`, `gateway`, `web`) running the same build
- **`ENGINE_MINUTE_MS=60000`** on every engine instance (default if unset)

---

## 4. Player onboarding

Real players need accounts **and** enrollment in the New Eden challenge before you start sending them offers.

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

Enrollment gives each player the challenge's starting cash (**$10,000** with the preset instruments).

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

Opening `/challenges/[id]` and placing any order auto-enrolls the player.

> The Deal Desk offer form lists only traders who appear on the leaderboard, so a player who has not joined yet cannot receive an offer. Have everyone call `/join` (or place a throwaway order) before you start.

Verify enrollment in the admin **Trader accounts** panel or `GET /api/admin/:challengeId/accounts`.

---

## 5. Challenge setup

### 5.1 Pick the event flow on the seeded challenge, or create a new one

**Seeded:** Admin → `/admin` → **New Eden Exchange** → **Edit**. While it is still `scheduled`, set **Event flow** to **Playbook cues** or **Host** and click Save. The AERIUM instrument, $10,000 cash, 100-unit cap, carry, loans, and bot counts from the preset stay as they are.

**New:** Admin → `/admin/new` → Type **New Eden Exchange**. It starts in **Host** with the form's default instruments. Choosing **Playbook cues** applies the preset. For host mode on the preset's instruments and economy, choose **Playbook cues** once and then switch back to **Host** before saving.

If the challenge has already run, the form refuses the change ("This event has already run…"). **Reset** it first (§5.4), or create a new challenge.

### 5.2 Configure before go-live

Everything below is read when the challenge goes live. Save it first.

| Setting | Where | Notes |
|---------|-------|-------|
| Starting instruments | **Instruments** | Leave only what trades at the open (the preset uses AERIUM at 1,000). List the rest live (§8). |
| Economy rules | **New Eden economy** | Carry, loan multiplier, margin threshold, forced liquidation, position cap |
| Bots | **New Eden economy** → bot counts | Preset: 2 HFT makers, 4 momentum, 1 vega, 1 parity arb |
| **Bond templates** | **New Eden economy** → Bond templates | **Must be saved before go-live.** The engine reads bond templates only when the challenge starts. Bonds added mid-event appear in the list but cannot be bought. For the playbook's two bonds, see the templates in `packages/shared/src/eden-presets.ts` (`EDEN_EVENT_BONDS`). |
| Premium feed | **New Eden economy** | Auction winner fraction, news lead, access minutes |

Bonds are purchasable from the open. If you want them to "arrive" at 10m and 18m, announce them at that point (§8); the platform cannot hold a template back.

With playbook cues, the form locks bond templates: the two playbook bonds arrive when you run their cues. Leave the preset's instruments as they are; NEURO and ORBITAL also come from cues.

### 5.3 Set the schedule

1. **Starts at** — the open. The game clock (carry, loans, bond payouts) counts from this time.
2. **Ends at** — optional. If set, the engine closes the event at that time. If empty, the event runs until you click **End**. For a 130-minute event, set it to Starts at + 130 minutes. In host and cue modes it is not filled in automatically; with cues you can leave it empty and run **Close** instead.
3. Save while still `draft` or `scheduled`.
4. Only a `scheduled` challenge goes live on its own at **Starts at**. The seeded challenge is already `scheduled`. A new or reset challenge is a `draft`: click **Schedule** in the admin list, or click **Start** yourself at the open.

### 5.4 Dry-run reset

After a test run, reset trading state without deleting users:

- **End** or **Pause** the challenge first (reset is refused while it is live), then admin list **Reset**, or `POST /api/admin/:challengeId/reset`

Reset clears orders, positions, news, loans, bonds, OTC, options, auctions, votes, grants, and Redis hot state, and resets every enrolled player's cash. Enrollment is kept. The challenge returns to `draft` with **Starts at** and **Ends at** cleared.

With playbook cues (or scripted), reset also restores the preset config and clears every cue, so the cue sheet starts over. Set **Starts at**, save, and **Schedule** it (§5.3).

In host mode, instruments you listed during the run (NEURO, ORBITAL, option underlyings) stay in the challenge config, and the form cannot remove a listed ETF. To get back to a clean start, switch **Event flow** to **Playbook cues** and back to **Host**. That restores AERIUM only and clears bond templates and ETFs, so re-add your bond templates afterwards. Then set **Starts at**, save, and **Schedule** it (§5.3).

---

## 6. Pre-flight checklist

Complete this **before** `startsAt`:

- [ ] Stack healthy: `GET /api/health`, WebSocket connects at `/ws?token=…`
- [ ] Challenge type `new_eden`, **Event flow** set to **Playbook cues** or **Host**
- [ ] Host mode only: bond templates saved (if you want bonds)
- [ ] **Starts at** saved; **Ends at** saved or a plan to click **End**
- [ ] Every player has an account and has **joined** the challenge
- [ ] Enrollment count matches expected headcount in **Trader accounts**
- [ ] Players know the URL: `/challenges/[id]` (trading terminal)
- [ ] Host has admin tab open: `/admin/[id]`, plus a run sheet (§8.2)
- [ ] Brief players on panels: **News**, **Deal Desk**, **Auction**, **Bank**, **Markets** (bonds/ETF), **Options**, **Vote**, grant banner
- [ ] Optional: run `scripts/loadtest.mjs` against a separate live directional challenge to validate gateway capacity — not against the event itself

---

## 7. Starting the simulation

### 7.1 Local accelerated dry run

```bash
# Terminal 1 — 6 seconds per game minute
ENGINE_MINUTE_MS=6000 pnpm dev
```

Then:

1. Log in as `admin` → `/admin` → **New Eden Exchange** → pick the event flow (§5.1).
2. Set **Starts at** a minute or two ahead → Save (§5.3). Or click **Start** when ready.
3. Enroll traders (§4.2).
4. When the challenge goes live: in host mode AERIUM trades immediately; with playbook cues the market stays frozen until you run **Open market**.
5. Drive the event from `/admin/[id]` (§8) and watch a trader tab.

### 7.2 Full rehearsal or production (real-time)

```bash
# Local real-time
pnpm dev

# Production — ensure engine has ENGINE_MINUTE_MS=60000 (default)
# Deploy via CI registry; see AGENTS.md
```

---

## 8. Running the event from the admin page

All controls are on `/admin/[id]` under **Live operations**, which appears once the challenge is `live`. Request shapes and edge cases for each control: [`new-eden-host-guide.md`](./new-eden-host-guide.md).

With playbook cues, run the event from the **Playbook cues** panel at the top of Live operations (§8.4). §8.1–8.3 describe the manual controls.

### 8.1 Where each beat lives

| Beat | Panel → control |
|------|-----------------|
| List a new spot asset | **Instrument listings** → **Spot** → symbol, price, volatility, tick |
| List an ETF | **Instrument listings** → **ETF** → symbol + basket weights |
| Start options | **New Eden / Host desk** → **Options** → **Open cycle** (all configured underlyings), or **Instrument listings** → **Options** (one underlying) |
| Headline (signal / noise) | **News & announcements** → Feed **Market news** → Kind **Signal** (with FV symbol + delta) or **Noise**. **Publish at** queues it for later |
| Volatility shock | Same form, tick **Volatility event (vega snipers react)** |
| Early news for auction winners | Same form, **Premium embargo (s)** |
| Operational message | **News & announcements** → Feed **Announcement** |
| OTC offer | **New Eden / Host desk** → **Deal Desk offer** → trader, legs, cash adjustment, reply seconds |
| Premium auction | **New Eden / Host desk** → **Premium auction** → duration → **Open auction** |
| ETF create/redeem window | **New Eden / Host desk** → **ETF windows** → **Open window** / **Close window** |
| Policy vote (wealth tax) | **New Eden / Host desk** → **Policy vote** → **Open vote** |
| Government grant | **New Eden / Host desk** → **Government grant** → symbol, prize, duration → **Open grant** |
| Halftime | **Market freeze** → **Freeze market**, later **Unfreeze market** |
| Price move | **Live price controls** → **Drift** (toward a target) or **Set** (instant) |
| Account correction | **Trader accounts** |
| Hide / show rankings | Header → **Leaderboard: Visible / Hidden** |
| Close | Admin list → **End** (or wait for **Ends at**) |

A locked spot listing (the **locked** option when listing) has no unlock button; unlock it with `POST /api/admin/:id/tradeable { symbol, tradeable: true }`. List the asset when you want it to trade instead.

### 8.2 Suggested run sheet (mirrors the playbook)

To run the same story the script tells, fire these by hand. Minutes are game minutes from the open. Values come from `packages/shared/src/eden-presets.ts` and [`event.md`](../event.md).

| Minute | Do | Control |
|--------|----|---------|
| 0 | Open: challenge goes live, AERIUM trades | Starts at, or **Start** |
| 2.5, then every 10 | OTC offer to one or more traders (skip during halftime) | Deal Desk offer, 15 s reply |
| Every 5 (not 60–70) | Headline, alternating signal and noise | News & announcements |
| 10 / 18 | Announce the standard / Aerium-pegged bond | Announcement (templates saved in §5.2) |
| 15, 30, 45, 75, 90, 105, 120 | Premium auction, then an embargoed headline | Premium auction; News with embargo |
| 30 | List **NEURO** (price 500, volatility 2, tick 0.5) | Instrument listings → Spot |
| 45 | List **ORBITAL** ETF (2 AERIUM + 1 NEURO) | Instrument listings → ETF |
| 60 | Halftime freeze — carry and loans keep charging | Market freeze → Freeze market |
| 70 | Reopen, then open the first option cycle on AERIUM | Unfreeze market; Options → Open cycle |
| 75, 80, 85 … | Open the next option cycle as each one closes | Options → Open cycle |
| 80 | Solidarity Tax vote (60 s) | Policy vote |
| 90 | Shock: signal headline, AERIUM −300 and NEURO +200, volatility event | News & announcements |
| 100 | Grant mission on AERIUM (300 s) | Government grant |
| 130 | Close | **End**, or Ends at |

Two scripted beats have no host control. The halftime rescue loans do not exist in host mode, though players can still borrow from the **Bank** panel at any time. The 3× bot volatility at minute 120 has no switch either; use **Drift** / **Set** or a volatility-event headline instead. Playbook cues run both: **Halftime freeze** issues the rescue loans and **Final squeeze** triples bot volatility.

### 8.3 Host tips

- **Freeze is halftime.** Freezing stops new orders, matching, and bots; players can still cancel. Carry, loan repayments, and bond payouts keep running. Do not use **Pause** for halftime: pausing stops the engine runner for the challenge.
- **Queue headlines ahead.** Use **Publish at** to schedule the next few headlines, so you are free for OTC and auctions.
- **Options need a nudge.** Each cycle closes on its own, but the next one opens only when you click **Open cycle**.
- **One OTC offer per trader per send.** For a desk-wide slot, send one offer to each trader.
- **End runs final scoring.** Clicking **End** (or reaching Ends at) halts trading, expires options, closes out debt, and saves final rankings. It cannot be undone; use **Reset** to run again.

### 8.4 Running with playbook cues

The **Playbook cues** panel lists all 46 cues in playbook order, each with its game minute, kind, and label. Admins see the headline text of every headline a cue will publish; traders see nothing until it publishes.

- **Run next** fires the first cue that has not run. Every cue also has its own **Run** button, so you can skip ahead, hold a beat, or run beats early. Each cue runs once.
- A cue's steps keep the playbook's spacing, counted in game time from your click. Expand **N steps** on a row to see the offsets. Headlines reach premium-feed winners 10 s before the public release, so a scene cue starts with its premium headline and its main step lands 10 s later. For example, **Government grant** sends the premium headline, opens the mission with the public headline at +10 s, and awards the prize with the minute-105 headline at +5m 10s.
- Status on each row: a **Run** button (ready), **Needs …** (waiting for another cue to finish), **Running** with the next pending step, or a check mark with the time it fired.
- Deal Desk cues are refused while the market is frozen: before **Open market**, and between **Halftime freeze** and **Reopen with options**.
- **Close event** asks for confirmation, then halts trading, expires options, closes out debt, and saves final rankings.
- A cue survives an engine restart: fired cues resume their remaining steps from the recorded fire time.

| Cue | Playbook minute | What it runs | Needs |
|-----|-----------------|--------------|-------|
| **Open market** | 0 | Lists AERIUM and unfreezes the market | — |
| Deal Desk slot (12) | 2.5, 12.5 … 122.5, not 62.5 | One playbook offer to every trader, 15 s to answer | Open market; unfrozen market |
| Headline (15) | every 5, outside the scene minutes | Premium release, public release 10 s later | Open market, plus any symbol it moves |
| **List** bond (2) | 10, 18 | Makes the standard / Aerium-pegged bond purchasable | Open market |
| Premium feed auction (7) | 15, 30, 45, 75, 90, 105, 120 | Bidding for 30 s, then resolves; winners get headlines early for 15 minutes | Open market |
| **List NEURO** | 30 | NEURO lists, with its headline | Open market |
| **List ORBITAL ETF** | 45 | ORBITAL (2 AERIUM + 1 NEURO) lists, with its headline; ETF windows start | List NEURO |
| **Halftime freeze** | 60 | Freeze with rescue loans, with its headline | Open market |
| **Reopen with options** | 70 | Unfreeze, AERIUM options open, with its headline | Halftime freeze |
| **Solidarity Tax vote** | 80 | Vote opens with its headline, resolves 60 s later | Open market |
| **Dis-correlation shock** | 90 | Vega bots prepare; 60 s later the shock headline and the vega dump | Reopen with options |
| **Government grant** | 100 | Grant on AERIUM, awarded 5 minutes later; headlines at 100 and 105 | Open market |
| **Final squeeze** | 120 | Bot volatility ×3, with its headline | Open market |
| **Close event** | 130 | Halt and final rankings | — |

An auction sorts just ahead of the headline on the same minute: run the auction first so its winners receive that headline early.

---

## 9. What players do during the event

Each trader works from **`/challenges/[id]`** — a single terminal with real-time WebSocket updates.

| Panel | When it matters | Player action |
|-------|-----------------|---------------|
| **Order ticket / book** | Always | Limit orders on listed symbols |
| **News ticker** | Whenever you publish | Read headlines; infer signal vs noise |
| **Deal Desk** | When you send an offer | Accept / Reject / Bargain on the OTC modal before its deadline |
| **Auction** | When you open a round | Submit one sealed bid per round |
| **Bank** | When leveraged or margin-called | Request predatory loans |
| **Markets** | Once an ETF exists | Create/redeem ETF while a window is open |
| **Government bonds** | Once a bond is listed | Buy each series once at a price above free cash |
| **Options** | Once you open a cycle | Trade calls/puts; **Exercise** within 15 s of cycle close |
| **Vote** | When you open a vote | Yes/No |
| **Grant banner** | When you open a grant | Chase inventory of the target symbol |
| **Portfolio** | Always | Monitor cash, positions, loan bleed |

There is no separate “premium feed” UI — auction winners receive embargoed news early via the same news stream.

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

Suite `07-new-eden.mjs` exercises the host controls. `09-eden-script.mjs` covers scripted mode.

### Manual acceptance during rehearsal

Confirm with real players:

- [ ] All enrolled traders received the starting cash at join
- [ ] Carry is charged each game minute on open inventory
- [ ] OTC modal appears with Accept/Reject/Bargain when you send an offer
- [ ] Signal headline moves prices; noise headline moves bots but not FV
- [ ] Auction round: bid → cutoff published → early news for winners
- [ ] New listings (spot, ETF, options) appear in every trader's market list
- [ ] Freeze stops matching; unfreeze restores it
- [ ] Vote and grant banners appear; tax/grant cash changes on portfolio
- [ ] **End** shows the “Trading halted” message and final leaderboard

---

## 11. Production deployment notes

For a production simulation on `quantstorm-2026.site`:

1. Merge to `main` and wait for **Publish Docker Images** CI.
2. Deploy: `REGISTRY=quantadevclub.azurecr.io IMAGE_TAG=sha-$(git rev-parse --short HEAD) ./scripts/registry-vm-deploy.sh`
3. Confirm `ENGINE_MINUTE_MS` is consistent across engine containers.
4. Create or reset the New Eden challenge in admin, pick its event flow, and set production `startsAt`.
5. Share player link: `https://quantstorm-2026.site/challenges/[id]`
6. Enroll players via §4.2 before the open.

If schema changed, run migrate via compose (`db:push` in migrate image) before writers start — see [`EVENT-IMPLEMENTATION.md`](./EVENT-IMPLEMENTATION.md).

---

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Challenge never goes live | `startsAt` is null, or the challenge is still `draft` | Set **Starts at**, save, then **Schedule**; or click **Start** |
| Events fire on their own | Event flow is **Scripted** | Before the event: switch it (§5.1). After it has run: **Reset**, then switch it |
| Event flow selector is greyed out | Challenge is live, paused, or ended | **Reset** (it returns to `draft`), change the flow, then schedule it again |
| Market stays frozen after go-live | Playbook cues: the open is a cue | Run **Open market** on the cue sheet |
| Cue row shows **Needs …** | A cue it depends on has not finished (e.g. NEURO headlines need **List NEURO**) | Run that cue first, or wait for it to finish its steps |
| "Deal Desk offers need an open market" | Deal Desk cue run while frozen | Run it after **Open market**, or after **Reopen with options** at halftime |
| No **Playbook cues** panel | Event flow is not **Playbook cues**, or the challenge is not live | Check the flow on the edit form; the panel shows under Live operations |
| "This event has already run…" on save | The challenge has engine state from an earlier run | **Reset**, then save again |
| Bond shows in the list but purchase does nothing | Template was added after go-live | Save bond templates before go-live (§5.2) |
| Player missing from the Deal Desk trader list | Not enrolled | `POST /api/challenges/:id/join`, then reload the admin page |
| Option cycles stop after one | Expected in host mode | Click **Open cycle** for each new cycle |
| Options exercise feels “too fast” in dry run | 15 s wall window does not scale | Rehearse at real-time clock |
| Prices flat / no bots | Engine not holding lock or challenge not live | Check engine logs; confirm Redis |
| `event_clock_immutable` from the API | Editing schedule or event flow after start | Reset challenge or create a new one |
| Trader cannot register | Rate limit | Wait or register from another IP |

---

## 13. End-to-end recipe (copy-paste)

**Local accelerated simulation with 8 real players:**

```bash
pnpm infra:up && pnpm db:push && pnpm db:seed
ENGINE_MINUTE_MS=6000 pnpm dev
```

1. Admin → `/admin` → **New Eden Exchange** → note challenge ID from URL.
2. Set **Event flow** to **Playbook cues** (or **Host**); set **Starts at** (and optionally **Ends at**) → Save.
3. Run bulk enroll script from §4.2.
4. Open 8 browser profiles (or incognito tabs) → `/login` as `trader1`…`trader8`.
5. Each opens `/challenges/[id]`.
6. When it goes live, work down the **Playbook cues** panel with **Run next** (§8.4), or drive the run sheet by hand in host mode (§8.2).
7. Click **End**, confirm final rankings → **Reset** → restore a clean config (§5.4) → set the real **Starts at** → **Schedule**.

---

## 14. Quick reference

| Item | Value |
|------|-------|
| Challenge type | `new_eden` |
| Flow switch | **Event flow** (`config.eden.playbookCues` / `config.eden.eventScript`), `draft` / `scheduled` only |
| Cue sheet API | `GET /api/admin/:id/cues`, `POST /api/admin/:id/cues/run { cueId }` |
| Starting cash (preset) | $10,000 |
| Admin console | `/admin/[challengeId]` → Live operations |
| Trader terminal | `/challenges/[challengeId]` |
| Join API | `POST /api/challenges/:id/join` |
| Game clock env | `ENGINE_MINUTE_MS` (default 60000) |
| Engine tick env | `ENGINE_TICK_MS` (unrelated to game minutes) |

For minute-by-minute narrative, traps, and external host choreography (e.g. blind-auction cutoff announcements), use [`event.md`](../event.md). For API-level host levers, use [`new-eden-host-guide.md`](./new-eden-host-guide.md).
