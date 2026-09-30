import {
  and,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  edenEventDurationMinutes,
  edenEventEndsAt,
  edenEventFlow,
  type ChallengeConfig,
} from "@qtp/shared";
import type { Database } from "./client.js";
import {
  auctionBids,
  auctions,
  bondHoldings,
  challengeCheckpoints,
  challengeNews,
  challenges,
  engineCheckpoints,
  eventActions,
  fairValues,
  grantMissions,
  loans,
  optionContracts,
  optionCycles,
  orders,
  otcOffers,
  participants,
  positions,
  scoreSnapshots,
  trades,
  users,
  voteBallots,
  voteProposals,
} from "./schema.js";

/** Rewind points kept per challenge: five hours at the two-minute cadence. */
export const CHECKPOINT_RETENTION = 150;

/**
 * Challenge rows the engine reloads from Postgres rather than its own state.
 * Parents precede children: inserts run in this order, deletes in reverse.
 */
const SATELLITES = [
  ["challengeNews", challengeNews],
  ["fairValues", fairValues],
  ["loans", loans],
  ["bondHoldings", bondHoldings],
  ["optionCycles", optionCycles],
  ["optionContracts", optionContracts],
  ["otcOffers", otcOffers],
  ["auctions", auctions],
  ["auctionBids", auctionBids],
  ["voteProposals", voteProposals],
  ["voteBallots", voteBallots],
  ["grantMissions", grantMissions],
] as const;

export type CheckpointTable = (typeof SATELLITES)[number][0];
export type CheckpointRow = Record<string, unknown>;

export interface CheckpointPayload {
  version: 1;
  /** Engine game-minute length when taken; a resume sizes the event with it. */
  minuteMs: number;
  challenge: {
    config: ChallengeConfig;
    startsAt: string | null;
    endsAt: string | null;
    frozen: boolean;
  };
  engine: { state: unknown; minuteCount: number };
  /** Orders open in Postgres when taken, including commands not yet matched. */
  openOrderIds: string[];
  receipts: Array<{ actionId: string; completedAt: string }>;
  rows: Record<CheckpointTable, CheckpointRow[]>;
  /** `CheckpointRedisState` from `@qtp/bus`. */
  redis: unknown;
}

export interface CheckpointCapture {
  challengeId: string;
  takenAt: Date;
  reason: "auto" | "before_resume";
  minuteMs: number;
  engine: { state: unknown; minuteCount: number };
  redis: unknown;
}

export interface CheckpointAccount {
  userId: string;
  cash: number;
  loanDebt: number;
  positions: Array<{ symbol: string; quantity: number; avgPrice: number }>;
}

export interface CheckpointRestore {
  challengeId: string;
  payload: CheckpointPayload;
  takenAt: Date;
  shiftMs: number;
  startsAt: Date | null;
  endsAt: Date | null;
  /** Engine state with its wall-clock times already shifted. */
  engineState: unknown;
  /** Command stream tip; the next runner resumes after it. */
  cursor: string;
  accounts: readonly CheckpointAccount[];
  /** Human orders resting in the restored book, with their remaining size. */
  resting: ReadonlyMap<string, number>;
  startingCash: number;
}

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Transaction;

function scope(
  db: Executor,
  name: CheckpointTable,
  table: PgTable,
  challengeId: string,
): SQL {
  if (name === "auctionBids")
    return inArray(
      auctionBids.auctionId,
      db
        .select({ id: auctions.id })
        .from(auctions)
        .where(eq(auctions.challengeId, challengeId)),
    );
  if (name === "voteBallots")
    return inArray(
      voteBallots.proposalId,
      db
        .select({ id: voteProposals.id })
        .from(voteProposals)
        .where(eq(voteProposals.challengeId, challengeId)),
    );
  const columns = getTableColumns(table) as Record<string, PgColumn>;
  return eq(columns.challengeId!, challengeId);
}

