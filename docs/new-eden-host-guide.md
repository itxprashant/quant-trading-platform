# New Eden — Host Runbook

A practical guide for running a **New Eden** event on Quanta. It maps every
game mechanic to the concrete host action that drives it — which control in the
admin UI, and the REST endpoint underneath for scripting or emergencies.

New Eden is the `new_eden` challenge type: a richer economy on top of the core
matching engine with free cash, cost of carry, predatory loans, a fair-value
model, signal/noise news, an autonomous bot ecosystem, options, bonds, ETFs, an
OTC Deal Desk, a premium news auction, policy votes, and government grants.

---

## 1. Where the controls live

All host controls are on the **challenge detail page** in the admin app:

```
/admin/[challengeId]
```

The live operations panels appear once the challenge is `live` or `paused`:

| Panel | What it drives |
|-------|----------------|
| **Live price controls** | Drift a symbol toward a target, or hard-set a price |
| **Trader accounts** | Set an enrolled trader's cash and inventory directly (live only) |
| **Eden host console** | Options cycles, ETF windows, Deal Desk, premium auction, policy vote, government grant |
| **Live news** | Signal / noise headlines, fair-value deltas, volatility events, embargo |

The page header also has a **Leaderboard: Visible / Hidden** toggle, available
in every status (`POST /leaderboard-visibility` `{ hidden }`). While hidden,
traders see "Rankings are hidden by the host" in place of the table: the REST
leaderboard answers `403 leaderboard_hidden` and the gateway drops live
leaderboard updates for non-admins. Final rankings stay hidden after the event
until you reveal them (traders still see their own PnL and score in the
portfolio). Admins keep the full table, marked "Hidden from traders". Scoring
keeps running either way.

Below, every mechanic lists its **UI control** and the **API** call it issues.
All admin endpoints are under `POST /api/admin/:challengeId/...` and require an
admin JWT.

---

## 2. Before the event — setup

1. **Create the challenge** (`/admin/new`): set type to **New Eden**.
2. **Configure the economy** in the challenge form (`config.eden`):
   - **Rules** — starting cash, cost of carry per unit/minute, loan repay
     multiplier, margin-call threshold, forced liquidation, position cap.
   - **Bots** — counts for HFT market-makers, momentum traders, vega snipers,
     parity arbitrageurs, plus spread / quote size / intensity.
   - **Options** — enable, underlyings, cycle minutes, exercise window, auto
     cycle, strike steps.
   - **Bonds / ETFs** — bond templates (price, face, coupon or peg) and ETF
     baskets.
   - **Premium feed** — `auctionDurationSec`, `auctionWinnerFraction`,
     `premiumLeadSec`, `premiumAccessMinutes`.
3. **Schedule or start** the challenge. The engine auto-starts at `startsAt`, or
   flip it to `live` from the admin list.

> Tip: run a dry run first, then **Reset** (see §12) to clear all state before
> the real event.

---

## 3. Prices

| Action | UI | API |
|--------|----|-----|
| Drift a symbol toward a target | Live price controls → **Drift** | `POST /drift` `{ symbol, target, speed }` |
| Hard-set a price now | Live price controls → **Set** | `POST /price` `{ symbol, price }` |

Drift biases the random walk toward `target` at `speed` (1–10) and clears itself
once reached. Use hard-set sparingly — it is an instantaneous jump.

---

## 4. Fair value & the signal/noise game

Fair value (FV) is the "true" worth of each instrument. Traders never see the
news classification — they must infer signal from noise.

| Action | UI | API |
|--------|----|-----|
| Set a symbol's FV absolutely | — | `POST /fair-value` `{ symbol, fairValue }` |
| Read current FVs | host console (auto) | `GET /fair-value` |
| Post a headline | Live news | `POST /news` (see below) |

**News** (`POST /news`) is the main lever. Fields:

- `message`, `level` (`info` / `warning` / `urgent`).
- `kind`: **signal** (moves FV), **noise** (looks identical, moves nothing),
  or **neutral**.
- `fvEffects: [{ symbol, delta }]` — applied only when `kind = signal`.
- `momentum: [{ symbol, sentiment }]` — what the bot ecosystem chases. Omit on
  a signal and it is derived from `fvEffects`; **supply it on a noise headline**
  to make retail bots overreact while FV stays put (so sharp humans can fade).
