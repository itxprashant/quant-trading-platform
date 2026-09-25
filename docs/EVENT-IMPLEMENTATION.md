# New Eden Implementation And Rollout

## Current Implementation

The event is implemented across engine, API, gateway, scoring, and trader/host UI. This describes the current code, not live verification. Schema and legacy backfill have **not been applied** in the reported validation environment.

- `packages/shared/src/eden-event.ts` owns the versioned 130-game-minute schedule, constants, and structural recovery selector. `apps/engine/src/event-timeline.ts` dispatches ordered due actions; `event-executor.ts` implements listings, news, offers, and event operations.
- `ChallengeRunner` owns the timeline under the existing per-challenge Redis lock and serialized mutation queue. `EdenSettlements`, `OptionsManager`, and `MarketsManager` own financial operations; API requests still reach the engine through Redis commands.
- `packages/db/src/schema.ts` includes `event_actions`, `engine_checkpoints`, news effect markers, OTC choices/deadlines, loan funding/schedules, `challenges.finalizedAt`, and **`challenges.finalResults` (`final_results`)**. These are present, not future integration contracts.
- `Persistence.flush` commits queued relational writes, engine checkpoint, command/minute progress, and an optional completed receipt together. Receipts have unique `(challenge_id, action_id)` and `completed_at`, not a pending/status state.
- REST and WebSocket paths expose event state, sanitized/private news, offers, loans, portfolios, and rankings. Trader progress/panels and the host console consume them; scripted news is excluded from the competing generic effects path.

## Configuration And Clock

Use `type: "new_eden"`, `config.eden.rules.enabled: true`, and `config.eden.eventScript: true`. Seeded new Eden events opt in; reseeding does not convert existing challenges. Never enable the script on an already running legacy event.

The seed/admin preset starts with **AERIUM only**, $10,000 cash, `bonds: []`, `etfs: []`, and options disabled with `autoCycle: true`. Bond templates are added at minutes 10/18, not installed at start. Bots default to 0 of each archetype; raise the counts in the challenge form to enable them. Instrument-dependent activity waits for listings.

Persist `startsAt` before starting. If the host flips the challenge live before `startsAt`, the runner starts but holds the market frozen until the minute-0 open, and the host cannot unfreeze it early (nor during the 60–70 halftime). Scripted `endsAt = startsAt + 130 * ENGINE_MINUTE_MS`; the default game minute is 60,000 ms. All engine instances and the backfill must use the same actual clock scale. `ENGINE_TICK_MS` is not the game-minute setting. Keep start, scale, schedule version, and action IDs immutable after start; do not duplicate script-owned operations with manual host actions.

Timeline seconds scale by `ENGINE_MINUTE_MS / 60`: premium leads, auction bidding, OTC reply deadlines, ETF windows, and votes follow that game clock. **Option exercise is strictly 15 wall seconds after expiry; OTC bargaining delay is 5 wall seconds** (`clock_timestamp() + interval '5 seconds'`). Accelerated rehearsal therefore does not reproduce identical wall-time interaction windows or their relative overlap.

## Schedule And Economics

| Game Minute | Implemented Behavior |
| --- | --- |
| 0 | AERIUM opens at FV 1000. |
| 10 / 18 | Standard / Aerium-Pegged bonds become available. |
| 30 | NEURO lists at FV 500 before public news. |
| 45 | ORBITAL lists: 1 ETF = 2 AERIUM + 1 NEURO. |
| 45, 55, 75, 85, 95, 105, 115, 125 | ETF conversion opens for 30 game seconds; no minute-65 window. |
| 60 / 70 | Halftime freeze / reopen, retaining books and inventory. |
| 70 | AERIUM calls/puts open on five-game-minute cycles; manual exercise only. |
| 15, 30, 45, 75, 90, 105, 120 | Explicit premium auction rounds; no minute-60 auction. |
| 80 / 81 | Solidarity Tax vote opens / resolves. |
| 89 / 90 | Vega prepares straddles / dumps after the public FV shock. |
| 100 / 105 | AERIUM grant announced / awarded. |
| 120 | Bot volatility multiplier becomes 3 relative to base. |
| 130 | Final halt, option shutdown, debt closeout, durable rankings, completion announcement. |

