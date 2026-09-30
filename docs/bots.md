Here is a implementation-backed summary of every autonomous agent in Quantstorm, plus ready-to-save markdown. **Ask mode is on**, so I cannot write the file to the repo; switch to **Agent mode** if you want it saved (e.g. `docs/bots.md`).

---

## How bots fit in the engine

| Layer | File | When it runs |
|--------|------|----------------|
| **Classic bots** | `apps/engine/src/bots.ts` | Directional / market-making challenges with `config.bots` |
| **New Eden bots** | `apps/engine/src/eden-bots.ts` | `new_eden` with `config.eden.bots` |
| **Driver** | `apps/engine/src/runner.ts` | `botTick()` every `ENGINE_BOT_MS` (default **1200 ms**); **skipped while frozen** |

**Mutual exclusion:** If `EdenBotEngine` exists, only Eden bots run; classic `BotEngine` is not used on that challenge.

```1520:1526:apps/engine/src/runner.ts
  private async botTick(): Promise<void> {
    if (!this.running || this.frozen) return;
    const now = Date.now();
    const action: ReturnType<EdenBotEngine["act"]> = this.edenBots
      ? this.edenBots.act(now)
      : this.bots.act(now);
```

Bots use synthetic user IDs (`bot:mm:0`, `bot:hft:0`, …), not UUIDs, so they are excluded from persistence/leaderboard as human traders.

Shared tuning knobs: `spread`, `quoteSize`, `intensity` (0–1) — see `zBotConfig` / `zEdenBotConfig` in `packages/shared/src/schemas.ts`.

**Default mixes (presets):**

| Preset | Location | Counts |
|--------|----------|--------|
| `EDEN_EXCHANGE_BOTS` | Seeded **New Eden Exchange** | 1× each archetype, `intensity: 0.2` |
| `EDEN_DEMO_BOTS` | **QuantStorm Practice** | 2 HFT MM, 1 momentum; no vega/parity |
| `EDEN_EVENT_BOTS` | Admin form defaults | All **0** (host must raise counts) |

---

## Classic challenge bots (`BotEngine`)

### 1. Market maker (`bot:mm:{i}`)

- **Role:** Rest **two-sided limit quotes** on every listed symbol each bot tick.
- **Pricing:** Around **last/mid** (`engine.getPrice`), half-spread = `spread + i * tickSize` (staggered depth).
- **Behavior:** Cancel-replace prior bid/ask every tick; size = `quoteSize`.

### 2. Noise trader (`bot:noise:{i}`)

- **Role:** **Taker flow** — occasional **market** orders so MMs can earn spread.
- **Behavior:** Each tick, each noise bot fires with probability `intensity`; random symbol, random buy/sell, size `1 … quoteSize`.

Used on non–New Eden challenges via the admin **Autonomous agents** panel (`ChallengeForm.tsx`).

---

## New Eden bots (`EdenBotEngine`)

Four configured archetypes plus **ETF arb** (same count as parity arbers).

### 1. HFT market maker (`bot:hft:{i}`)

- **Role:** Liquidity on **open spots** and **all option symbols**.
- **Pricing:** Around **fair value** (spot FV or Black–Scholes-style `theoreticalOption` for options), not last trade.
- **Inventory:** Widens spread and **skews** quotes against inventory (`placeTwoSided`).
- **Volatility:** `spread` and option vol scale with `volatilityMultiplier` (scripted **×3** at game minute 202).

### 2. Retail / momentum (`bot:mom:{i}`)

- **Role:** Chase **headline momentum** (`MomentumEffect`: symbol + sentiment ∈ [-1, 1]).
- **Trigger:** `onNewsPulse` / scripted news / admin news with `momentum`; lasts **4 bot ticks**.
- **Behavior:** Market orders on affected symbol; size scales with `|sentiment|`, `quoteSize`, and `intensity`.
- **Design intent** (from schema comments): reacts to **signal and noise** headlines so humans can fade noise spikes.
- **Extra:** On **positive** sentiment, also **buys nearest ATM call** (straddle leg only on the call side in code).

### 3. Vega sniper (`bot:vega:{i}:{releaseAt}`)

- **Role:** **Volatility event** bot — accumulate ATM straddle before a shock, dump after.
- **Prepare:** `prepareVolEvent` (scripted `vega_prepare` one game minute before the Dis-correlation shock at minute **167**; lead = `ENGINE_MINUTE_MS`).
- **Accumulate:** Market-buy nearest call+put per underlying.
- **Dump:** At `releaseAt`, market-sell all held option qty (`resolveVolEvent` / `vega_resolve` on public shock news).
- Runner also opens an option cycle so contracts survive until the dump.