- `volEvent: true` — flags a high-impact event; **vega snipers buy volatility**.
- `embargoSec` — delays the headline for non-premium traders (premium feed lead).

In the UI: pick **Kind**; for a signal, choose the **FV symbol + delta**; tick
**Volatility event** to wake the vega snipers.

---

## 5. Asset unlock (dynamic listing)

| Action | UI | API |
|--------|----|-----|
| Lock / unlock a symbol for trading | — | `POST /tradeable` `{ symbol, tradeable }` |

Use this to introduce an instrument mid-event. Locked symbols reject orders;
unlocking broadcasts an alert to all traders.

---

## 6. Loans & margin (mostly automatic)

The bank runs on the engine clock — no per-minute host action required:

- **Cost of carry** is charged on absolute inventory every game-minute.
- **Predatory loans** (taken by traders) bleed repayment over the time left.
- **Margin calls** fire when free cash crosses `marginCallThreshold`; if
  `forcedLiquidation` is on, positions are flattened at market.

Tune these via `config.eden.rules` at setup. The rules themselves have no live
override beyond prices / FV / news.

**Manual account override.** To correct a balance or hand out or remove
inventory, use the **Trader accounts** panel:

| Action | UI | API |
|--------|----|-----|
| List enrolled traders' stored cash and positions | Trader accounts (auto) | `GET /accounts` |
| Set a trader's cash and/or per-symbol quantity | Trader accounts → **Apply changes** | `POST /accounts/:userId` `{ cash?, positions?: [{ symbol, quantity, avgPrice? }] }` |

Values are **absolute**. Only the cash and symbols you send are changed, and
anything the trader filled on those fields in the meantime is replaced. The
engine applies the edit through the command stream, so it survives restarts.
Loan debt and trading metrics are left alone. A position that keeps its sign
keeps its average cost; a new or flipped one is costed at `avgPrice` or the
current mark. Margin rules apply to the result immediately, so setting cash too
low can trigger a margin call. The trader gets an alert and a refreshed
portfolio.

The API refuses edits when the challenge is not live (`409 challenge_not_live`),
when the user is not enrolled (`404 not_enrolled`), or when a symbol is neither
listed nor held (`400 unknown_symbol`).

---

## 7. Options

| Action | UI | API |
|--------|----|-----|
| Open a fresh cycle on all underlyings | Eden console → **Open cycle** | `POST /options/open` |
| Close a cycle (opens the exercise window) | Eden console → **Close** (per cycle) | `POST /options/close` `{ cycleId }` |

With `options.autoCycle` enabled the engine runs cycles continuously; otherwise
open and close them by hand. Closing a cycle starts the
`exerciseWindowSec` window in which traders may exercise in-the-money series;
unexercised contracts expire worthless. Assignment is pro-rata across shorts.

Traders trade and exercise options from the **Options** panel on the terminal.

---

## 8. Bonds & ETFs

| Action | UI | API |
|--------|----|-----|
| Open / close an ETF create-redeem window | Eden console → **Open/Close window** | `POST /etf-window` `{ etfSymbol, open }` |

Bonds are bought by traders directly (coupons accrue every 5 game-minutes;
fixed or pegged). ETF **create / redeem** against NAV is only allowed while the
window is open — open it briefly to let arbitrage close the NAV gap, then close
it. Traders act from the **Bonds & ETFs** panel.

---

## 9. Deal Desk (OTC)

| Action | UI | API |
|--------|----|-----|
| Send a binding OTC offer to a trader | Eden console → **Deal Desk offer** | `POST /otc` `{ userId, description, legs, cashToTrader, expiresSec }` |

Each `leg` is `{ symbol, quantity (signed: + trader receives, − delivers),
price }`. The trader sees a modal with a countdown and may **Accept**,
**Reject**, or **Bargain** a counter cash figure. Lowball counters are
probabilistically walked by the desk (distance below fair value). Accepted deals
settle atomically on the engine.

---

## 10. Premium feed — blind auctions

| Action | UI | API |
|--------|----|-----|
| Open an auction round | Eden console → **Open auction** | `POST /auction` `{ durationSec? }` |
| Resolve early (backstop) | — | `POST /auction/:auctionId/resolve` |

