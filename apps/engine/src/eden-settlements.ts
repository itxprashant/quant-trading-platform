import { createHash } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, like, lte, or } from "drizzle-orm";
import {
  grantWinner,
  resolveAuction as rankAuction,
  tallyVote,
  wealthTaxTransfers,
  type ChallengeEngine,
} from "@qtp/core";
import { publishBroadcast, type Redis } from "@qtp/bus";
import {
  auctionBids,
  auctions,
  challenges,
  eventActions,
  grantMissions,
  loans,
  otcOffers,
  participants,
  users,
  voteBallots,
  voteProposals,
  type Challenge,
  type Database,
} from "@qtp/db";
import {
  EDEN_EVENT_DEFAULTS,
  redisKeys,
  type BroadcastEnvelope,
  type EngineEvent,
} from "@qtp/shared";
import type { DbTransaction, Persistence } from "./persistence.js";

export interface EdenSettlementsDependencies {
  engine: ChallengeEngine;
  db: Database;
  redis: Redis;
  challenge: Challenge;
  minuteMs: number;
  persistence: Persistence;
  emit: (events: EngineEvent[]) => Promise<void>;
  refreshPortfolios: (ids: string[], ts: number) => Promise<void>;
}

/** All calls must run on the runner's serialized engine-mutation queue. */
export class EdenSettlements {
  private pendingFlush = false;
  private lastPremiumRecovery = -Infinity;
  private readonly legacyWarnings = new Set<string>();
  private readonly pendingOtcWarnings = new Set<string>();

  constructor(private readonly d: EdenSettlementsDependencies) {
    if (!Number.isFinite(d.minuteMs) || d.minuteMs <= 0) {
      throw new RangeError("minuteMs must be positive and finite");
    }
  }

  async issueLoan(loanId: string, now: number): Promise<void> {
    await this.drain();
    const { db, engine, challenge, minuteMs } = this.d;
    const [loan] = await db
      .select()
      .from(loans)
      .where(and(eq(loans.id, loanId), eq(loans.challengeId, challenge.id)));
    if (!loan || loan.fundedAt || loan.status !== "active") return;

    // Pre-migration loans have neither a schedule nor a funding marker. Guessing
    // from checkpoint time can re-fund an already paid loan. Migration must mark them.
    if (loan.installment === 0 && loan.nextPaymentAt === null) {
      if (!this.legacyWarnings.has(loanId)) {
        console.warn(
          `[${challenge.slug}] loan ${loanId} requires legacy funding migration`,
        );
        this.legacyWarnings.add(loanId);
      }
      return;
    }
    const [live] = await db
      .select()
      .from(challenges)
      .where(eq(challenges.id, challenge.id));
    const [participant] = await db
      .select()
      .from(participants)
      .where(
        and(
          eq(participants.challengeId, challenge.id),
          eq(participants.userId, loan.userId),
        ),
      );
    const end = live?.endsAt?.getTime();
    const totalRepay = loan.principal * 2;
    if (
      !live ||
      live.type !== "new_eden" ||
      live.status !== "live" ||
      end == null ||
      end <= now ||
      !participant ||
      !Number.isFinite(loan.principal) ||
      loan.principal <= 0 ||
      !Number.isFinite(totalRepay)
    ) {
      await this.commit([], async (tx) => {
        const changed = await tx
          .update(loans)
          .set({ status: "repaid", remaining: 0, nextPaymentAt: null })
          .where(
            and(
              eq(loans.id, loanId),
              eq(loans.challengeId, challenge.id),
              isNull(loans.fundedAt),
            ),
          )
          .returning({ id: loans.id });
        if (changed.length !== 1)
          throw new Error(`Loan funding claim changed: ${loanId}`);
      });
      await this.d.emit([
        {
          type: "alert",
          challengeId: challenge.id,
          userId: loan.userId,
          level: "warning",
          message:
            "Loan request could not be funded: invalid amount, enrollment, or deadline.",
          ts: now,
        },
      ]);
      return;
    }
    const installment = totalRepay / Math.ceil((end - now) / minuteMs);
    const nextPaymentAt = new Date(now + minuteMs);
    engine.issueLoan(loan.userId, loan.principal, totalRepay);
    await this.commit(
      [loan.userId],
      async (tx) => {
        const changed = await tx
          .update(loans)
          .set({
            totalRepay,
            remaining: totalRepay,
            installment,
            nextPaymentAt,
            fundedAt: new Date(now),
          })
          .where(
            and(
              eq(loans.id, loanId),
              eq(loans.challengeId, challenge.id),
              eq(loans.status, "active"),
              isNull(loans.fundedAt),
            ),
          )
          .returning({ id: loans.id });
        if (changed.length !== 1)
          throw new Error(`Loan already funded: ${loanId}`);
      },
      `loan:${loanId}`,
    );
    await this.d.emit([
      {
        type: "loan_update",
        challengeId: challenge.id,
        userId: loan.userId,
        loanId,
        principal: loan.principal,
        remaining: totalRepay,
        status: "active",
        ts: now,
      },
      {
        type: "alert",
        challengeId: challenge.id,
        userId: loan.userId,
        level: "warning",
        message: `Loan funded: +$${loan.principal.toFixed(2)}; $${totalRepay.toFixed(2)} due in fixed installments.`,
        ts: now,
      },
    ]);
    await this.d.refreshPortfolios([loan.userId], now);
  }