### 4. Put–call parity arb (`bot:parity:{i}`)

- **Role:** Exploit **parity violations** vs the book (threshold **> 2** price units).
- **Rich synthetic:** Sell call, buy put, buy stock (IOC limits at touch).
- **Cheap synthetic:** Opposite legs.
- **Execution:** **Atomic multi-leg batch** via `placeAtomicOrders` (not single orders).

### 5. ETF / basket arb (`bot:etf:{i}`) — tied to `parityArbers`

- **Role:** Trade **ETF vs weighted basket** when NAV dislocation exceeds ETF tick.
- **Same** `parityArbers` count and `intensity` as parity bots; requires `setEtfs()` from markets manager.
- Also uses atomic IOC batches.

---

## Event hooks (not separate bot types)

| Mechanism | Effect on bots |
|-----------|----------------|
| **`newsPulse(momentum, volEvent)`** | Momentum bots; `volEvent` can flip vega snipers to dump |
| **`bot_volatility` (×3 at min 202)** | `setVolatilityMultiplier` on engine + Eden HFT/options quoting |
| **`vega_prepare` / `vega_resolve`** | Vega accumulate / dump schedule |
| **Halftime `frozen`** | All `botTick` activity stops |

Engine **autonomous price drift** also uses `volatilityMultiplier` (`packages/core/src/engine.ts`); that is separate from bot order logic but affects the tape classic MMs quote around.

---

## Suggested markdown file

Save as `docs/bots.md` (or ask in Agent mode to create it):

