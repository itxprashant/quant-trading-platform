import { eq } from "drizzle-orm";
import type { ChallengeEngine } from "@qtp/core";
import {
  engineCheckpoints,
  eventActions,
  orders,
  participants,
  positions,
  trades,
  type Database,
} from "@qtp/db";
import type { EngineEvent, OrderStatus, TradeEvent } from "@qtp/shared";

export type DbTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

interface PendingOrder {
  status: OrderStatus;
  remaining: number;
}

/**
 * Buffers engine events and flushes them to Postgres in batches so the hot
 * matching loop is never blocked on database I/O. Each batch atomically commits
 * its projections, settlement writes, and a full engine checkpoint.
 */
export class Persistence {
  private tradeBuf: TradeEvent[] = [];
  private readonly pendingOrders = new Map<string, PendingOrder>();
  private readonly affectedUsers = new Set<string>();
  private pendingWrites: Array<(tx: DbTransaction) => Promise<void>> = [];
  private flushChain: Promise<void> = Promise.resolve();
  private progress: { cursor?: string; minuteCount?: number } = {};
  private commitGuard: () => void = () => {};

  constructor(
    private readonly db: Database,
    private readonly challengeId: string,
    private readonly engine: ChallengeEngine,
  ) {}

  collect(events: EngineEvent[]): void {
    for (const e of events) {
      if (e.type === "trade") {
        this.tradeBuf.push(e);
        this.affectedUsers.add(e.buyerId);
        this.affectedUsers.add(e.sellerId);
      } else if (e.type === "order_update") {
        if (e.orderId) {
          this.pendingOrders.set(e.orderId, {
            status: e.status,
            remaining: e.remainingQuantity,
          });
        }
        this.affectedUsers.add(e.userId);
      } else if (
        // Off-book settlements that move cash/positions without a book trade.
        e.type === "carry_charge" ||
        e.type === "loan_update" ||
        e.type === "otc_settled" ||
        e.type === "option_exercised" ||
        e.type === "option_assigned" ||
        e.type === "grant_awarded" ||
        e.type === "wealth_tax"
      ) {
        if ("userId" in e && e.userId) this.affectedUsers.add(e.userId);
      }
    }
  }

  /** Mark users so their cash + positions are re-synced on the next flush. */
  markUsers(userIds: string[]): void {
    for (const u of userIds) this.affectedUsers.add(u);
  }

  queueWrite(write: (tx: DbTransaction) => Promise<void>): void {
    this.pendingWrites.push(write);
  }

  setProgress(progress: { cursor?: string; minuteCount?: number }): void {
    this.progress = { ...this.progress, ...progress };
  }

  setCommitGuard(guard: () => void): void {
    this.commitGuard = guard;
  }

  flush(options?: {
    cursor?: string;
    minuteCount?: number;
    receipt?: string;
    write?: (tx: DbTransaction) => Promise<void>;
  }): Promise<void> {
    const { cursor, minuteCount, receipt, write } = {
      ...this.progress,
      ...options,
    };
    const flushing = this.flushChain.then(async () => {
      if (write) this.pendingWrites.push(write);
      const tradesToInsert = this.tradeBuf;
      const orderUpdates = [...this.pendingOrders.entries()];
      const users = [...this.affectedUsers];
      // Capture every account value before the first await, including positions.
      const accounts = users.filter(isUuid).map((userId) => ({
        userId,
        cash: this.engine.cashOf(userId),
        loanDebt: this.engine.loanDebtOf(userId),
        positions: this.engine.allPositions(userId),
      }));
      const state = this.engine.exportState();
      const writes = this.pendingWrites;
      this.tradeBuf = [];
      this.pendingOrders.clear();
      this.affectedUsers.clear();
      this.pendingWrites = [];

      try {
        await this.db.transaction(async (tx) => {
          this.commitGuard();
          if (tradesToInsert.length > 0) {
            await tx.insert(trades).values(
              tradesToInsert.map((t) => ({
                challengeId: this.challengeId,
                symbol: t.symbol,
                price: t.price,
                quantity: t.quantity,
                takerSide: t.takerSide,
                buyOrderId: isUuid(t.buyOrderId) ? t.buyOrderId : null,
                sellOrderId: isUuid(t.sellOrderId) ? t.sellOrderId : null,
                buyerId: isUuid(t.buyerId) ? t.buyerId : null,
                sellerId: isUuid(t.sellerId) ? t.sellerId : null,
                executedAt: new Date(t.ts),
              })),
            );
          }

          for (const [orderId, upd] of orderUpdates) {
            if (!isUuid(orderId)) continue;
            await tx
              .update(orders)
              .set({ status: upd.status, remainingQuantity: upd.remaining })
              .where(eq(orders.id, orderId));
          }

          for (const {
            userId,
            cash,
            loanDebt,
            positions: accountPositions,
          } of accounts) {
            await tx
              .insert(participants)
              .values({
                challengeId: this.challengeId,
                userId,
                startingCash: state.config.startingCash,
                cash,
                loanDebt,
              })
              .onConflictDoUpdate({
                target: [participants.challengeId, participants.userId],
                set: { cash, loanDebt },
              });

            for (const pos of accountPositions) {
              await tx
                .insert(positions)
                .values({
                  challengeId: this.challengeId,
                  userId,
                  symbol: pos.symbol,
                  quantity: pos.quantity,
                  avgPrice: pos.avgPrice,
                  updatedAt: new Date(),
                })
                .onConflictDoUpdate({
                  target: [
                    positions.challengeId,
                    positions.userId,
                    positions.symbol,
                  ],
                  set: {
                    quantity: pos.quantity,
                    avgPrice: pos.avgPrice,
                    updatedAt: new Date(),
                  },
                });
            }
          }

          for (const pendingWrite of writes) await pendingWrite(tx);

          const checkpoint = {
            state,
            updatedAt: new Date(),
            ...(cursor !== undefined ? { cursor } : {}),
            ...(minuteCount !== undefined ? { minuteCount } : {}),
          };
          await tx
            .insert(engineCheckpoints)
            .values({ challengeId: this.challengeId, ...checkpoint })
            .onConflictDoUpdate({
              target: engineCheckpoints.challengeId,
              set: checkpoint,
            });

          if (receipt !== undefined) {
            await tx
              .insert(eventActions)
              .values({
                challengeId: this.challengeId,
                actionId: receipt,
                completedAt: new Date(),
              })
              .onConflictDoNothing();
          }
          this.commitGuard();
        });
      } catch (err) {
        this.tradeBuf = [...tradesToInsert, ...this.tradeBuf];
        // Events collected during I/O supersede this failed batch's updates.
        const newerOrders = [...this.pendingOrders];
        this.pendingOrders.clear();
        for (const [id, update] of [...orderUpdates, ...newerOrders]) {
          this.pendingOrders.set(id, update);
        }
        const newerUsers = [...this.affectedUsers];
        this.affectedUsers.clear();
        for (const userId of [...users, ...newerUsers]) {
          this.affectedUsers.add(userId);
        }
        this.pendingWrites = [...writes, ...this.pendingWrites];
        throw err;
      }
    });
    // A failed caller still receives its rejection without poisoning the queue.
    this.flushChain = flushing.catch(() => {});
    return flushing;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string | null | undefined): s is string {
  return !!s && UUID_RE.test(s);
}