Traders submit one **sealed bid** for early news access. At the deadline the top
`auctionWinnerFraction` win and the **lowest winning bid is published as the
public cutoff**; winners get `premiumAccessMinutes` of early access. Resolution
is automatic at expiry (in-process timer) — the manual resolve is a backstop.

While a winner holds premium access, embargoed headlines (`embargoSec`) reach
them immediately and everyone else only after the embargo lifts.

On the trading screen, an open round appears as a bid card in the bottom-left
corner, and its countdown shows in the top-bar timers. The card shows the result
to each bidder. Winners see a **Premium** badge on the news feed. Their early
headlines carry an **Early · public in Ns** tag and pop up as bottom-right
toasts, and the same headline is not shown twice when it goes public.

---

## 11. Policy votes & government grants

**Policy vote (Solidarity Tax)**

| Action | UI | API |
|--------|----|-----|
| Open a vote | Eden console → **Open vote** | `POST /vote` `{ title, description, durationSec }` |
| Close early (backstop) | — | `POST /vote/:proposalId/close` |

Traders vote yes/no. On a passing wealth-tax vote the engine redistributes cash
from the wealthiest **10%** to the poorest **20%** (rate **10%**). Outcome is
broadcast; taxed/relieved traders get an alert and refreshed portfolios.

**Government grant (manufactured bubble)**

| Action | UI | API |
|--------|----|-----|
| Open a grant mission | Eden console → **Open grant** | `POST /grant` `{ symbol, description, prize, durationSec }` |
| Award early (backstop) | — | `POST /grant/:grantId/award` |

A grant banner with a countdown appears for traders. At the deadline the engine
awards the prize to the **largest holder** of the target symbol — incentivizing
a scramble for inventory. You can follow up with a signal/news/FV move.

---

## 12. Reset

| Action | UI | API |
|--------|----|-----|
| Wipe a challenge's trading state | (admin form) | `POST /reset` |

Reset clears orders, trades, positions, news, loans, bonds, OTC offers, option
cycles/contracts, auctions, votes, grants, and the related Redis keys; prices
return to their initial config and engines reload the challenge. It does **not**
delete the challenge, users, or schema.

---

## 13. Suggested session flow

1. Start the challenge; let bots and the autonomous price engine warm up.
2. Post a **signal** headline with an FV delta; watch the book converge.
3. Slip in a **noise** headline with explicit momentum — let humans fade it.
4. Open an **options cycle**; flag a **volatility event** before closing it.
5. Run a **premium auction**, then publish an embargoed headline so winners
   trade ahead of the field.
6. Open an **ETF window** to invite NAV arbitrage; close it.
7. Push an **OTC offer** to a whale; let the desk bargain.
8. Open a **government grant** on a symbol to manufacture a bubble.
9. Near the end, open a **Solidarity Tax** vote to shake up the leaderboard.
10. After the event, **Reset** to prepare for the next run.

---

## 14. Quick endpoint reference

All under `POST /api/admin/:challengeId` unless noted (admin JWT required):

```
/drift                         { symbol, target, speed }
/price                         { symbol, price }
/news                          { message, level, kind, fvEffects?, momentum?, volEvent?, embargoSec? }
/fair-value                    { symbol, fairValue }      (GET to read)
/tradeable                     { symbol, tradeable }
/accounts/:userId              { cash?, positions?: [{ symbol, quantity, avgPrice? }] }   (GET /accounts to read)
/options/open
/options/close                 { cycleId }
/etf-window                    { etfSymbol, open }
/otc                           { userId, description, legs[], cashToTrader, expiresSec }
/auction                       { durationSec? }
/auction/:auctionId/resolve
/vote                          { title, description, durationSec }
/vote/:proposalId/close
/grant                         { symbol, description, prize, durationSec }
/grant/:grantId/award
/leaderboard-visibility        { hidden }
/reset
```

Trader-facing reads (for reference): `GET /api/auctions/:challengeId`,
`GET /api/votes/:challengeId`, `GET /api/options/:challengeId`,
`GET /api/markets/:challengeId/bonds|etfs`, `GET /api/otc/:challengeId`.
