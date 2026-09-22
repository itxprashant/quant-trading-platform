import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  bondHoldings,
  challenges,
  optionContracts,
  participants,
  positions,
  users,
  type BondHolding,
  type Challenge,
  type Position,
  type User,
} from "./schema.js";

export interface AccountValuation {
  userId: string;
  username: string;
  displayName: string;
  role: User["role"];
  cash: number;
  startingCash: number;
  loanDebt: number;
  positions: Position[];
  bonds: BondHolding[];
  positionValue: number;
  bondValue: number;
  marketValue: number;
  absInventory: number;
  equity: number;
}

export interface ChallengeValuation {
  challenge: Challenge;
  prices: Map<string, number>;
  accounts: AccountValuation[];
}

/** Read durable balances; inject the hot-price lookup to keep DB free of bus/core dependencies. */
export async function getChallengeValuation(
  db: Pick<Database, "query" | "select">,
  challengeId: string,
  getPrice: (symbol: string) => Promise<number | undefined | null>,
  {
    now = Date.now(),
    marks,
  }: { now?: number; marks?: Record<string, number> } = {},
): Promise<ChallengeValuation | undefined> {
  const challenge = await db.query.challenges.findFirst({
    where: eq(challenges.id, challengeId),
  });
  if (!challenge) return;

  const [parts, positionRows, bondRows, contracts] = await Promise.all([
    db
      .select({
        userId: participants.userId,
        cash: participants.cash,
        startingCash: participants.startingCash,
        loanDebt: participants.loanDebt,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
      })
      .from(participants)
      .innerJoin(users, eq(users.id, participants.userId))
      .where(eq(participants.challengeId, challengeId)),
    db.select().from(positions).where(eq(positions.challengeId, challengeId)),
    db
      .select()
      .from(bondHoldings)
      .where(eq(bondHoldings.challengeId, challengeId)),
    db
      .select()
      .from(optionContracts)
      .where(eq(optionContracts.challengeId, challengeId)),
  ]);

  const symbols = new Map(challenge.config.symbols.map((s) => [s.symbol, s]));
  const options = new Map(contracts.map((c) => [c.symbol, c]));
  const etfs = new Map(
    (challenge.config.eden?.etfs ?? []).map((e) => [e.symbol, e]),
  );
  const prices = new Map<string, number>();
  const resolving = new Set<string>();
  async function mark(symbol: string): Promise<number> {
    const cached = prices.get(symbol);
    if (cached !== undefined) return cached;
    // Authoritative checkpoint marks bypass both live caches and time-dependent fallbacks.
    if (marks !== undefined) {
      const price = Object.hasOwn(marks, symbol) ? marks[symbol] : undefined;
      if (price === undefined || !Number.isFinite(price) || price < 0) {
        throw new Error(
          `Missing or invalid final valuation price for ${challengeId}:${symbol}`,
        );
      }
      prices.set(symbol, price);
      return price;
    }
    if (resolving.has(symbol))
      throw new Error(`Cyclic valuation for ${symbol}`);
    resolving.add(symbol);
    const option = options.get(symbol);
    let price = option?.status === "expired" ? 0 : await getPrice(symbol);
    if (
      option &&
      option.status !== "expired" &&
      (price == null ||
        option.status === "exercise_window" ||
        option.expiresAt.getTime() <= now)
    ) {
      const spot = await mark(option.underlying);
      const fraction =
        option.status === "exercise_window"
          ? 0
          : Math.min(
              1,
              Math.max(
                0,
                (option.expiresAt.getTime() - now) /
                  Math.max(
                    1,
                    option.expiresAt.getTime() - option.createdAt.getTime(),
                  ),
              ),
            );
      // Same intrinsic + decaying volatility premium as core.theoreticalOption.
      const intrinsic = Math.max(
        0,
        option.optionType === "put"
          ? option.strike - spot
          : spot - option.strike,
      );
      price =
        intrinsic +
        Math.max(0, symbols.get(option.underlying)?.volatility ?? 0) *
          4 *
          fraction;
    }
    const etf = etfs.get(symbol);
    if (price == null && etf) {
      price = 0;
      for (const leg of etf.basket)
        price += leg.weight * (await mark(leg.symbol));
    }
    price ??= symbols.get(symbol)?.initialPrice;
    // A missing dynamic mark must not silently erase a long asset or short liability.
    if (price == null || !Number.isFinite(price) || price < 0) {
      throw new Error(
        `Missing or invalid valuation price for ${challengeId}:${symbol}`,
      );
    }
    prices.set(symbol, price);
    resolving.delete(symbol);
    return price;
  }

  for (const symbol of symbols.keys()) await mark(symbol);
  for (const position of positionRows) {
    if (position.quantity !== 0) await mark(position.symbol);
  }

  const accounts = new Map<string, AccountValuation>();
  for (const part of parts) {
    accounts.set(part.userId, {
      ...part,
      // The engine persists aggregate outstanding debt here, including forced loans.
      loanDebt: challenge.type === "new_eden" ? part.loanDebt : 0,
      positions: [],
      bonds: [],
      positionValue: 0,
      bondValue: 0,
      marketValue: 0,
      absInventory: 0,
      equity: 0,
    });
  }
  for (const position of positionRows) {
    const account = accounts.get(position.userId);
    if (!account) continue;
    account.positions.push(position);
    account.positionValue +=
      position.quantity * (prices.get(position.symbol) ?? 0);
    account.absInventory += Math.abs(position.quantity);
  }
  for (const bond of bondRows) {
    const account = accounts.get(bond.userId);
    if (!account || challenge.type !== "new_eden") continue;
    account.bonds.push(bond);
    // Coupons already flow into cash. Only outstanding principal belongs here.
    account.bondValue += Math.max(0, bond.quantity) * bond.faceValue;
  }
  for (const account of accounts.values()) {
    account.marketValue = account.positionValue + account.bondValue;
    account.equity = account.cash + account.marketValue - account.loanDebt;
  }
  return { challenge, prices, accounts: [...accounts.values()] };
}