- **Auctions:** Each opens 40 game seconds before its explicit round, bids for 30 seconds, then resolves 10 seconds before public news. Resolution precedes premium delivery at the same timestamp. Access is `[round - 10s, round + 15m - 10s)`, not a fresh entitlement on late recovery. Core selects `max(1, round(n * 0.3))`, capped at `n`, for valid positive bids; zero bidders gives no winners and null cutoff. Ties are bid descending, then user ID ascending, **not submission timestamp**.
- **News:** Exactly 24 public slots at 5..60 and 70..125 yield **12 SIGNAL / 12 NOISE**; no slot at 65 or closing ticker pair at 130. The 45/70 official introductions count as signals because preceding listing actions establish instrument FVs; their additive effects are empty. This classification and supplied introduction wording are implementation defaults. The minute-60 halt remains a headline; final completion is a separate implemented alert.
- **Information boundaries:** Premium release is targeted to eligible humans and does not change FV or trigger bots. Public effects atomically store absolute FVs with `effectsAppliedAt` before engine/cache refresh. Classification, FV effects, and momentum/volatility metadata are not trader payloads. At 69:50 premium introduction delivery occurs while frozen; at 70 reopening/options listing precedes the public introduction.
- **FV and correlation:** Minute 55 caps AERIUM FV at 1150, not resets it; the scripted FV is already 1110, so only bearish momentum changes there. Without overrides, final underlying FVs are AERIUM 930 / NEURO 700. Before minute 90, the runner's autonomous AERIUM/NEURO ticks each use `0.8 * commonShock + 0.2 * Math.random()`; from 90 they use independent draws. This is a common stochastic component, not a promised 0.8 realized price correlation; explicit drift overrides bypass it.
- **Arbitrage:** Put-call parity and ETF/basket arbitrage are both implemented in `eden-bots.ts`. The runner submits their price-bounded multi-leg batches through core `placeAtomicOrders`, which rolls back batches that cannot fully execute. This is engine-state atomicity, not a cross-system messaging guarantee.
- **Bonds:** Each government series can be bought once. The trader picks a principal that cannot exceed free cash, pays it immediately, and receives that amount × the payout multiplier (default 2) in equal game-minute credits through `endsAt`. Outstanding principal is marked at cost × remaining payout fraction. Coupons and pegged yields are no longer used.
- **Tax/grant defaults:** Tax ranks human traders by cash, not MtM wealth, and requires a strict majority of votes cast; ties/no votes fail. The current core tax helper uses rounded, minimum-one top/bottom cohorts, which can overlap in small groups. Grant uses core `grantWinners`: only **positive** holdings of the grant symbol qualify. Tied leaders each receive an equal share of the prize; all-flat, all-short, or empty cohorts receive no award.
- **Halftime and loans:** Status stays `live` with `frozen = true`; matching/new risk stops but timeline and carry continue. Bond payouts skip the freeze, and due loan dates are pushed forward so the break is not billed. Margin liquidation is deferred until reopening. `paused` tears down the runner and is not halftime. Negative-cash humans receive publicly announced rescue loans at 60; funded debt is **2x principal**, repaid in equal installments over remaining game minutes, with residual debt due at event end. Funding remains engine-owned; null `fundedAt` is not proof that cash should be credited.
- **Options and finalization:** Exercise is rejected at or beyond the strict wall-time deadline, including delayed processing. Assignment has a 30-second grace path; only the excess over the inventory cap is closed at a 20% adverse border price. At finalization, remaining options expire worthless (no automatic exercise), working orders are cancelled, remaining loan debt is deducted, and a final checkpoint is flushed. Final scoring stores snapshots and `finalResults`, publishes rankings, then the runner marks `finalizedAt` and broadcasts: "Trading halted. Final mark-to-market and rankings are complete."

## OTC Reservations And Limits

Thirteen scheduled slots run from 2.5 through 122.5 every ten game minutes; 62.5 is skipped during halftime. Each eligible human trader enrolled by the scheduled time receives a deterministic private offer. Expired windows, unavailable instruments, or no eligible recipients produce no fresh actionable offer. Prices, selected runtime instruments, and choices are persisted, not repriced on retry.