  async repayLoans(now: number, final = false): Promise<void> {
    await this.drain();
    const { db, engine, challenge, minuteMs } = this.d;
    const end = challenge.endsAt?.getTime();
    const close = final || (end != null && now >= end);
    const rows = await db
      .select()
      .from(loans)
      .where(
        and(
          eq(loans.challengeId, challenge.id),
          eq(loans.status, "active"),
          isNotNull(loans.fundedAt),
          close ? undefined : lte(loans.nextPaymentAt, new Date(now)),
        ),
      )
      .orderBy(asc(loans.createdAt), asc(loans.id));
    const plans = rows
      .map((loan) => {
        if (
          !Number.isFinite(loan.remaining) ||
          loan.remaining < 0 ||
          !Number.isFinite(loan.installment) ||
          (!close && loan.installment <= 0)
        ) {
          throw new Error(`Invalid repayment schedule: ${loan.id}`);
        }
        const next = loan.nextPaymentAt?.getTime();
        const through = Math.min(now, end ?? now);
        const count =
          next == null || next > through
            ? 0
            : Math.floor((through - next) / minuteMs) + 1;
        const due = close
          ? loan.remaining
          : Math.min(loan.remaining, loan.installment * count);
        return {
          loan,
          due,
          next: next == null ? null : new Date(next + count * minuteMs),
        };
      })
      .filter((p) => p.due > 0 || p.loan.remaining === 0);
    if (plans.length === 0) return;

    const totals = new Map<string, number>();
    for (const { loan, due } of plans)
      totals.set(loan.userId, (totals.get(loan.userId) ?? 0) + due);
    for (const [userId, due] of totals) {
      if (due > engine.loanDebtOf(userId) + Math.max(1e-8, due * 1e-12)) {
        throw new Error(
          `Loan ledger exceeds checkpoint debt for ${userId}; reconcile before repayment`,
        );
      }
    }
    const events: EngineEvent[] = [];
    const updates = plans.map(({ loan, due, next }) => {
      const paid = engine.repayLoan(loan.userId, due);
      const residual = Math.max(0, loan.remaining - paid);
      const remaining =
        residual <= Math.max(1e-8, loan.totalRepay * 1e-12) ? 0 : residual;
      const status =
        remaining === 0 ? ("repaid" as const) : ("active" as const);
      events.push({
        type: "loan_update",
        challengeId: challenge.id,
        userId: loan.userId,
        loanId: loan.id,
        principal: loan.principal,
        remaining,
        status,
        ts: now,
      });
      return {
        loan,
        remaining,
        status,
        nextPaymentAt: remaining === 0 ? null : next,
      };
    });
    await this.commit([...totals.keys()], async (tx) => {
      for (const update of updates) {
        const changed = await tx
          .update(loans)
          .set({
            remaining: update.remaining,
            status: update.status,
            nextPaymentAt: update.nextPaymentAt,
          })
          .where(
            and(
              eq(loans.id, update.loan.id),
              eq(loans.challengeId, challenge.id),
              eq(loans.status, "active"),
              eq(loans.remaining, update.loan.remaining),
              update.loan.nextPaymentAt
                ? eq(loans.nextPaymentAt, update.loan.nextPaymentAt)
                : isNull(loans.nextPaymentAt),
            ),
          )
          .returning({ id: loans.id });
        if (changed.length !== 1)
          throw new Error(`Loan repayment claim changed: ${update.loan.id}`);
      }
    });
    await this.d.emit(events);
    await this.d.refreshPortfolios([...totals.keys()], now);
  }