/** Timestamp columns arrive as ISO strings from the JSON payload. */
export function shiftCheckpointRow(
  table: PgTable,
  row: CheckpointRow,
  shiftMs: number,
): CheckpointRow {
  const out: CheckpointRow = { ...row };
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    const value = row[key];
    if (column.dataType !== "date" || value == null) continue;
    const ms =
      value instanceof Date ? value.getTime() : Date.parse(String(value));
    out[key] = new Date(ms + shiftMs);
  }
  return out;
}

const PREMIUM_RECEIPT = /^(auction:[^:]+:premium:)(\d+)$/;

/** Premium-feed receipts embed their expiry (epoch ms) in the action id. */
export function shiftReceiptId(actionId: string, shiftMs: number): string {
  const match = PREMIUM_RECEIPT.exec(actionId);
  return match
    ? `${match[1]}${Math.trunc(Number(match[2]) + shiftMs)}`
    : actionId;
}

/** Receipts slide with the clock, so a half-run cue keeps its step offsets. */
export function shiftReceipts(
  receipts: CheckpointPayload["receipts"],
  shiftMs: number,
): Array<{ actionId: string; completedAt: Date }> {
  return receipts.map((r) => ({
    actionId: shiftReceiptId(r.actionId, shiftMs),
    completedAt: new Date(Date.parse(r.completedAt) + shiftMs),
  }));
}

/** The checkpoint's elapsed game time ends at the moment of the resume. */
export function resumedStartsAt(
  payload: CheckpointPayload,
  shiftMs: number,
): Date | null {
  const start = payload.challenge.startsAt;
  return start == null ? null : new Date(Date.parse(start) + shiftMs);
}

/**
 * Playbook events run their event duration from the (shifted) market open;
 * host-run events keep their configured length.
 */
export function resumedEndsAt(
  payload: CheckpointPayload,
  shiftMs: number,
): Date | null {
  const flow = edenEventFlow(payload.challenge.config.eden);
  if (edenEventDurationMinutes(flow) == null) {
    const end = payload.challenge.endsAt;
    return end == null ? null : new Date(Date.parse(end) + shiftMs);
  }
  const startsAt = resumedStartsAt(payload, shiftMs);
  if (!startsAt) return null;
  const opened = payload.receipts.find((r) => r.actionId.endsWith("/cue/open"));
  const end = edenEventEndsAt(
    flow,
    startsAt.getTime(),
    opened ? Date.parse(opened.completedAt) + shiftMs : null,
    payload.minuteMs,
  );
  return end == null ? null : new Date(end);
}

/** Rows owned by deleted accounts cannot be re-inserted. */
function withKnownUsers(
  row: CheckpointRow,
  known: ReadonlySet<string>,
): CheckpointRow | null {
  if (typeof row.userId === "string" && !known.has(row.userId)) return null;
  const out = { ...row };
  for (const key of ["createdBy", "winnerId"]) {
    const value = out[key];
    if (typeof value === "string" && !known.has(value)) out[key] = null;
  }
  return out;
}

async function readPayload(
  tx: Transaction,
  capture: CheckpointCapture,
): Promise<CheckpointPayload> {
  const { challengeId } = capture;
  const [challenge] = await tx
    .select({
      config: challenges.config,
      startsAt: challenges.startsAt,
      endsAt: challenges.endsAt,
      frozen: challenges.frozen,
    })
    .from(challenges)
    .where(eq(challenges.id, challengeId));
  if (!challenge) throw new Error(`Challenge ${challengeId} not found`);
  const receipts = await tx
    .select({
      actionId: eventActions.actionId,
      completedAt: eventActions.completedAt,
    })
    .from(eventActions)
    .where(eq(eventActions.challengeId, challengeId));
  const open = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.challengeId, challengeId),
        inArray(orders.status, ["open", "partially_filled"]),
      ),
    );
  const rows = {} as Record<CheckpointTable, CheckpointRow[]>;
  for (const [name, table] of SATELLITES) {
    rows[name] = await tx
      .select()
      .from(table as PgTable)
      .where(scope(tx, name, table, challengeId));
  }
  return {
    version: 1,
    minuteMs: capture.minuteMs,
    challenge: {
      config: challenge.config,
      startsAt: challenge.startsAt?.toISOString() ?? null,
      endsAt: challenge.endsAt?.toISOString() ?? null,
      frozen: challenge.frozen,
    },
    engine: capture.engine,
    openOrderIds: open.map((o) => o.id),
    receipts: receipts.map((r) => ({
      actionId: r.actionId,
      completedAt: r.completedAt.toISOString(),
    })),
    rows,
    redis: capture.redis,
  };
}

