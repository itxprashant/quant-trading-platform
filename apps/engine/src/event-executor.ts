import { and, asc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import type { ChallengeEngine } from "@qtp/core";
import {
  getNewsFeed,
  hasPremiumAccess,
  publishBroadcast,
  setFairValue,
  setNewsFeed,
  type Redis,
} from "@qtp/bus";
import {
  auctions,
  challengeNews,
  challenges,
  fairValues,
  grantMissions,
  optionContracts,
  otcOffers,
  participants,
  users,
  voteBallots,
  voteProposals,
  type Challenge,
  type Database,
} from "@qtp/db";
import {
  EDEN_EVENT_ACTIONS,
  EDEN_EVENT_AERIUM,
  EDEN_EVENT_DURATION_MINUTES,
  EDEN_EVENT_ETF,
  edenEventStateAt,
  type BondTemplate,
  type ChallengeConfig,
  type EdenEventAction,
  type EdenOptionsConfig,
  type EngineEvent,
  type EtfConfig,
  type FvEffect,
  type MomentumEffect,
  type NewsItem,
  type OtcLeg,
  type ServerMessage,
  type SymbolConfig,
} from "@qtp/shared";
import type { EventActionContext } from "./event-timeline.js";

export interface EventExecutorDependencies {
  challenge: Challenge;
  db: Database;
  redis: Redis;
  engine: ChallengeEngine;
  minuteMs: number;
  /** Persist internal events; fair_value must never be broadcast to all traders. */
  emit(events: EngineEvent[]): Promise<void>;
  addSpotSymbol(
    config: SymbolConfig,
    locked: boolean,
    ts: number,
  ): Promise<void>;
  addEtf(config: EtfConfig, ts: number): Promise<void>;
  addBond(template: BondTemplate): Promise<void>;
  openOptions(config: EdenOptionsConfig, now: number): Promise<void>;
  setFrozen(frozen: boolean): Promise<void>;
  resolveAuction(id: string, ts: number, premiumUntil?: number): Promise<void>;
  resolveVote(id: string, ts: number): Promise<void>;
  awardGrant(id: string, ts: number): Promise<void>;
  rescueLoans(ts: number): Promise<void>;
  setVolatility(multiplier: number): void;
  prepareVega(
    symbol: string,
    releaseAt: number,
    now: number,
  ): void | Promise<void>;
  resolveVega(symbol: string, now: number): Promise<void>;
  newsPulse(effects: MomentumEffect[], volEvent: boolean): void;
  setEtfWindow(symbol: string, open: boolean, ts: number): Promise<void>;
  finalize(ts: number): Promise<void>;
}

/** Engine-owned effects. The parent, NOT this class, checkpoints action receipts. */
export class EventExecutor {
  private readonly deps: EventExecutorDependencies;

  constructor(deps: EventExecutorDependencies) {
    if (!Number.isFinite(deps.minuteMs) || deps.minuteMs <= 0)
      throw new RangeError("minuteMs must be positive and finite");
    this.deps = deps;
  }

  async execute(
    action: EdenEventAction,
    context: EventActionContext,
  ): Promise<void> {
    const d = this.deps;
    const challengeId = d.challenge.id;
    const ts = context.scheduledAt;
    if (context.challengeId !== challengeId)
      throw new Error("Event challenge mismatch");
    if (!Number.isFinite(context.now) || context.now < ts)
      throw new Error("Event action is not due");
    if (context.secondMs !== d.minuteMs / 60)
      throw new Error("Event clock mismatch");

    switch (action.kind) {
      case "market_open":
        await this.updateConfig((config) => ({
          ...config,
          symbols: config.symbols.some(
            (s) => s.symbol === EDEN_EVENT_AERIUM.symbol,
          )
            ? config.symbols
            : [...config.symbols, EDEN_EVENT_AERIUM],
        }));
        await d.addSpotSymbol(EDEN_EVENT_AERIUM, false, ts);
        await d.setFrozen(false);
        d.challenge.frozen = false;
        return;
      case "list_underlying":
        await this.updateConfig((config) => ({
          ...config,
          symbols: config.symbols.some((s) => s.symbol === action.config.symbol)
            ? config.symbols
            : [...config.symbols, action.config],
        }));
        await d.addSpotSymbol(action.config, false, ts);
        return;
      case "list_etf":
        await this.updateConfig((config) => {
          if (!config.eden) throw new Error("Missing Eden config");
          const etfs = config.eden.etfs ?? [];
          return {
            ...config,
            eden: {
              ...config.eden,
              etfs: etfs.some((e) => e.symbol === action.config.symbol)
                ? etfs
                : [...etfs, action.config],
            },
          };
        });
        await d.addEtf(action.config, ts);
        return;
      case "bond_available":
        await this.updateConfig((config) => {
          if (!config.eden) throw new Error("Missing Eden config");
          const bonds = config.eden.bonds ?? [];
          return {
            ...config,
            eden: {
              ...config.eden,
              bonds: bonds.some((b) => b.id === action.bond.id)
                ? bonds
                : [...bonds, action.bond],
            },
          };
        });
        await d.addBond(action.bond);
        return;
      case "options_open":
        // Do not spawn fresh cycles after a fully elapsed tournament.
        if (
          context.now >=
          context.timestampAtSecond(EDEN_EVENT_DURATION_MINUTES * 60)
        )
          return;
        await this.updateConfig((config) => {
          if (!config.eden) throw new Error("Missing Eden config");
          return {
            ...config,
            eden: { ...config.eden, options: action.config },
          };
        });
        await d.openOptions(action.config, context.now);
        return;
      case "freeze":
        await d.setFrozen(true);
        d.challenge.frozen = true;
        await d.rescueLoans(ts);
        return;
      case "unfreeze":
        await d.setFrozen(false);
        d.challenge.frozen = false;
        return;
      case "end":
        await d.setFrozen(true);
        d.challenge.frozen = true;
        await d.finalize(ts);
        return;
      case "news":
        await this.publishNews(action, context);
        return;
      case "auction_open": {
        const id = context.resourceUuid(action.roundId);
        const expiresAt = new Date(
          context.timestampAtSecond(action.closesAtSecond),
        );
        await d.db
          .insert(auctions)
          .values({
            id,
            challengeId,
            status: "open",
            expiresAt,
            createdAt: new Date(ts),
          })
          .onConflictDoNothing();
        const [row] = await d.db
          .select()
          .from(auctions)
          .where(
            and(eq(auctions.id, id), eq(auctions.challengeId, challengeId)),
          );
        if (row?.status === "open" && context.now < row.expiresAt.getTime()) {
          await this.broadcast({
            type: "auction",
            challengeId,
            data: {
              id: row.id,
              challengeId,
              status: row.status,
              cutoff: row.cutoff,
              expiresAt: row.expiresAt.toISOString(),
              createdAt: row.createdAt.toISOString(),
            },
          });
        }
        return;
      }
      case "auction_resolve":
        await d.resolveAuction(
          context.resourceUuid(action.roundId),
          ts,
          context.timestampAtSecond(action.premiumUntilSecond),
        );
        return;
      case "vote_open": {
        const id = context.resourceUuid(action.voteId);
        const expiresAt = new Date(
          context.timestampAtSecond(action.closesAtSecond),
        );
        const traders = await this.humanTraders(ts);
        traders.sort(
          (a, b) =>
            d.engine.cashOf(b.userId) - d.engine.cashOf(a.userId) ||
            a.userId.localeCompare(b.userId),
        );
        const rich = traders.slice(
          0,
          Math.ceil(traders.length * action.topFraction),
        );
        const description = `${action.taxRate * 100}% of free cash from the top ${action.topFraction * 100}% is shared equally among the bottom ${action.bottomFraction * 100}%. Rankings are recomputed at closing. Current top cohort: ${rich.map((r) => `${r.displayName} (${r.userId})`).join(", ") || "none"}.`;
        await d.db
          .insert(voteProposals)
          .values({
            id,
            challengeId,
            title: action.title,
            description,
            kind: "wealth_tax",
            status: "open",
            expiresAt,
            createdAt: new Date(ts),
          })
          .onConflictDoNothing();
        const [row] = await d.db
          .select()
          .from(voteProposals)
          .where(
            and(
              eq(voteProposals.id, id),
              eq(voteProposals.challengeId, challengeId),
            ),
          );
        if (row?.status === "open" && context.now < row.expiresAt.getTime()) {
          const ballots = await d.db
            .select()
            .from(voteBallots)
            .where(eq(voteBallots.proposalId, id));
          await this.broadcast({
            type: "vote",
            challengeId,
            data: {
              id: row.id,
              challengeId,
              title: row.title,
              description: row.description,
              kind: "wealth_tax",
              status: row.status,
              expiresAt: row.expiresAt.toISOString(),
              yes: ballots.filter((b) => b.choice === "yes").length,
              no: ballots.filter((b) => b.choice === "no").length,
              createdAt: row.createdAt.toISOString(),
            },
          });
        }
        return;
      }
      case "vote_resolve":
        await d.resolveVote(context.resourceUuid(action.voteId), ts);
        return;
      case "grant_open": {
        const id = context.resourceUuid(action.grantId);
        const expiresAt = new Date(
          context.timestampAtSecond(action.awardsAtSecond),
        );
        await d.db
          .insert(grantMissions)
          .values({
            id,
            challengeId,
            symbol: action.symbol,
            prize: action.prize,
            description:
              "Strategic Reserves Critical. In exactly 5 minutes, the single player holding the highest inventory of Aerium will receive a massive $10,000 Government Grant.",
            status: "open",
            expiresAt,
            createdAt: new Date(ts),
          })
          .onConflictDoNothing();
        const [row] = await d.db
          .select()
          .from(grantMissions)
          .where(
            and(
              eq(grantMissions.id, id),
              eq(grantMissions.challengeId, challengeId),
            ),
          );
        if (row?.status === "open" && context.now < row.expiresAt.getTime()) {
          await this.broadcast({
            type: "grant",
            challengeId,
            data: {
              id: row.id,
              challengeId,
              symbol: row.symbol,
              description: row.description,
              prize: row.prize,
              status: row.status,
              winnerId: row.winnerId,
              expiresAt: row.expiresAt.toISOString(),
              createdAt: row.createdAt.toISOString(),
            },
          });
        }
        return;
      }
      case "grant_award":
        await d.awardGrant(context.resourceUuid(action.grantId), ts);
        return;
      case "otc_offer":
        await this.offerOtc(action, context);
        return;
      case "etf_window":
        await d.setEtfWindow(
          action.symbol,
          action.open &&
            context.now < context.timestampAtSecond(action.closesAtSecond) &&
            !d.challenge.frozen,
          ts,
        );
        return;
      case "bot_volatility":
        d.setVolatility(action.multiplier);
        return;
      case "vega_prepare": {
        const release = EDEN_EVENT_ACTIONS.find(
          (a) =>
            a.kind === "news" &&
            a.audience === "public" &&
            a.news.id === action.newsId,
        );
        if (!release)
          throw new Error(`Missing public release for ${action.newsId}`);
        const releaseAt = context.timestampAtSecond(release.atSecond);
        if (context.now < releaseAt)
          await d.prepareVega(action.symbol, releaseAt, context.now);
        return;
      }
      case "vega_resolve":
        await d.resolveVega(action.symbol, context.now);
        return;
      default: {
        const unreachable: never = action;
        throw new Error(`Unknown event action: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private async updateConfig(
    update: (config: ChallengeConfig) => ChallengeConfig,
  ): Promise<void> {
    const { db, challenge } = this.deps;
    const config = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(challenges)
        .where(eq(challenges.id, challenge.id))
        .for("update");
      if (!row) throw new Error(`Missing challenge ${challenge.id}`);
      const next = update(row.config);
      await tx
        .update(challenges)
        .set({ config: next })
        .where(eq(challenges.id, challenge.id));
      return next;
    });
    challenge.config = config;
  }

  private humanTraders(at: number) {
    return this.deps.db
      .select({ userId: users.id, displayName: users.displayName })
      .from(participants)
      .innerJoin(users, eq(participants.userId, users.id))
      .where(
        and(
          eq(participants.challengeId, this.deps.challenge.id),
          eq(users.role, "trader"),
          lte(participants.joinedAt, new Date(at)),
        ),
      )
      .orderBy(asc(users.id));
  }

  private broadcast(msg: ServerMessage, target = "all"): Promise<void> {
    return publishBroadcast(this.deps.redis, this.deps.challenge.id, [
      { target, msg },
    ]);
  }

  private async publishNews(
    action: Extract<EdenEventAction, { kind: "news" }>,
    context: EventActionContext,
  ): Promise<void> {
    const d = this.deps;
    const challengeId = d.challenge.id;
    const id = context.resourceUuid(action.news.id);
    const publicAt = context.timestampAtSecond(action.news.minute * 60);
    const premiumAt = context.timestampAtSecond(action.news.minute * 60 - 10);
    const momentum: MomentumEffect[] = action.news.momentum.map((m) => ({
      symbol: m.symbol,
      sentiment: m.direction,
    }));
    const volEvent = action.news.minute === 35 || action.news.minute === 90;
    const effects: FvEffect[] = action.news.effects.map((e) => {
      const current = d.engine.getFairValue(e.symbol);
      if (current === undefined || !Number.isFinite(current))
        throw new Error(`Missing FV for ${e.symbol}`);
      return {
        symbol: e.symbol,
        delta: e.operation === "cap" ? Math.min(0, e.value - current) : e.value,
      };
    });
    await d.db
      .insert(challengeNews)
      .values({
        id,
        challengeId,
        message: action.news.headline,
        level: "info",
        feed: "news",
        kind: action.news.classification,
        fvEffects: effects,
        momentum,
        volEvent,
        effectsAppliedAt: null,
        publishAt: new Date(premiumAt),
        publishedAt: new Date(premiumAt),
        embargoUntil: new Date(publicAt),
        createdAt: new Date(premiumAt),
      })
      .onConflictDoNothing();

    if (action.audience === "public") {
      // The poller must take this same row lock/check before applying a headline.
      // Commit absolute durable FVs and the marker together, before in-memory mutation.
      const applied = await d.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(challengeNews)
          .where(
            and(
              eq(challengeNews.id, id),
              eq(challengeNews.challengeId, challengeId),
            ),
          )
          .for("update");
        if (!row) throw new Error(`Missing scripted news ${id}`);
        if (row.effectsAppliedAt !== null) return false;
        const publicEffects: FvEffect[] = [];
        for (const effect of action.news.effects) {
          const current = d.engine.getFairValue(effect.symbol);
          if (current === undefined)
            throw new Error(`Missing FV for ${effect.symbol}`);
          const fairValue = Math.max(
            0,
            effect.operation === "cap"
              ? Math.min(current, effect.value)
              : current + effect.value,
          );
          publicEffects.push({
            symbol: effect.symbol,
            delta: fairValue - current,
          });
          await tx
            .insert(fairValues)
            .values({
              challengeId,
              symbol: effect.symbol,
              fairValue,
              updatedAt: new Date(publicAt),
            })
            .onConflictDoUpdate({
              target: [fairValues.challengeId, fairValues.symbol],
              set: { fairValue, updatedAt: new Date(publicAt) },
            });
        }
        await tx
          .update(challengeNews)
          .set({
            effectsAppliedAt: new Date(publicAt),
            fvEffects: publicEffects,
          })
          .where(
            and(
              eq(challengeNews.id, id),
              isNull(challengeNews.effectsAppliedAt),
            ),
          );
        return true;
      });
      // Also repair engine/cache after a crash between the durable commit and emit.
      const events: EngineEvent[] = [];
      if (effects.length > 0) {
        const rows = await d.db
          .select()
          .from(fairValues)
          .where(
            and(
              eq(fairValues.challengeId, challengeId),
              inArray(
                fairValues.symbol,
                effects.map((e) => e.symbol),
              ),
            ),
          );
        for (const row of rows) {
          d.engine.setFairValue(row.symbol, row.fairValue);
          await setFairValue(d.redis, challengeId, row.symbol, row.fairValue);
          events.push({
            type: "fair_value",
            challengeId,
            symbol: row.symbol,
            fairValue: row.fairValue,
            ts: publicAt,
          });
        }
      }
      if (applied) {
        if (events.length > 0) await d.emit(events);
        // Skip obsolete bot impulses on restart; still replay the durable FV change.
        if (context.now < publicAt + 5 * d.minuteMs && !d.challenge.frozen)
          d.newsPulse(momentum, volEvent);
      }
    }

    const item: NewsItem = {
      id,
      challengeId,
      message: action.news.headline,
      level: "info",
      feed: "news",
      createdAt: new Date(premiumAt).toISOString(),
      embargoUntil: new Date(publicAt).toISOString(),
    };
    // Cache only the sanitized shape and replace by ID on retry/public release.
    const cached = await getNewsFeed(d.redis, challengeId, 50);
    await setNewsFeed(
      d.redis,
      challengeId,
      [item, ...cached.filter((n) => n.id !== id)].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    );
    if (action.audience === "premium") {
      if (context.now >= publicAt) return;
      const traders = await this.humanTraders(context.now);
      const eligible = await Promise.all(
        traders.map((trader) =>
          hasPremiumAccess(d.redis, challengeId, trader.userId),
        ),
      );
      const recipients = traders.filter((_trader, index) => eligible[index]);
      if (recipients.length > 0)
        await publishBroadcast(
          d.redis,
          challengeId,
          recipients.map((trader) => ({
            target: trader.userId,
            msg: { type: "news", challengeId, data: item },
          })),
        );
    } else {
      await this.broadcast({ type: "news", challengeId, data: item });
    }
  }

  private async offerOtc(
    action: Extract<EdenEventAction, { kind: "otc_offer" }>,
    context: EventActionContext,
  ): Promise<void> {
    const d = this.deps;
    const challengeId = d.challenge.id;
    const expiresAt = new Date(
      context.timestampAtSecond(action.expiresAtSecond),
    );
    if (
      context.now >= expiresAt.getTime() ||
      d.challenge.frozen ||
      edenEventStateAt(action.atSecond).frozen
    )
      return;
    const fv = (symbol: string): number => {
      const value = d.engine.getFairValue(symbol);
      if (value === undefined || !Number.isFinite(value) || value < 0)
        throw new Error(`Missing FV for OTC asset ${symbol}`);
      return value;
    };

    const traders = await this.humanTraders(context.scheduledAt);
    if (traders.length === 0) return;
    const ids = traders.map((trader) =>
      context.resourceUuid(`${action.offer.id}/${trader.userId}`),
    );
    const filter = and(
      eq(otcOffers.challengeId, challengeId),
      inArray(otcOffers.id, ids),
    );
    const existing = new Set(
      (await d.db.select().from(otcOffers).where(filter)).map((row) => row.id),
    );
    const newRows: Array<typeof otcOffers.$inferInsert> = [];
    const contracts = action.offer.legs.some(
      (leg) => leg.asset === "AERIUM_ATM_CALL",
    )
      ? await d.db
          .select()
          .from(optionContracts)
          .where(
            and(
              eq(optionContracts.challengeId, challengeId),
              eq(optionContracts.underlying, "AERIUM"),
              eq(optionContracts.optionType, "call"),
              eq(optionContracts.status, "open"),
              gt(optionContracts.expiresAt, new Date(context.now)),
            ),
          )
      : [];
    for (const trader of traders) {
      const id = context.resourceUuid(`${action.offer.id}/${trader.userId}`);
      if (!existing.has(id)) {
        const legs: OtcLeg[] = [];
        let choices: OtcLeg[] | undefined;
        for (const template of action.offer.legs) {
          let symbol: string = template.asset;
          let quantity = template.quantity;
          let basis: number;
          if (template.asset === "PLAYER_CHOICE") {
            const held = d.engine
              .symbols()
              .map((s) => ({
                symbol: s,
                quantity: d.engine.positionOf(trader.userId, s),
              }))
              .filter(
                (p) =>
                  p.quantity > 0 &&
                  d.engine.isSymbolOpen(p.symbol, context.now) &&
                  Number.isFinite(d.engine.getFairValue(p.symbol)) &&
                  d.engine.getFairValue(p.symbol)! >= 0,
              )
              .sort(
                (a, b) =>
                  b.quantity - a.quantity || a.symbol.localeCompare(b.symbol),
              );
            choices = held.map((position) => ({
              symbol: position.symbol,
              quantity: -Math.min(50, position.quantity),
              price: fv(position.symbol) * template.multiplier,
            }));
            if (!choices[0]) break;
            // The first choice is only a preview. Acceptance must select a leg.
            legs.push({ ...choices[0] });
            continue;
          } else if (template.asset === "AERIUM_ATM_CALL") {
            const spot = d.engine.getPrice("AERIUM");
            if (spot === undefined || !Number.isFinite(spot))
              throw new Error("Missing AERIUM market price");
            const contract = contracts
              .filter((c) => d.engine.isSymbolOpen(c.symbol, context.now))
              .sort(
                (a, b) =>
                  Math.abs(a.strike - spot) - Math.abs(b.strike - spot) ||
                  a.expiresAt.getTime() - b.expiresAt.getTime() ||
                  a.symbol.localeCompare(b.symbol),
              )[0];
            if (!contract) break;
            symbol = contract.symbol;
            basis = Math.max(0, spot - contract.strike);
          } else if (template.basis === "nav") {
            const basket =
              d.challenge.config.eden?.etfs?.find((e) => e.symbol === symbol)
                ?.basket ?? EDEN_EVENT_ETF.basket;
            basis = basket.reduce(
              (sum, component) => sum + fv(component.symbol) * component.weight,
              0,
            );
          } else {
            basis = template.basis === "zero" ? 0 : fv(symbol);
          }
          if (!d.engine.isSymbolOpen(symbol, context.now)) break;
          legs.push({ symbol, quantity, price: basis * template.multiplier });
        }
        if (legs.length !== action.offer.legs.length) continue;
        const description = action.offer.playerChoosesQuantity
          ? `${action.offer.title}: choose exactly one listed asset and 1 to its offered maximum units (at most 50). Quoted unit prices are fixed at 90% of FV when offered.`
          : action.offer.title;
        newRows.push({
          id,
          challengeId,
          userId: trader.userId,
          description,
          legs,
          choices,
          // The engine separately debits sum(quantity * price); never double charge it here.
          cashToTrader: 0,
          status: "pending",
          expiresAt,
          createdAt: new Date(context.scheduledAt),
        });
      }
    }
    // Bound parameter counts for large tournaments while avoiding one DB round trip per trader.
    for (let offset = 0; offset < newRows.length; offset += 500)
      await d.db
        .insert(otcOffers)
        .values(newRows.slice(offset, offset + 500))
        .onConflictDoNothing();
    const rows = await d.db.select().from(otcOffers).where(filter);
    const pending = rows.filter(
      (row) =>
        row.status === "pending" && context.now < row.expiresAt.getTime(),
    );
    if (pending.length > 0)
      await publishBroadcast(
        d.redis,
        challengeId,
        pending.map((row) => ({
          target: row.userId,
          msg: {
            type: "otc_offer",
            challengeId,
            data: {
              id: row.id,
              challengeId,
              userId: row.userId,
              description: row.description,
              legs: row.legs,
              choices: row.choices ?? undefined,
              cashToTrader: row.cashToTrader,
              status: row.status,
              expiresAt: row.expiresAt.toISOString(),
              createdAt: row.createdAt.toISOString(),
              settleAt: row.settleAt?.toISOString() ?? null,
            },
          },
        })),
      );
  }
}