  async resolveAuction(
    id: string,
    ts: number,
    premiumUntil?: number,
  ): Promise<void> {
    await this.drain();
    const { db, engine, challenge } = this.d;
    const plan = await db.transaction(async (tx) => {
      const [auction] = await tx
        .select()
        .from(auctions)
        .where(and(eq(auctions.id, id), eq(auctions.challengeId, challenge.id)))
        .for("update");
      if (!auction || auction.expiresAt.getTime() > ts) return null;
      const bids = await tx
        .select()
        .from(auctionBids)
        .where(eq(auctionBids.auctionId, id))
        .for("update");
      if (auction.status === "resolved")
        return { auction, bids, resolution: null };
      const traders = await tx
        .select({ userId: participants.userId })
        .from(participants)
        .innerJoin(users, eq(users.id, participants.userId))
        .where(
          and(
            eq(participants.challengeId, challenge.id),
            eq(users.role, "trader"),
            lte(participants.joinedAt, auction.expiresAt),
          ),
        );
      const eligible = new Set(traders.map((r) => r.userId));
      const affordable = bids.filter(
        (bid) =>
          eligible.has(bid.userId) &&
          Number.isFinite(bid.amount) &&
          bid.amount > 0 &&
          engine.cashOf(bid.userId) >= bid.amount,
      );
      return {
        auction,
        bids,
        resolution: rankAuction(
          affordable,
          challenge.config.eden?.auctionWinnerFraction ?? 0.3,
        ),
      };
    });
    if (!plan) return;
    if (plan.auction.status === "resolved") {
      await this.restorePremium(id);
      return;
    }
    if (!plan.resolution) return;
    const { winners, cutoff } = plan.resolution;
    const winning = new Set(winners);
    const until =
      premiumUntil ??
      plan.auction.expiresAt.getTime() +
        (challenge.config.eden?.premiumAccessMinutes ?? 15) * this.d.minuteMs;
    if (!Number.isFinite(until)) throw new Error("Invalid premium deadline");
    for (const bid of plan.bids)
      if (winning.has(bid.userId)) engine.adjustCash(bid.userId, -bid.amount);
    await this.commit(
      winners,
      async (tx) => {
        const [locked] = await tx
          .select()
          .from(auctions)
          .where(
            and(eq(auctions.id, id), eq(auctions.challengeId, challenge.id)),
          )
          .for("update");
        if (!locked || locked.status !== "open")
          throw new Error(`Auction claim changed: ${id}`);
        await tx
          .update(auctions)
          .set({ status: "resolved", cutoff })
          .where(eq(auctions.id, id));
        for (const bid of plan.bids)
          await tx
            .update(auctionBids)
            .set({ won: winning.has(bid.userId) })
            .where(eq(auctionBids.id, bid.id));
      },
      `auction:${id}:premium:${Math.trunc(until)}`,
    );
    await this.restorePremium(id);
    const envelopes: BroadcastEnvelope[] = [
      {
        target: "all",
        msg: {
          type: "auction",
          challengeId: challenge.id,
          data: {
            id,
            challengeId: challenge.id,
            status: "resolved",
            cutoff,
            expiresAt: plan.auction.expiresAt.toISOString(),
            createdAt: plan.auction.createdAt.toISOString(),
          },
        },
      },
    ];
    for (const bid of plan.bids)
      envelopes.push({
        target: bid.userId,
        msg: {
          type: "auction_result",
          challengeId: challenge.id,
          data: { auctionId: id, cutoff, won: winning.has(bid.userId), ts },
        },
      });
    await publishBroadcast(this.d.redis, challenge.id, envelopes);
    await this.d.refreshPortfolios(winners, ts);
  }