/** Store a rewind point and drop the oldest beyond the retention window. */
export async function saveChallengeCheckpoint(
  db: Database,
  capture: CheckpointCapture,
): Promise<string> {
  const payload = await db.transaction((tx) => readPayload(tx, capture), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
  const [row] = await db
    .insert(challengeCheckpoints)
    .values({
      challengeId: capture.challengeId,
      takenAt: capture.takenAt,
      minuteCount: capture.engine.minuteCount,
      reason: capture.reason,
      payload,
    })
    .returning({ id: challengeCheckpoints.id });
  await db
    .delete(challengeCheckpoints)
    .where(
      and(
        eq(challengeCheckpoints.challengeId, capture.challengeId),
        notInArray(
          challengeCheckpoints.id,
          db
            .select({ id: challengeCheckpoints.id })
            .from(challengeCheckpoints)
            .where(eq(challengeCheckpoints.challengeId, capture.challengeId))
            .orderBy(desc(challengeCheckpoints.takenAt))
            .limit(CHECKPOINT_RETENTION),
        ),
      ),
    );
  return row!.id;
}

async function insertRows(
  tx: Transaction,
  table: PgTable,
  rows: CheckpointRow[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 500)
    await tx.insert(table).values(rows.slice(i, i + 500));
}

/**
 * Rewrite a challenge's Postgres state to a checkpoint inside the caller's
 * transaction. The caller owns the engine lock and the challenge status.
 */
export async function restoreChallengeCheckpoint(
  tx: Transaction,
  input: CheckpointRestore,
): Promise<void> {
  const { challengeId, payload, shiftMs, takenAt } = input;
  const now = new Date();
  const minuteCount = payload.engine.minuteCount;

  await tx
    .update(challenges)
    .set({
      config: payload.challenge.config,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      frozen: payload.challenge.frozen,
    })
    .where(eq(challenges.id, challengeId));
  await tx
    .insert(engineCheckpoints)
    .values({
      challengeId,
      state: input.engineState,
      cursor: input.cursor,
      minuteCount,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: engineCheckpoints.challengeId,
      set: {
        state: input.engineState,
        cursor: input.cursor,
        minuteCount,
        updatedAt: now,
      },
    });

  // Receipts from after the checkpoint disappear, so those steps run again.
  await tx.delete(eventActions).where(eq(eventActions.challengeId, challengeId));
  await insertRows(
    tx,
    eventActions,
    shiftReceipts(payload.receipts, shiftMs).map((r) => ({ challengeId, ...r })),
  );

  const known = new Set(
    (await tx.select({ id: users.id }).from(users)).map((u) => u.id),
  );
  for (const [name, table] of [...SATELLITES].reverse())
    await tx.delete(table as PgTable).where(scope(tx, name, table, challengeId));
  for (const [name, table] of SATELLITES) {
    const rows = (payload.rows[name] ?? []).flatMap((row) => {
      const kept = withKnownUsers(row, known);
      return kept ? [shiftCheckpointRow(table, kept, shiftMs)] : [];
    });
    await insertRows(tx, table, rows);
  }

  const accounts = input.accounts.filter((a) => known.has(a.userId));
  if (accounts.length > 0)
    await tx
      .insert(participants)
      .values(
        accounts.map((a) => ({
          challengeId,
          userId: a.userId,
          startingCash: input.startingCash,
          cash: a.cash,
          loanDebt: a.loanDebt,
        })),
      )
      .onConflictDoUpdate({
        target: [participants.challengeId, participants.userId],
        set: {
          cash: sql`excluded.cash`,
          loanDebt: sql`excluded.loan_debt`,
        },
      });
  // Traders the checkpoint never saw start fresh, as the engine will treat them.
  const seen = new Set(accounts.map((a) => a.userId));
  const fresh = (
    await tx
      .select({ userId: participants.userId })
      .from(participants)
      .where(eq(participants.challengeId, challengeId))
  )
    .map((p) => p.userId)
    .filter((userId) => !seen.has(userId));
  if (fresh.length > 0)
    await tx
      .update(participants)
      .set({ cash: input.startingCash, loanDebt: 0 })
      .where(
        and(
          eq(participants.challengeId, challengeId),
          inArray(participants.userId, fresh),
        ),
      );

  const held = accounts.flatMap((a) =>
    a.positions.map((p) => ({
      challengeId,
      userId: a.userId,
      symbol: p.symbol,
      quantity: p.quantity,
      avgPrice: p.avgPrice,
      updatedAt: now,
    })),
  );
  for (let i = 0; i < held.length; i += 500)
    await tx
      .insert(positions)
      .values(held.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [positions.challengeId, positions.userId, positions.symbol],
        set: {
          quantity: sql`excluded.quantity`,
          avgPrice: sql`excluded.avg_price`,
          updatedAt: now,
        },
      });
  const heldKeys = new Set(held.map((p) => `${p.userId}:${p.symbol}`));
  const cleared = (
    await tx
      .select({
        id: positions.id,
        userId: positions.userId,
        symbol: positions.symbol,
        quantity: positions.quantity,
      })
      .from(positions)
      .where(eq(positions.challengeId, challengeId))
  )
    .filter((p) => p.quantity !== 0 && !heldKeys.has(`${p.userId}:${p.symbol}`))
    .map((p) => p.id);
  if (cleared.length > 0)
    await tx
      .update(positions)
      .set({ quantity: 0, avgPrice: 0, updatedAt: now })
      .where(inArray(positions.id, cleared));

  const restingIds = [...input.resting.keys()];
  if (restingIds.length > 0) {
    const rows = await tx
      .select({ id: orders.id, quantity: orders.quantity })
      .from(orders)
      .where(
        and(eq(orders.challengeId, challengeId), inArray(orders.id, restingIds)),
      );
    for (const row of rows) {
      const remaining = input.resting.get(row.id) ?? row.quantity;
      await tx
        .update(orders)
        .set({
          remainingQuantity: remaining,
          status: remaining < row.quantity ? "partially_filled" : "open",
        })
        .where(eq(orders.id, row.id));
    }
  }
  // Working orders the restored book does not hold never happened.
  await tx
    .update(orders)
    .set({ status: "cancelled", remainingQuantity: sql`${orders.quantity}` })
    .where(
      and(
        eq(orders.challengeId, challengeId),
        or(
          inArray(orders.status, ["open", "partially_filled"]),
          gt(orders.createdAt, takenAt),
          payload.openOrderIds.length > 0
            ? inArray(orders.id, payload.openOrderIds)
            : undefined,
        ),
        restingIds.length > 0 ? notInArray(orders.id, restingIds) : undefined,
      ),
    );

  await tx
    .delete(trades)
    .where(
      and(eq(trades.challengeId, challengeId), gt(trades.executedAt, takenAt)),
    );
  await tx
    .delete(scoreSnapshots)
    .where(
      and(
        eq(scoreSnapshots.challengeId, challengeId),
        gt(scoreSnapshots.capturedAt, takenAt),
      ),
    );
}