- The 32.5 swap exchanges 20 AERIUM for 20 NEURO at zero net cash. The 72.5 active ATM-call bid is `1.2 * intrinsic`, possibly zero, not a premium markup. Percentage offers use current FV/NAV; the 12.5 block therefore costs $49,875 at FV 1050, not the playbook's $47,500 illustration.
- The playbook leaves the other slots unspecified; they offer a generic 5 AERIUM at FV. At 2.5 that is about half of the $10,000 starting cash, so accepting it cannot by itself exhaust cash and trigger a margin call.
- Bailouts snapshot positive tradeable holdings at 90% FV. ACCEPT/BARGAIN must select one offered symbol and an integer quantity `1..min(50, snapshotted holding)`; server-stored prices/legs govern. Ordinary offers cannot be rewritten with choice fields. Signed leg prices already encode cash exchange.
- **HTTP acceptance is provisional until engine confirmation.** The API stores the response/deadline and enqueues work. Before the next mutation, the runner cancels that user's working orders, attempts to reserve position capacity, and checkpoints reservation/outcome. Only the subsequent `otc_result: accepted` confirms a binding deal; failed reservation rejects the provisional request without executing a trade.
- Reservations survive checkpoints and reduce capacity available to later orders and off-book operations. Responses already recorded as accepted cannot be edited/rejected during the delay; new accepts/bargains are disallowed while frozen. A confirmed deal is not voided by later news, a closed book, or changed positions.
- Assignment can exceed reserved capacity; **the confirmed OTC obligation remains binding**. Settlement may bypass the ordinary capacity check, cancel conflicting working orders, and emit an over-cap alert. This does not itself apply an automatic penalty or assignment grace. A removed/expired instrument leaves the accepted obligation for host review without moving cash/inventory; invalid numerical terms reject settlement. Reservations are not a guarantee against every later exposure breach.

## Recovery Boundaries

Due unreceipted actions run chronologically, using original scheduled deadlines rather than extending windows after downtime. A failed action blocks later actions until retry; deterministic action/resource IDs and durable outcome guards support recovery. Restore checkpointed books, portfolios, reservations, progress, and absolute FVs, not just the structural schedule selector. Suppress obsolete premium delivery and expired openings; bot impulses more than five game minutes late are suppressed.

Executor config/news transactions are separate from checkpoint/receipt commits, and Redis broadcasts are not a transactional outbox. A crash after an effect commit can lose a notification or bot impulse; retries can repeat headlines. Final results are durable and reused on retry, but the completion alert is not guaranteed to reach every client. Lock-loss/fencing and cross-process recovery still require real-infrastructure acceptance; receipt uniqueness alone does not protect arbitrary side effects.

Downtime cannot retroactively provide premium access or reconstruct historical holdings without a ledger. Report missed interaction windows rather than claiming historically exact execution. Frozen carry/debt obligations and accepted OTC exceptions must be included in recovery rehearsal.

## Safe Schema Rollout

Before updated services start, back up the target database and rehearse on a restored non-production snapshot. Stop API/engine writers and other mutating workers, including scoring. A market freeze is insufficient; table locks cannot refresh already loaded in-memory portfolios. Review Drizzle's schema diff/prompts and **never approve drops or destructive changes** as part of this upgrade.

The schema push must include receipts/checkpoints and all news, OTC, loan, and finalization fields, including the existing `final_results` definition. Reseeding alone is not migration. Without legacy markers, old published news can apply again and old ended challenges can enter new finalization. Backfill never populates/reconstructs `finalResults`; existing results/snapshots remain authoritative, and historical null results must not trigger economic recalculation.

From the repository root, explicitly export the target `DATABASE_URL` and the event's actual `ENGINE_MINUTE_MS` if nondefault. The backfill uses `getDb()` but does **not** load `.env` itself. Set `LEGACY_CUTOFF` to the audited old/new deployment boundary, never an automatically generated current time.

```bash
pnpm db:push
pnpm --filter @qtp/db db:backfill-eden
pnpm --filter @qtp/db db:backfill-eden --legacy-cutoff="$LEGACY_CUTOFF"
# Review qualified counts and blockers; keep writers stopped before applying.
pnpm --filter @qtp/db db:backfill-eden --apply --legacy-cutoff="$LEGACY_CUTOFF"
```

The backfill is explicit, not run by seed/startup. Record backup identity, cutoff, clock scale, and preview/apply counts. Restart writers only after successful validation and reconciliation. Do not change the clock or widen the cutoff simply to make migration pass.

### Completion Markers