  /**
   * HTTP `accepted` means awaiting reservation, not yet binding confirmation.
   * Linearize acceptance before the runner's next mutation; the post-checkpoint
   * otc_result/accepted event confirms that exposure is reserved.
   */
  async reserveOtc(now: number): Promise<void> {
    await this.drain();
    const { db, engine, challenge } = this.d;
    const offers = await db
      .select()
      .from(otcOffers)
      .where(
        and(
          eq(otcOffers.challengeId, challenge.id),
          eq(otcOffers.status, "accepted"),
        ),
      )
      .orderBy(asc(otcOffers.createdAt), asc(otcOffers.id));
    if (offers.length === 0) return;
    const receipts = new Set(
      (
        await db
          .select()
          .from(eventActions)
          .where(
            and(
              eq(eventActions.challengeId, challenge.id),
              like(eventActions.actionId, "otc-reserved:%"),
            ),
          )
      ).map((row) => row.actionId),
    );
    for (const offer of offers) {
      const receipt = `otc-reserved:${offer.id}`;
      // The receipt and reservation were checkpointed together. Never recreate
      // a receipted reservation missing from a restored/legacy checkpoint.
      if (receipts.has(receipt)) continue;
      const events = engine.cancelUserOrders(offer.userId, now);
      this.d.persistence.collect(events);
      const netCash =
        offer.cashToTrader -
        offer.legs.reduce((sum, leg) => sum + leg.price * leg.quantity, 0);
      const reserved =
        Number.isFinite(offer.cashToTrader) &&
        Number.isFinite(netCash) &&
        offer.legs.length > 0 &&
        engine.reserveSettlement(offer.id, offer.userId, offer.legs);
      const status = reserved ? ("accepted" as const) : ("rejected" as const);
      await this.commit(
        [offer.userId],
        async (tx) => {
          const changed = await tx
            .update(otcOffers)
            .set({ status })
            .where(
              and(
                eq(otcOffers.id, offer.id),
                eq(otcOffers.challengeId, challenge.id),
                eq(otcOffers.status, "accepted"),
              ),
            )
            .returning({ id: otcOffers.id });
          if (changed.length !== 1)
            throw new Error(`OTC reservation claim changed: ${offer.id}`);
        },
        reserved ? receipt : `otc:${offer.id}`,
      );
      events.push({
        type: "alert",
        challengeId: challenge.id,
        userId: offer.userId,
        level: reserved ? "info" : "warning",
        ts: now,
        message: reserved
          ? "Deal acceptance confirmed: exposure reserved. The trade is now binding and will settle at its agreed deadline."
          : "Provisional deal acceptance rejected: insufficient position capacity, unavailable instrument, or invalid terms. No trade was executed.",
      });
      await this.d.emit(events);
      await publishBroadcast(this.d.redis, challenge.id, [
        {
          target: offer.userId,
          msg: {
            type: "otc_result",
            challengeId: challenge.id,
            data: { offerId: offer.id, status, ts: now },
          },
        },
      ]);
    }
  }

  async settleOtc(offerId: string, now: number): Promise<void> {
    await this.reserveOtc(now);
    const { db, engine, challenge } = this.d;
    const [offer] = await db
      .select()
      .from(otcOffers)
      .where(
        and(eq(otcOffers.id, offerId), eq(otcOffers.challengeId, challenge.id)),
      );
    if (
      !offer ||
      offer.status !== "accepted" ||
      (offer.settleAt && offer.settleAt.getTime() > now)
    )
      return;
    const host = "bot:deal-desk";
    const hasHost = engine.accountIds().includes(host);
    let traderCash = engine.cashOf(offer.userId);
    let hostCash = hasHost ? engine.cashOf(host) : 0;
    const projected = new Map<string, number>();
    const hostProjected = new Map<string, number>();
    let valid = Number.isFinite(offer.cashToTrader) && offer.legs.length > 0;
    // Preflight the full ordered batch before changing either account. Repeated
    // symbols and intermediate arithmetic must be safe, not just the net cash.
    for (const leg of offer.legs) {
      const quantity =
        (projected.get(leg.symbol) ??
          engine.positionOf(offer.userId, leg.symbol)) + leg.quantity;
      const hostQuantity =
        (hostProjected.get(leg.symbol) ??
          (hasHost ? engine.positionOf(host, leg.symbol) : 0)) - leg.quantity;
      traderCash -= leg.price * leg.quantity;
      hostCash += leg.price * leg.quantity;
      valid =
        valid &&
        Number.isSafeInteger(leg.quantity) &&
        Number.isFinite(leg.price) &&
        leg.price >= 0 &&
        Number.isSafeInteger(quantity) &&
        Number.isSafeInteger(hostQuantity) &&
        Number.isFinite(traderCash) &&
        Number.isFinite(hostCash);
      projected.set(leg.symbol, quantity);
      hostProjected.set(leg.symbol, hostQuantity);
    }
    valid =
      valid &&
      Number.isFinite(traderCash + offer.cashToTrader) &&
      Number.isFinite(hostCash - offer.cashToTrader);
    if (valid && offer.legs.some((leg) => !engine.hasSymbol(leg.symbol))) {
      // Removed/expired contracts cannot be recreated by this adapter. Preserve
      // the obligation for host review instead of silently voiding the bargain.
      if (!this.pendingOtcWarnings.has(offerId)) {
        await this.commit([], async () => {});
        await this.d.emit([
          {
            type: "alert",
            challengeId: challenge.id,
            userId: offer.userId,
            level: "urgent",
            ts: now,
            message:
              "Accepted Deal Desk trade awaits host review: an instrument was removed before settlement. The binding offer remains accepted; no cash or inventory has moved.",
          },
        ]);
        this.pendingOtcWarnings.add(offerId);
      }
      return;
    }
    const events: EngineEvent[] = [];
    const cap = challenge.config.eden?.rules?.positionCap ?? 100;
    const wouldBreach = [...projected.values()].some(
      (quantity) => Math.abs(quantity) > cap,
    );
    // Acceptance fixes prices and cash. Neither a news move, a closed book nor
    // a later position change gives the trader a cancellation option.
    engine.releaseSettlement(offerId);
    const settled = valid;
    if (settled) {
      if (wouldBreach || !engine.canSettleOffBook(offer.userId, offer.legs)) {
        const cancellations = engine.cancelUserOrders(offer.userId, now);
        this.d.persistence.collect(cancellations);
        events.push(...cancellations);
      }
      if (!hasHost)
        engine.restoreAccount(host, { cash: 0, loanDebt: 0, positions: [] });
      // Ordinary settlements use the checked path after releasing their own
      // capacity. Assignment/closed-book changes cannot void a confirmed deal.
      if (!engine.settleOffBook(offer.userId, offer.legs)) {
        for (const leg of offer.legs)
          engine.settleFill(offer.userId, leg.symbol, leg.quantity, leg.price);
      }
      for (const leg of offer.legs) {
        engine.settleFill(host, leg.symbol, -leg.quantity, leg.price);
      }
      engine.adjustCash(offer.userId, offer.cashToTrader);
      engine.adjustCash(host, -offer.cashToTrader);
      const breaches = [...new Set(offer.legs.map((leg) => leg.symbol))].filter(
        (symbol) => Math.abs(engine.positionOf(offer.userId, symbol)) > cap,
      );
      if (breaches.length > 0)
        events.push({
          type: "alert",
          challengeId: challenge.id,
          userId: offer.userId,
          level: "urgent",
          ts: now,
          message: `Binding OTC settled, but ${breaches.join(", ")} exceeds the ${cap}-unit position cap. Working orders were cancelled. Reduce exposure or request host intervention; no automatic penalty or assignment grace was applied.`,
        });
      this.pendingOtcWarnings.delete(offerId);
    }
    const status = settled ? ("settled" as const) : ("rejected" as const);
    await this.commit(
      settled ? [offer.userId] : [],
      async (tx) => {
        const changed = await tx
          .update(otcOffers)
          .set({ status })
          .where(
            and(
              eq(otcOffers.id, offerId),
              eq(otcOffers.challengeId, challenge.id),
              eq(otcOffers.status, "accepted"),
            ),
          )
          .returning({ id: otcOffers.id });
        if (changed.length !== 1)
          throw new Error(`OTC claim changed: ${offerId}`);
      },
      `otc:${offerId}`,
    );
    events.push({
      type: "alert",
      challengeId: challenge.id,
      userId: offer.userId,
      level: settled ? "info" : "urgent",
      ts: now,
      message: settled
        ? "Binding Deal Desk trade settled."
        : "Deal Desk settlement rejected: invalid numerical terms. No cash or inventory was transferred.",
    });
    if (settled)
      events.push({
        type: "otc_settled",
        challengeId: challenge.id,
        offerId,
        userId: offer.userId,
        ts: now,
      });
    await this.d.emit(events);
    await publishBroadcast(this.d.redis, challenge.id, [
      {
        target: offer.userId,
        msg: {
          type: "otc_result",
          challengeId: challenge.id,
          data: { offerId, status, ts: now },
        },
      },
    ]);
    if (settled) await this.d.refreshPortfolios([offer.userId], now);
  }