```markdown
# Autonomous trading bots

Quantstorm runs synthetic agents alongside human traders through the same matching engine. They use non-UUID user IDs (`bot:*`) so fills do not appear on the leaderboard.

**Implementation:** `apps/engine/src/bots.ts` (classic), `apps/engine/src/eden-bots.ts` (New Eden), driven by `apps/engine/src/runner.ts` → `botTick()`.

**Cadence:** `ENGINE_BOT_MS` (default 1200 ms). Bot ticks are skipped while the challenge is **frozen** (New Eden halftime).

**Configuration:** `packages/shared/src/schemas.ts` — `BotConfig`, `EdenBotConfig`. Live updates: `POST /api/admin/:id/bots`.

---

## Which engine runs?

| Challenge type | Config path | Engine class |
|----------------|-------------|--------------|
| `directional`, `market_making` | `config.bots` | `BotEngine` |
| `new_eden` | `config.eden.bots` | `EdenBotEngine` |

If `EdenBotEngine` is active, classic bots are **not** used on that challenge.

---

## Classic bots (`BotEngine`)

For directional and market-making events without the New Eden economy.

### Market makers (`bot:mm:{i}`)

| Aspect | Behavior |
|--------|----------|
| **Purpose** | Provide continuous two-sided liquidity |
| **Order type** | Limit, cancel-replace every bot tick |
| **Reference price** | Last/mid from the engine |
| **Spread** | `spread + rank × tickSize` per bot index |
| **Size** | `quoteSize` per side |
| **Count** | `marketMakers` (0–10) |

### Noise traders (`bot:noise:{i}`)

| Aspect | Behavior |
|--------|----------|
| **Purpose** | Generate taker flow for spread capture |
| **Order type** | Market |
| **Frequency** | Per bot, per tick: act with probability `intensity` |
| **Size** | Random 1 … `quoteSize` |
| **Count** | `noiseTraders` (0–30) |

### Shared tuning (`BotConfig`)

- **`spread`** — MM half-spread around mid (price units)
- **`quoteSize`** — Resting size per MM quote
- **`intensity`** — Noise trader activity (0–1)

---

## New Eden bots (`EdenBotEngine`)

Four archetypes from the tournament design (`comp_desc` Section 4). All share `spread`, `quoteSize`, and `intensity` on `EdenBotConfig`.

### HFT market makers (`bot:hft:{i}`)

| Aspect | Behavior |
|--------|----------|
| **Purpose** | Quote spots and options around **fair value** |
| **Spots** | Bid/ask around `getFairValue` (fallback: last price) |
| **Options** | Theoretical price from underlying FV, symbol vol, time to expiry, and `volatilityMultiplier` |
| **Inventory** | Widen and skew quotes against position |
| **Count** | `hftMarketMakers` (0–10) |

### Momentum / retail (`bot:mom:{i}`)

| Aspect | Behavior |
|--------|----------|
| **Purpose** | Chase headline **momentum** pulses (signal or noise) |
| **Input** | `MomentumEffect[]` — `{ symbol, sentiment }`, sentiment ∈ [-1, 1] |
| **Duration** | 4 bot ticks after each pulse |
| **Orders** | Market on symbol; size ∝ `\|sentiment\|`, `quoteSize`, random factor |
| **Extra** | If sentiment > 0, also market-buy nearest ATM **call** |
| **Sources** | Scripted public news, admin news (`momentum` / auto from FV), engine command |
| **Count** | `momentumTraders` (0–30) |

Humans can fade **noise** headlines that still move momentum bots (see `zPostNewsInput` in schemas).

### Vega snipers (`bot:vega:{i}:{releaseAt}`)

| Aspect | Behavior |
|--------|----------|
| **Purpose** | Buy volatility before a flagged event, sell into the crush |
| **Prepare** | `prepareVolEvent(underlying, releaseAt, now, leadMs)` — default lead = one game minute |
| **Accumulate** | Market-buy nearest ATM call + put straddle |
| **Dump** | At `releaseAt`, market-sell all held option contracts |
| **Script** | `vega_prepare` at game minute 166; shock + `vega_resolve` at minute 167 (`AERIUM`) |
| **Count** | `vegaSnipers` (0–10) |

### Parity arbitrageurs (`bot:parity:{i}`)

| Aspect | Behavior |
|--------|----------|
| **Purpose** | Enforce put–call parity when the book is mispriced |
| **Trigger** | Parity violation > 2 (price units) vs best bid/ask |
| **Execution** | 3-leg **atomic** IOC limit batch (call, put, underlying) |
| **Count** | `parityArbers` (0–10) |

### ETF / basket arbitrage (`bot:etf:{i}`)

| Aspect | Behavior |
|--------|----------|
| **Purpose** | Arbitrage ETF price vs weighted basket |
| **Control** | Same `parityArbers` count and `intensity` as parity bots |
| **Requires** | ETF definitions via `EdenBotEngine.setEtfs()` |
| **Execution** | Multi-leg atomic IOC batch (ETF + components) |

---

## Scripted timeline interactions

| Game minute | Action | Bot impact |
|-------------|--------|------------|
| **166** | `vega_prepare` | Start vega accumulation; extend option cycle |
| **167** | Dis-correlation shock news (`volEvent`) | Public momentum pulse; vega **dump** phase |
| **202** | `bot_volatility` ×3 | Wider HFT spreads; higher option theos; stronger autonomous price drift |

Source: `packages/shared/src/eden-event.ts`, executor: `apps/engine/src/event-executor.ts`.

---

## Default presets

| Constant | Use | Typical counts |
|----------|-----|----------------|
| `EDEN_EXCHANGE_BOTS` | Seeded New Eden Exchange | 1 HFT, 1 momentum, 1 vega, 1 parity; intensity 0.2 |
| `EDEN_DEMO_BOTS` | QuantStorm Practice | 2 HFT, 1 momentum |
| `EDEN_EVENT_BOTS` | Admin form / host console baseline | All zeros |

Defined in `packages/shared/src/eden-presets.ts`.

---

## Admin surfaces

- **Classic bots:** Challenge builder → “Autonomous agents” (`ChallengeForm.tsx`)
- **Eden bots:** Same form → “Bot ecosystem”; live **Apply bots** via `/api/admin/:id/bots`
- **Host console:** Eden bot counts + news fields `momentum`, `volEvent` (`EdenHostConsole.tsx`, news POST)

---

## Related reading

- `AGENTS.md` — architecture overview
- `packages/shared/src/schemas.ts` — `zMomentumEffect`, `zPostNewsInput`
- `docs/EVENT-IMPLEMENTATION.md` — timeline and recovery
```

---

## Quick reference: bot IDs

| ID pattern | Archetype |
|------------|-----------|
| `bot:mm:{i}` | Classic market maker |
| `bot:noise:{i}` | Classic noise trader |
| `bot:hft:{i}` | Eden HFT MM |
| `bot:mom:{i}` | Eden momentum |
| `bot:vega:{i}:{releaseAt}` | Eden vega sniper |
| `bot:parity:{i}` | Put–call parity |
| `bot:etf:{i}` | ETF basket arb |

If you switch to **Agent mode**, I can add `docs/bots.md` with this content and optionally link it from `AGENTS.md`.
