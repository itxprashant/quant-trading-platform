import { and, eq } from "drizzle-orm";
import type { ChallengeEngine } from "@qtp/core";
import {
  orders,
  participants,
  positions,
  trades,
  type Database,
} from "@qtp/db";
import type { EngineEvent, OrderStatus, TradeEvent } from "@qtp/shared";

interface PendingOrder {
  status: OrderStatus;
  remaining: number;
}

/**
 * Buffers engine events and flushes them to Postgres in batches so the hot
 * matching loop is never blocked on database I/O. The in-memory engine remains
 * the source of truth; the database is an eventually-consistent projection.
 */
export class Persistence {
  private tradeBuf: TradeEvent[] = [];
  private readonly pendingOrders = new Map<string, PendingOrder>();
  private readonly affectedUsers = new Set<string>();

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

  async flush(): Promise<void> {
    if (
      this.tradeBuf.length === 0 &&
      this.pendingOrders.size === 0 &&
      this.affectedUsers.size === 0
    ) {
      return;
    }

    const tradesToInsert = this.tradeBuf;
    const orderUpdates = [...this.pendingOrders.entries()];
    const users = [...this.affectedUsers];
    this.tradeBuf = [];
    this.pendingOrders.clear();
    this.affectedUsers.clear();

    try {
      await this.db.transaction(async (tx) => {
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

        for (const userId of users) {
          if (!isUuid(userId)) continue; // skip bot/synthetic ids
          const cash = this.engine.cashOf(userId);
          const loanDebt = this.engine.loanDebtOf(userId);
          await tx
            .insert(participants)
            .values({
              challengeId: this.challengeId,
              userId,
              startingCash: 0,
              cash,
              loanDebt,
            })
            .onConflictDoUpdate({
              target: [participants.challengeId, participants.userId],
              set: { cash, loanDebt },
            });

          for (const pos of this.engine.allPositions(userId)) {
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
      });
    } catch (err) {
      // Re-queue affected users so the next flush retries their sync.
      for (const u of users) this.affectedUsers.add(u);
      throw err;
    }
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string | null | undefined): s is string {
  return !!s && UUID_RE.test(s);
}

void and;