  async resolveVote(proposalId: string, now: number): Promise<void> {
    await this.drain();
    const { db, challenge } = this.d;
    const plan = await db.transaction(async (tx) => {
      const [proposal] = await tx
        .select()
        .from(voteProposals)
        .where(
          and(
            eq(voteProposals.id, proposalId),
            eq(voteProposals.challengeId, challenge.id),
          ),
        )
        .for("update");
      if (
        !proposal ||
        (proposal.status === "open" && proposal.expiresAt.getTime() > now)
      )
        return null;
      const ballots = await tx
        .select({ choice: voteBallots.choice })
        .from(voteBallots)
        .innerJoin(
          participants,
          and(
            eq(participants.userId, voteBallots.userId),
            eq(participants.challengeId, challenge.id),
          ),
        )
        .innerJoin(users, eq(users.id, voteBallots.userId))
        .where(
          and(eq(voteBallots.proposalId, proposalId), eq(users.role, "trader")),
        );
      return {
        proposal,
        tally: tallyVote(
          ballots.flatMap((b) =>
            b.choice === "yes" || b.choice === "no" ? [b.choice] : [],
          ),
        ),
      };
    });
    if (!plan) return;
    let status = plan.proposal.status;
    if (status === "open") {
      status = plan.tally.passed ? "passed" : "failed";
      const outcome = status;
      await this.commit([], async (tx) => {
        const changed = await tx
          .update(voteProposals)
          .set({ status: outcome })
          .where(
            and(
              eq(voteProposals.id, proposalId),
              eq(voteProposals.challengeId, challenge.id),
              eq(voteProposals.status, "open"),
            ),
          )
          .returning({ id: voteProposals.id });
        // The API may have closed this vote while our read lock was released.
        if (changed.length === 0) {
          const [fresh] = await tx
            .select()
            .from(voteProposals)
            .where(eq(voteProposals.id, proposalId));
          if (!fresh || fresh.status === "open")
            throw new Error(`Vote claim changed: ${proposalId}`);
          status = fresh.status;
        }
      });
    }
    if (status === "passed") await this.applyTax(proposalId, now);
    await publishBroadcast(this.d.redis, challenge.id, [
      {
        target: "all",
        msg: {
          type: "vote",
          challengeId: challenge.id,
          data: {
            id: proposalId,
            challengeId: challenge.id,
            title: plan.proposal.title,
            description: plan.proposal.description,
            kind: "wealth_tax",
            status,
            expiresAt: plan.proposal.expiresAt.toISOString(),
            createdAt: plan.proposal.createdAt.toISOString(),
            yes: plan.tally.yes,
            no: plan.tally.no,
          },
        },
      },
    ]);
  }