- `--legacy-cutoff` requires a valid non-future UTC ISO timestamp: `YYYY-MM-DDTHH:mm:ssZ` or `.SSSZ`. Cutoff plus `--apply` acknowledges **preserving legacy effects/results, not replaying them**; there is no separate acknowledgement flag.
- No-cutoff dry run reports unmarked published-news and ended/unfinalized candidates, separately noting checkpointed challenges; proposed marker updates are zero. Candidate metadata is not proof that public effects or final scoring completed.
- Apply without cutoff aborts the entire transaction if unmarked published news or ended/unfinalized challenges without checkpoints exist. With no such candidates, loan-only upgrades and fresh-database no-ops can apply without cutoff.
- News qualifies only with `publishedAt < cutoff`, null `effectsAppliedAt`, and null embargo or `embargoUntil <= cutoff`. Set the marker to `max(publishedAt, embargoUntil)`, preserving stored timestamp precision. Publication exactly at cutoff is excluded; embargo exactly at cutoff is eligible; later embargoes are excluded. Existing markers are untouched; no FV/cash changes, broadcasts, or replay occur.
- Publication, particularly premium publication, does not prove public effects happened. Audit that eligible effects were already accounted for. If any are genuinely pending, stop and reconcile; marking them would suppress legitimate work. The tool cannot infer this from timestamps.
- Ended rows qualify across challenge types only with `createdAt < cutoff`, `status = 'ended'`, null `finalizedAt`, and **no checkpoint**. Only `finalizedAt = cutoff` is written; no status change, restart, settlement, scoring, or snapshot/result rewrite. Creation time is not an end timestamp: verify that every eligible row really belongs to the completed legacy deployment, not a recently ended old-created event. Checkpointed rows stay on new recovery paths.
- Loan plans and both marker categories validate/apply in one transaction. Apply locks include news and checkpoints, preventing checkpoint insertion between eligibility and marker writes. Any loan failure blocks marker writes too. Repeating the same cutoff does not overwrite completed markers.

### Legacy Loan Reconciliation

- Candidates require `installment = 0`, null `nextPaymentAt`, and null `fundedAt`. New scheduled requests and migrated rows are not re-funded or overwritten.
- Participant `loanDebt` is authoritative. Allocate it to old active loans in stable `createdAt, id` FIFO order, capped by each `totalRepay`; ignore stale `remaining`. Allocated debt must match **exactly**, without cent rounding or changing participant cash/debt to force a match. Zero allocations become repaid; old repaid rows stay repaid with zero remaining.
- Migrated rows get `fundedAt = createdAt`. There is no cash credit, new funding command, debt adjustment, checkpoint rewrite, or table drop. Successfully migrated rows are no longer candidates.
- For each positive allocation, installment is `remaining / max(1, ceil((endsAt - migrationTime) / ENGINE_MINUTE_MS))`. Schedule backwards from persisted `endsAt` at game-minute intervals, last payment at that deadline. An elapsed deadline makes the remainder due at the historical end; the backfill itself does not deduct it.
- A candidate group on a live challenge without `endsAt` blocks the operation. Any legacy active loan without an end also blocks it, including paused/ended challenges. Set the correct historical end before retrying; never invent a repayment horizon.
- Missing participants, invalid/negative debt or repayment totals, insufficient FIFO capacity, unallocatable debt, and mixed legacy/new active loans block the transaction for manual reconciliation. Aggregate debt is not guessed apart between old loans and newer funded/pending requests.
- Dry run uses a read-only repeatable-read snapshot. Apply revalidates in one transaction with table locks and a five-second lock timeout; any failure rolls back every update. A preview is not a reservation. Output contains counts/cutoff/fixed diagnostics, not credentials, connection URLs, or individual portfolio values.

## Validation And Release Gates

Reported validation baseline: **`pnpm test`: 301 passing** (171 core, 65 engine, 39 API, 21 scoring, 5 web), plus **36 separate backfill tests**. Full workspace typecheck passed; an isolated production web build passed. The ordinary build was blocked by filesystem permissions, not established as passing. These are recorded results, not a claim that this documentation edit reran them.

```bash
pnpm test
pnpm typecheck
pnpm --filter @qtp/core exec vitest run --root ../db src/backfill-eden.test.ts
```

The separate backfill harness is mocked and not part of the DB package test script. Much integration coverage also uses mocks. No database infrastructure was available for the reported checks; **schema push and backfill remain unapplied**, and no live/end-to-end acceptance is asserted.

Before release, validate schema plus dry-run/apply on a restored PostgreSQL snapshot; compare unchanged cash/debt, FVs, and historical results, then confirm a no-op second apply with the same cutoff. Resolve all blockers before restarting writers. Deploy reviewed prebuilt CI registry images rather than routine on-VM compilation.

Operational acceptance still requires actual **PostgreSQL/Redis isolation and failover**, lock-loss/restart and messaging-gap exercises, sustained load/backpressure tests, and full trader/host browser acceptance. Cover auction privacy, provisional OTC confirmation/cancellation/reservations, wall-time exercise/bargaining, halftime deductions/deferred liquidation, reopening, and final durable rankings plus the implemented completion broadcast. Run accelerated and normal-clock interaction checks; neither mocked tests nor accelerated timing alone certifies production readiness.