  async applyTax(
    proposalId: string,
    now: number,
    brackets: {
      ratePct?: number;
      topPct?: number;
      bottomPct?: number;
    } = {},
  ): Promise<void> {
    await this.drain();
    const { db, engine, challenge } = this.d;
    const receipt = `tax:${proposalId}`;
    if (await this.received(receipt)) return;
    const [proposal] = await db
      .select()
      .from(voteProposals)
      .where(
        and(
          eq(voteProposals.id, proposalId),
          eq(voteProposals.challengeId, challenge.id),
        ),
      );
    if (
      !proposal ||
      proposal.status !== "passed" ||
      proposal.kind !== "wealth_tax"
    )
      return;
    const traders = await this.humanTraders(
      Math.min(now, proposal.expiresAt.getTime()),
    );
    const ratePct = brackets.ratePct ?? EDEN_EVENT_DEFAULTS.taxRate;
    const topPct = brackets.topPct ?? EDEN_EVENT_DEFAULTS.taxTopFraction;
    const bottomPct = brackets.bottomPct ?? EDEN_EVENT_DEFAULTS.taxBottomFraction;
    const { deltas, redistributed } = wealthTaxTransfers(
      traders.map((r) => ({ id: r.userId, cash: engine.cashOf(r.userId) })),
      ratePct,
      topPct,
      bottomPct,
    );
    for (const delta of deltas) engine.adjustCash(delta.id, delta.delta);
    await this.commit(
      deltas.map((delta) => delta.id),
      async () => {},
      receipt,
    );
    const events: EngineEvent[] = deltas.map((delta) => ({
      type: "alert",
      challengeId: challenge.id,
      userId: delta.id,
      level: delta.delta < 0 ? "warning" : "info",
      message:
        delta.delta < 0
          ? `Solidarity tax: -$${(-delta.delta).toFixed(2)}.`
          : `Solidarity relief: +$${delta.delta.toFixed(2)}.`,
      ts: now,
    }));
    events.push({
      type: "wealth_tax",
      challengeId: challenge.id,
      redistributed,
      ts: now,
    });
    await this.d.emit(events);
    await this.d.refreshPortfolios(
      deltas.map((delta) => delta.id),
      now,
    );
  }

  async awardGrant(grantId: string, now: number): Promise<void> {
    await this.drain();
    const { db, engine, challenge } = this.d;
    const [grant] = await db
      .select()
      .from(grantMissions)
      .where(
        and(
          eq(grantMissions.id, grantId),
          eq(grantMissions.challengeId, challenge.id),
        ),
      );
    if (!grant || grant.status !== "open" || grant.expiresAt.getTime() > now)
      return;
    if (!Number.isFinite(grant.prize) || grant.prize <= 0)
      throw new Error(`Invalid grant prize: ${grantId}`);
    const traders = await this.humanTraders(grant.expiresAt.getTime());
    const winnerId = grantWinner(
      traders.map((r) => ({
        id: r.userId,
        qty: engine.positionOf(r.userId, grant.symbol),
      })),
    );
    if (winnerId) engine.adjustCash(winnerId, grant.prize);
    await this.commit(
      winnerId ? [winnerId] : [],
      async (tx) => {
        const changed = await tx
          .update(grantMissions)
          .set({ status: "awarded", winnerId })
          .where(
            and(
              eq(grantMissions.id, grantId),
              eq(grantMissions.challengeId, challenge.id),
              eq(grantMissions.status, "open"),
            ),
          )
          .returning({ id: grantMissions.id });
        if (changed.length !== 1)
          throw new Error(`Grant claim changed: ${grantId}`);
      },
      `grant:${grantId}`,
    );
    await this.d.emit([
      {
        type: "grant_awarded",
        challengeId: challenge.id,
        grantId,
        userId: winnerId,
        symbol: grant.symbol,
        prize: winnerId ? grant.prize : 0,
        ts: now,
      },
    ]);
    await publishBroadcast(this.d.redis, challenge.id, [
      {
        target: "all",
        msg: {
          type: "grant",
          challengeId: challenge.id,
          data: {
            id: grantId,
            challengeId: challenge.id,
            symbol: grant.symbol,
            description: grant.description,
            prize: grant.prize,
            status: "awarded",
            winnerId,
            expiresAt: grant.expiresAt.toISOString(),
            createdAt: grant.createdAt.toISOString(),
          },
        },
      },
    ]);
    if (winnerId) await this.d.refreshPortfolios([winnerId], now);
  }

  async rescueLoans(now: number): Promise<void> {
    await this.drain();
    const { db, engine, challenge, minuteMs } = this.d;
    const end = challenge.endsAt?.getTime();
    if (end == null || end <= now) return;
    for (const { userId, displayName } of await this.humanTraders(now)) {
      const cash = engine.cashOf(userId);
      if (!Number.isFinite(cash) || cash >= 0) continue;
      const hash = createHash("sha256")
        .update(`${challenge.id}:rescue:${now}:${userId}`)
        .digest("hex");
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      const principal = Math.ceil(-cash) + 1;
      const totalRepay = principal * 2;
      if (!Number.isFinite(totalRepay))
        throw new Error(`Invalid rescue amount for ${userId}`);
      const [existing] = await db.select().from(loans).where(eq(loans.id, id));
      if (!existing)
        await this.commit([], async (tx) => {
          await tx
            .insert(loans)
            .values({
              id,
              challengeId: challenge.id,
              userId,
              principal,
              totalRepay,
              remaining: totalRepay,
              installment: totalRepay / Math.ceil((end - now) / minuteMs),
              nextPaymentAt: new Date(now + minuteMs),
              fundedAt: null,
              status: "active",
              createdAt: new Date(now),
            })
            .onConflictDoNothing();
        });
      await this.issueLoan(id, now);
      if (!existing?.fundedAt) {
        const [funded] = await db.select().from(loans).where(eq(loans.id, id));
        if (funded?.fundedAt) {
          await publishBroadcast(this.d.redis, challenge.id, [
            {
              target: "all",
              msg: {
                type: "alert",
                challengeId: challenge.id,
                data: {
                  level: "warning",
                  ts: now,
                  message: `Halftime bank rescue: ${displayName || userId} borrowed $${funded.principal.toFixed(2)} and owes $${funded.totalRepay.toFixed(2)}.`,
                },
              },
            },
          ]);
        }
      }
    }
  }

  async recover(now: number): Promise<void> {
    await this.reserveOtc(now);
    const { db, challenge } = this.d;
    const unfunded = await db
      .select({ id: loans.id })
      .from(loans)
      .where(
        and(
          eq(loans.challengeId, challenge.id),
          eq(loans.status, "active"),
          isNull(loans.fundedAt),
        ),
      )
      .orderBy(asc(loans.createdAt), asc(loans.id));
    for (const loan of unfunded) await this.issueLoan(loan.id, now);
    await this.repayLoans(now);
    const due: Array<{
      id: string;
      at: number;
      kind: "auction" | "vote" | "grant" | "otc";
    }> = [];
    const auctionRows = await db
      .select()
      .from(auctions)
      .where(
        and(
          eq(auctions.challengeId, challenge.id),
          eq(auctions.status, "open"),
          lte(auctions.expiresAt, new Date(now)),
        ),
      );
    for (const row of auctionRows)
      due.push({ id: row.id, at: row.expiresAt.getTime(), kind: "auction" });
    const voteRows = await db
      .select()
      .from(voteProposals)
      .where(
        and(
          eq(voteProposals.challengeId, challenge.id),
          or(
            eq(voteProposals.status, "passed"),
            and(
              eq(voteProposals.status, "open"),
              lte(voteProposals.expiresAt, new Date(now)),
            ),
          ),
        ),
      );
    const taxReceipts = new Set(
      (
        await db
          .select()
          .from(eventActions)
          .where(
            and(
              eq(eventActions.challengeId, challenge.id),
              like(eventActions.actionId, "tax:%"),
            ),
          )
      ).map((r) => r.actionId),
    );
    for (const row of voteRows)
      if (row.status === "open" || !taxReceipts.has(`tax:${row.id}`))
        due.push({ id: row.id, at: row.expiresAt.getTime(), kind: "vote" });
    const grantRows = await db
      .select()
      .from(grantMissions)
      .where(
        and(
          eq(grantMissions.challengeId, challenge.id),
          eq(grantMissions.status, "open"),
          lte(grantMissions.expiresAt, new Date(now)),
        ),
      );
    for (const row of grantRows)
      due.push({ id: row.id, at: row.expiresAt.getTime(), kind: "grant" });
    const offers = await db
      .select()
      .from(otcOffers)
      .where(
        and(
          eq(otcOffers.challengeId, challenge.id),
          eq(otcOffers.status, "accepted"),
        ),
      );
    for (const row of offers)
      if (!row.settleAt || row.settleAt.getTime() <= now)
        due.push({
          id: row.id,
          at: row.settleAt?.getTime() ?? row.expiresAt.getTime(),
          kind: "otc",
        });
    due.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    for (const row of due) {
      if (row.kind === "auction") await this.resolveAuction(row.id, now);
      else if (row.kind === "vote") await this.resolveVote(row.id, now);
      else if (row.kind === "grant") await this.awardGrant(row.id, now);
      else await this.settleOtc(row.id, now);
    }
    await this.recoverPremium(now);
  }

  async recoverPremium(now: number): Promise<void> {
    if (now - this.lastPremiumRecovery >= 30_000) {
      const { db, challenge } = this.d;
      const receipts = await db
        .select()
        .from(eventActions)
        .where(
          and(
            eq(eventActions.challengeId, challenge.id),
            like(eventActions.actionId, "auction:%:premium:%"),
          ),
        );
      for (const receipt of receipts) {
        const [, id, , deadline] = receipt.actionId.split(":");
        if (id && Number(deadline) > now) await this.restorePremium(id);
      }
      this.lastPremiumRecovery = now;
    }
  }

  private humanTraders(at: number) {
    return this.d.db
      .select({ userId: participants.userId, displayName: users.displayName })
      .from(participants)
      .innerJoin(users, eq(users.id, participants.userId))
      .where(
        and(
          eq(participants.challengeId, this.d.challenge.id),
          eq(users.role, "trader"),
          lte(participants.joinedAt, new Date(at)),
        ),
      )
      .orderBy(asc(participants.userId));
  }

  private async received(actionId: string): Promise<boolean> {
    const [receipt] = await this.d.db
      .select()
      .from(eventActions)
      .where(
        and(
          eq(eventActions.challengeId, this.d.challenge.id),
          eq(eventActions.actionId, actionId),
        ),
      );
    return receipt !== undefined;
  }

  private async commit(
    ids: string[],
    write: (tx: DbTransaction) => Promise<void>,
    receipt?: string,
  ): Promise<void> {
    this.d.persistence.markUsers(ids);
    this.d.persistence.queueWrite(async (tx) => {
      await write(tx);
      // Keep the receipt in the retryable write buffer, not only flush options:
      // Persistence retains pending writes after failure but not those options.
      if (receipt) {
        const claimed = await tx
          .insert(eventActions)
          .values({ challengeId: this.d.challenge.id, actionId: receipt })
          .onConflictDoNothing()
          .returning({ actionId: eventActions.actionId });
        if (claimed.length !== 1)
          throw new Error(`Settlement receipt already exists: ${receipt}`);
      }
    });
    this.pendingFlush = true;
    await this.drain();
  }

  private async drain(): Promise<void> {
    if (!this.pendingFlush) return;
    await this.d.persistence.flush();
    this.pendingFlush = false;
  }

  private async restorePremium(auctionId: string): Promise<void> {
    const { db, redis, challenge } = this.d;
    const [receipt] = await db
      .select()
      .from(eventActions)
      .where(
        and(
          eq(eventActions.challengeId, challenge.id),
          like(eventActions.actionId, `auction:${auctionId}:premium:%`),
        ),
      );
    if (!receipt) return;
    const until = Number(receipt.actionId.split(":")[3]);
    if (!Number.isFinite(until) || until <= Date.now()) return;
    const winners = await db
      .select()
      .from(auctionBids)
      .where(
        and(eq(auctionBids.auctionId, auctionId), eq(auctionBids.won, true)),
      );
    // Restore the original deadline, never a fresh TTL, and never shorten a
    // newer round's entitlement. Redis TIME avoids client/server clock drift.
    const script = `local t = redis.call('TIME')
      local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
      local remaining = tonumber(ARGV[1]) - now
      if remaining > 0 and redis.call('PTTL', KEYS[1]) < remaining then
        return redis.call('SET', KEYS[1], '1', 'PXAT', ARGV[1])
      end
      return 0`;
    for (const winner of winners)
      await redis.eval(
        script,
        1,
        redisKeys.premiumAccess(challenge.id, winner.userId),
        String(until),
      );
  }
}
