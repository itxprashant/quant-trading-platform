import type {
  BondTemplate,
  EdenCueKind,
  EdenCueStatus,
  EdenOptionsConfig,
  EtfConfig,
  SymbolConfig,
} from "./schemas.js";
import {
  EDEN_EVENT_AUCTION_CLOSE_LEAD_SEC,
  EDEN_EVENT_AUCTION_MINUTES,
  EDEN_EVENT_AUCTION_OPEN_LEAD_SEC,
  EDEN_EVENT_DURATION_MINUTES,
  EDEN_EVENT_ETF_LIST_MINUTE,
  EDEN_EVENT_ETF_WINDOW_MINUTES,
  EDEN_EVENT_ETF_WINDOW_SEC,
  EDEN_EVENT_HALFTIME_END_MINUTE,
  EDEN_EVENT_HALFTIME_START_MINUTE,
  EDEN_EVENT_OPTIONS_OPEN_MINUTE,
  EDEN_EVENT_PREMIUM_ACCESS_MINUTES,
  EDEN_EVENT_PREMIUM_LEAD_SEC,
} from "./eden-clock.js";
import {
  EDEN_EVENT_BONDS,
  EDEN_EVENT_DEFAULTS,
  EDEN_EVENT_ETF,
  EDEN_EVENT_NEURO,
  EDEN_EVENT_OPTIONS,
} from "./eden-presets.js";

/** Versioned IDs are durable receipts. Never renumber actions in a running event. */
export const EDEN_EVENT_VERSION = "eden-v1";

export type EdenFairValueEffect = Readonly<{
  symbol: string;
  /** cap means min(current FV, value), not an upward reset to the ceiling. */
  operation: "delta" | "cap";
  value: number;
}>;
export type EdenNews = Readonly<{
  id: string;
  minute: number;
  classification: "signal" | "noise";
  headline: string;
  effects: readonly EdenFairValueEffect[];
  /** Directional bot impulses, deliberately independent of FV effects. */
  momentum: readonly Readonly<{ symbol: string; direction: -1 | 1 }>[];
  /** False means supplied wording (official introductions or filler), not a quoted script headline. */
  original: boolean;
}>;

const delta = (symbol: string, value: number): EdenFairValueEffect => ({
  symbol,
  operation: "delta",
  value,
});
const pulse = (symbol: string, direction: -1 | 1) => ({ symbol, direction });
const news = (
  minute: number,
  classification: EdenNews["classification"],
  headline: string,
  effects: EdenNews["effects"] = [],
  momentum: EdenNews["momentum"] = [],
  original = true,
): EdenNews => ({
  id: `${EDEN_EVENT_VERSION}/news/${minute}`,
  minute,
  classification,
  headline,
  effects,
  momentum,
  original,
});

/** Exact 12/12 split: original labels plus the cap and two FV-establishing introductions as signals. */
export const EDEN_EVENT_NEWS: readonly EdenNews[] = [
  news(
    5,
    "signal",
    "Refinery strike in Sector 4 cuts Aerium output by 12%.",
    [delta("AERIUM", 50)],
    [pulse("AERIUM", 1)],
  ),
  news(
    10,
    "noise",
    "Senate sub-committee discussing long-term viability of Aerium infrastructure.",
    [],
    [pulse("AERIUM", -1)],
  ),
  news(
    15,
    "signal",
    "New extraction tax levied on raw Aerium. Processing costs up 8%.",
    [delta("AERIUM", -40)],
    [pulse("AERIUM", -1)],
  ),
  news(
    20,
    "noise",
    "Celebrity influencer 'Nova' endorses Aerium on holonet.",
    [],
    [pulse("AERIUM", 1)],
  ),
  news(
    25,
    "signal",
    "Smugglers busted with 50,000 tons of counterfeit Aerium; market supply shocks.",
    [delta("AERIUM", 80)],
    [pulse("AERIUM", 1)],
  ),
  news(
    30,
    "signal",
    "Neuro-Chips approved for civilian use! Deep silicon linkage established with Aerium.",
    [delta("AERIUM", 20)],
    [pulse("AERIUM", 1), pulse("NEURO", 1)],
  ),
  news(
    35,
    "noise",
    "Unverified rumor: Neuro-Chip CEO seen leaving rival's headquarters.",
    [],
    [pulse("NEURO", -1)],
  ),
  news(
    40,
    "signal",
    "Cobalt shortage cripples Neuro-Chip assembly lines.",
    [delta("NEURO", 100)],
    [pulse("NEURO", 1)],
  ),
  news(
    45,
    "signal",
    "Orbital-Station ETF opens for trading: 1 ETF = 2 AERIUM + 1 NEURO-CHIP.",
    // The preceding list_etf action establishes basket FV; no additive shock.
    [],
    [pulse("ORBITAL", 1)],
    false,
  ),
  news(
    50,
    "noise",
    "Orbital-Station quarterly earnings report delayed by 1 hour due to clerical error.",
    [],
    [pulse("ORBITAL", -1)],
  ),
  news(
    55,
    "signal",
    "Central Economists warn that Aerium is dangerously over-leveraged. True intrinsic valuation models dictate price should not exceed 1150.",
    [{ symbol: "AERIUM", operation: "cap", value: 1150 }],
    [pulse("AERIUM", -1)],
  ),
  news(
    60,
    "noise",
    "Trading halted for halftime. Positions do not reset.",
    [],
    [],
    false,
  ),
  news(
    70,
    "signal",
    "Aerium Calls/Puts open for trading. Session 2 begins with five-minute option cycles and a 15-second exercise window.",
    // The preceding options_open action establishes option FVs, not a spot delta.
    [],
    [],
    false,
  ),
  news(
    75,
    "signal",
    "Options expire. Massive Gamma squeeze observed on Neuro-Chips.",
    [delta("NEURO", 50)],
    [pulse("NEURO", 1)],
  ),
  news(
    80,
    "noise",
    "The Solidarity Tax: a 10% wealth tax on the Top 10% for the Bottom 20% is put to a vote.",
    [],
    [],
    false,
  ),
  news(
    85,
    "noise",
    "Analyst downgrades Neuro-Chips to 'Hold', citing lack of innovation.",
    [],
    [pulse("NEURO", -1)],
  ),
  news(
    90,
    "signal",
    "Zero-point energy prototype successful! Aerium obsolete!",
    [delta("AERIUM", -300), delta("NEURO", 200)],
    [pulse("AERIUM", -1), pulse("NEURO", 1)],
  ),
  news(
    95,
    "noise",
    "Mass protests in the capital against zero-point energy safety risks.",
    [],
    [pulse("AERIUM", 1)],
  ),
  news(
    100,
    "noise",
    "Strategic Reserves Critical. In exactly 5 minutes, the single player holding the highest inventory of Aerium will receive a massive $10,000 Government Grant.",
    [],
    [pulse("AERIUM", 1)],
  ),
  news(
    105,
    "noise",
    "Government Grant awarded. The Aerium inventory race is over.",
    [],
    [pulse("AERIUM", -1)],
    false,
  ),
  news(
    110,
    "noise",
    "CEO of Orbital Station tweets a rocket emoji.",
    [],
    [pulse("ORBITAL", 1)],
  ),
  news(
    115,
    "signal",
    "Solar flare scrambles Neuro-Chip logic gates globally!",
    [delta("NEURO", -150)],
    [pulse("NEURO", -1)],
  ),
  news(
    120,
    "noise",
    "The Final Squeeze: bot volatility parameters are tripled.",
    [],
    [],
    false,
  ),
  news(
    125,
    "signal",
    "Massive cyberattack disables 40% of remaining Aerium grid.",
    [delta("AERIUM", 120)],
    [pulse("AERIUM", 1)],
  ),
];

export type EdenOtcAsset =
  | "AERIUM"
  | "ORBITAL"
  | "NEURO"
  | "AERIUM_ATM_CALL"
  | "PLAYER_CHOICE";
export type EdenOtcLeg = Readonly<{
  asset: EdenOtcAsset;
  /** Signed from the player's perspective: positive receives, negative delivers. */
  quantity: number;
  basis: "fair_value" | "nav" | "intrinsic" | "zero";
  multiplier: number;
}>;
export type EdenOtcOffer = Readonly<{
  id: string;
  minute: number;
  title: string;
  legs: readonly EdenOtcLeg[];
  original: boolean;
  /** No OTC settlement may occur during halftime, including generic offers. */
  tradingRequired: true;
  playerChoosesQuantity: boolean;
}>;

function otc(minute: number): EdenOtcOffer {
  const leg = (
    asset: EdenOtcAsset,
    quantity: number,
    basis: EdenOtcLeg["basis"],
    multiplier: number,
  ): EdenOtcLeg => ({ asset, quantity, basis, multiplier });
  const exact: Record<number, { title: string; legs: EdenOtcLeg[] }> = {
    12.5: {
      title: 'The "Too Good to be True" Block',
      legs: [leg("AERIUM", 50, "fair_value", 0.95)],
    },
    32.5: {
      title: "The Paired Correlation Trade",
      legs: [leg("AERIUM", -20, "zero", 0), leg("NEURO", 20, "zero", 0)],
    },
    52.5: {
      title: "The ETF Arbitrage Setup",
      legs: [leg("ORBITAL", 10, "nav", 1.02)],
    },
    72.5: {
      title: "The Volatility Dump",
      legs: [leg("AERIUM_ATM_CALL", -15, "intrinsic", 1.2)],
    },
    92.5: {
      title: 'The "Dis-Correlation Nuke" Aftermath',
      legs: [leg("AERIUM", 30, "fair_value", 1.2)],
    },
    112.5: {
      title: "The Desperation Bailout",
      legs: [leg("PLAYER_CHOICE", -50, "fair_value", 0.9)],
    },
  };
  const offer = exact[minute];
  return {
    id: `${EDEN_EVENT_VERSION}/otc/${minute}`,
    minute,
    title: offer?.title ?? "Deal Desk: Aerium liquidity block",
    // Sized well below starting cash: at minute 2.5 every trader still holds
    // exactly that, and a cash-exhausting fill is an instant margin call.
    legs: offer?.legs ?? [leg("AERIUM", 5, "fair_value", 1)],
    original: !!offer,
    tradingRequired: true,
    playerChoosesQuantity: minute === 112.5,
  };
}

export const EDEN_EVENT_OTC: readonly EdenOtcOffer[] = Array.from(
  { length: 13 },
  (_, i) => otc(2.5 + i * 10),
);

export type EdenEventPayload =
  | { kind: "market_open" }
  | { kind: "freeze"; reason: "halftime" }
  | { kind: "unfreeze" }
  | { kind: "end" }
  | { kind: "bond_available"; bond: BondTemplate }
  | { kind: "list_underlying"; config: SymbolConfig }
  | { kind: "list_etf"; config: EtfConfig }
  | { kind: "options_open"; config: EdenOptionsConfig }
  | { kind: "news"; audience: "premium" | "public"; news: EdenNews }
  | {
      kind: "auction_open" | "auction_resolve";
      roundId: string;
      roundMinute: number;
      closesAtSecond: number;
      premiumUntilSecond: number;
    }
  | { kind: "otc_offer"; offer: EdenOtcOffer; expiresAtSecond: number }
  | {
      kind: "etf_window";
      symbol: string;
      open: boolean;
      closesAtSecond: number;
    }
  | {
      kind: "vote_open" | "vote_resolve";
      voteId: string;
      title: string;
      closesAtSecond: number;
      ranking: "cash";
      taxRate: number;
      topFraction: number;
      bottomFraction: number;
    }
  | {
      kind: "grant_open" | "grant_award";
      grantId: string;
      symbol: string;
      prize: number;
      awardsAtSecond: number;
    }
  | { kind: "vega_prepare" | "vega_resolve"; newsId: string; symbol: string }
  | { kind: "bot_volatility"; multiplier: number };

export type EdenEventAction = Readonly<
  EdenEventPayload & { id: string; atSecond: number }
>;

function buildSchedule(): readonly EdenEventAction[] {
  const actions: EdenEventAction[] = [];
  const add = (id: string, atSecond: number, payload: EdenEventPayload) => {
    actions.push({ id: `${EDEN_EVENT_VERSION}/${id}`, atSecond, ...payload });
  };
  add("open", 0, { kind: "market_open" });
  EDEN_EVENT_BONDS.forEach((bond, i) =>
    add(`bond/${bond.id}`, (i === 0 ? 10 : 18) * 60, {
      kind: "bond_available",
      bond,
    }),
  );
  add("list/neuro", 30 * 60, {
    kind: "list_underlying",
    config: EDEN_EVENT_NEURO,
  });
  add("list/orbital", EDEN_EVENT_ETF_LIST_MINUTE * 60, {
    kind: "list_etf",
    config: EDEN_EVENT_ETF,
  });
  add("freeze", EDEN_EVENT_HALFTIME_START_MINUTE * 60, {
    kind: "freeze",
    reason: "halftime",
  });
  add("unfreeze", EDEN_EVENT_HALFTIME_END_MINUTE * 60, { kind: "unfreeze" });
  add("options/open", EDEN_EVENT_OPTIONS_OPEN_MINUTE * 60, {
    kind: "options_open",
    config: { ...EDEN_EVENT_OPTIONS, enabled: true },
  });

  for (const minute of EDEN_EVENT_AUCTION_MINUTES) {
    const round = {
      roundId: `${EDEN_EVENT_VERSION}/auction/${minute}`,
      roundMinute: minute,
      closesAtSecond: minute * 60 - EDEN_EVENT_AUCTION_CLOSE_LEAD_SEC,
      premiumUntilSecond:
        (minute + EDEN_EVENT_PREMIUM_ACCESS_MINUTES) * 60 -
        EDEN_EVENT_AUCTION_CLOSE_LEAD_SEC,
    };
    add(`auction/${minute}/open`, minute * 60 - EDEN_EVENT_AUCTION_OPEN_LEAD_SEC, {
      kind: "auction_open",
      ...round,
    });
    add(`auction/${minute}/resolve`, round.closesAtSecond, {
      kind: "auction_resolve",
      ...round,
    });
  }

  const vote = {
    voteId: `${EDEN_EVENT_VERSION}/vote/solidarity`,
    title: "The Solidarity Tax",
    closesAtSecond: 81 * 60,
    ranking: "cash" as const,
    taxRate: EDEN_EVENT_DEFAULTS.taxRate,
    topFraction: EDEN_EVENT_DEFAULTS.taxTopFraction,
    bottomFraction: EDEN_EVENT_DEFAULTS.taxBottomFraction,
  };
  add("vote/open", 80 * 60, { kind: "vote_open", ...vote });
  add("vote/resolve", vote.closesAtSecond, { kind: "vote_resolve", ...vote });
  const grant = {
    grantId: `${EDEN_EVENT_VERSION}/grant/aerium`,
    symbol: "AERIUM",
    prize: 10000,
    awardsAtSecond: 105 * 60,
  };
  add("grant/open", 100 * 60, { kind: "grant_open", ...grant });
  add("grant/award", grant.awardsAtSecond, { kind: "grant_award", ...grant });
  const vega = { newsId: `${EDEN_EVENT_VERSION}/news/90`, symbol: "AERIUM" };
  add("vega/prepare", 89 * 60, { kind: "vega_prepare", ...vega });
  add("volatility/triple", 120 * 60, { kind: "bot_volatility", multiplier: 3 });

  for (const item of EDEN_EVENT_NEWS) {
    add(`news/${item.minute}/premium`, item.minute * 60 - EDEN_EVENT_PREMIUM_LEAD_SEC, {
      kind: "news",
      audience: "premium",
      news: item,
    });
    add(`news/${item.minute}/public`, item.minute * 60, {
      kind: "news",
      audience: "public",
      news: item,
    });
  }
  // At 90: apply the public FV shock before the Vega inventory dump.
  add("vega/resolve", 90 * 60, { kind: "vega_resolve", ...vega });
  for (const offer of EDEN_EVENT_OTC) {
    add(`otc/${offer.minute}`, offer.minute * 60, {
      kind: "otc_offer",
      offer,
      expiresAtSecond: offer.minute * 60 + EDEN_EVENT_DEFAULTS.otcReplySec,
    });
  }
  // Anchored to the ETF's 45-minute introduction, not process startup.
  for (const minute of EDEN_EVENT_ETF_WINDOW_MINUTES) {
    const closesAtSecond = minute * 60 + EDEN_EVENT_ETF_WINDOW_SEC;
    add(`etf/${minute}/open`, minute * 60, {
      kind: "etf_window",
      symbol: "ORBITAL",
      open: true,
      closesAtSecond,
    });
    add(`etf/${minute}/close`, closesAtSecond, {
      kind: "etf_window",
      symbol: "ORBITAL",
      open: false,
      closesAtSecond,
    });
  }
  add("end", EDEN_EVENT_DURATION_MINUTES * 60, { kind: "end" });
  // Stable sort preserves deliberate same-time ordering (auction resolve before premium).
  return actions.sort((a, b) => a.atSecond - b.atSecond);
}

export const EDEN_EVENT_ACTIONS = /*#__PURE__*/ buildSchedule();

/** Pure selector; completed IDs are stable action strings, not runtime database UUIDs. */
export function dueEdenEventActions(
  elapsedSeconds: number,
  completed: ReadonlySet<string> = new Set(),
): readonly EdenEventAction[] {
  if (!Number.isFinite(elapsedSeconds))
    throw new RangeError("elapsedSeconds must be finite");
  return EDEN_EVENT_ACTIONS.filter(
    (action) => action.atSecond <= elapsedSeconds && !completed.has(action.id),
  );
}

/**
 * A host-fired beat of the playbook (`config.eden.playbookCues`). Firing runs
 * its actions with their scripted offsets from the first one. ETF windows and
 * the halftime OTC slot have no cue; ETF windows cycle on their own.
 */
export type EdenEventCue = Readonly<{
  /** Stable key stored in fire receipts; never rename for an event in flight. */
  id: string;
  label: string;
  /** Playbook minute the beat belongs to. */
  minute: number;
  kind: EdenCueKind;
  actions: readonly EdenEventAction[];
  /** Cues that must be done first, e.g. NEURO headlines need NEURO listed. */
  requires: readonly string[];
}>;

/** Receipt recording when a cue fired; its actions keep their own receipts. */
export const edenCueReceiptId = (cueId: string): string =>
  `${EDEN_EVENT_VERSION}/cue/${cueId}`;

const CUE_LISTING_FOR: Readonly<Record<string, string>> = {
  AERIUM: "open",
  NEURO: "list-neuro",
  ORBITAL: "list-orbital",
  AERIUM_ATM_CALL: "reopen",
};

function actionSymbols(action: EdenEventAction): string[] {
  if (action.kind === "news")
    return [
      ...action.news.effects.map((e) => e.symbol),
      ...action.news.momentum.map((m) => m.symbol),
    ];
  if (action.kind === "otc_offer") return action.offer.legs.map((l) => l.asset);
  if (action.kind === "list_etf")
    return action.config.basket.map((c) => c.symbol);
  return [];
}

function buildCues(): readonly EdenEventCue[] {
  const cues: Array<EdenEventCue & { order: number }> = [];
  const add = (
    id: string,
    label: string,
    minute: number,
    kind: EdenEventCue["kind"],
    actionIds: readonly string[],
    requires: readonly string[] = ["open"],
  ) => {
    const wanted = new Set(actionIds.map((a) => `${EDEN_EVENT_VERSION}/${a}`));
    const actions = EDEN_EVENT_ACTIONS.filter((a) => wanted.has(a.id));
    if (actions.length !== wanted.size)
      throw new Error(`Cue ${id} references a missing action`);
    const needs = new Set(requires);
    for (const symbol of actions.flatMap(actionSymbols)) {
      const listing = CUE_LISTING_FOR[symbol];
      if (listing && listing !== id) needs.add(listing);
    }
    cues.push({
      id,
      label,
      minute,
      kind,
      actions,
      requires: [...needs],
      // An auction resolves before its minute's headline, as in the script.
      order: kind === "auction" ? minute - 0.5 : minute,
    });
  };
  const newsIds = (minute: number) => [
    `news/${minute}/premium`,
    `news/${minute}/public`,
  ];

  add("open", "Open market", 0, "market", ["open"], []);
  for (const action of EDEN_EVENT_ACTIONS) {
    if (action.kind !== "bond_available") continue;
    add(
      `bond-${action.bond.id}`,
      `List ${action.bond.name}`,
      action.atSecond / 60,
      "market",
      [action.id.slice(EDEN_EVENT_VERSION.length + 1)],
    );
  }
  add("list-neuro", "List NEURO", 30, "scene", ["list/neuro", ...newsIds(30)]);
  add("list-orbital", "List ORBITAL ETF", EDEN_EVENT_ETF_LIST_MINUTE, "scene", [
    "list/orbital",
    ...newsIds(EDEN_EVENT_ETF_LIST_MINUTE),
  ]);
  add("halftime", "Halftime freeze", EDEN_EVENT_HALFTIME_START_MINUTE, "scene", [
    "freeze",
    ...newsIds(EDEN_EVENT_HALFTIME_START_MINUTE),
  ]);
  add(
    "reopen",
    "Reopen with options",
    EDEN_EVENT_HALFTIME_END_MINUTE,
    "scene",
    ["unfreeze", "options/open", ...newsIds(EDEN_EVENT_OPTIONS_OPEN_MINUTE)],
    ["open", "halftime"],
  );
  add("vote", "Solidarity Tax vote", 80, "scene", [
    "vote/open",
    "vote/resolve",
    ...newsIds(80),
  ]);
  // The vega bots trade the event option series, so options must be open.
  add(
    "shock",
    "Dis-correlation shock",
    90,
    "scene",
    ["vega/prepare", "vega/resolve", ...newsIds(90)],
    ["open", "reopen"],
  );
  add("grant", "Government grant", 100, "scene", [
    "grant/open",
    "grant/award",
    ...newsIds(100),
    ...newsIds(105),
  ]);
  add("squeeze", "Final squeeze", 120, "scene", [
    "volatility/triple",
    ...newsIds(120),
  ]);
  add("close", "Close event", EDEN_EVENT_DURATION_MINUTES, "market", ["end"], []);

  const inScene = new Set([30, 45, 60, 70, 80, 90, 100, 105, 120]);
  for (const item of EDEN_EVENT_NEWS) {
    if (inScene.has(item.minute)) continue;
    add(`news-${item.minute}`, item.headline, item.minute, "news", newsIds(item.minute));
  }
  for (const offer of EDEN_EVENT_OTC) {
    if (
      offer.minute >= EDEN_EVENT_HALFTIME_START_MINUTE &&
      offer.minute < EDEN_EVENT_HALFTIME_END_MINUTE
    )
      continue;
    add(`otc-${offer.minute}`, offer.title, offer.minute, "otc", [
      `otc/${offer.minute}`,
    ]);
  }
  for (const minute of EDEN_EVENT_AUCTION_MINUTES)
    add(`auction-${minute}`, "Premium feed auction", minute, "auction", [
      `auction/${minute}/open`,
      `auction/${minute}/resolve`,
    ]);
  // Stable sort keeps a scene ahead of a standalone beat on the same minute.
  return cues
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...cue }) => cue);
}

/** Playbook order; "Run next" fires the first cue that has not fired. */
export const EDEN_EVENT_CUES = /*#__PURE__*/ buildCues();

export function edenEventCue(cueId: string): EdenEventCue | undefined {
  return EDEN_EVENT_CUES.find((cue) => cue.id === cueId);
}

/** `receipts` holds event_actions ids: cue fire receipts and action receipts. */
export function edenCueStatus(
  cue: EdenEventCue,
  receipts: ReadonlySet<string>,
): EdenCueStatus {
  if (receipts.has(edenCueReceiptId(cue.id)))
    return cue.actions.every((a) => receipts.has(a.id)) ? "done" : "running";
  return edenCueBlockers(cue, receipts).length > 0 ? "blocked" : "ready";
}

/** Required cue ids that are not done yet. */
export function edenCueBlockers(
  cue: EdenEventCue,
  receipts: ReadonlySet<string>,
): string[] {
  return cue.requires.filter((id) => {
    const required = edenEventCue(id);
    return !required || edenCueStatus(required, receipts) !== "done";
  });
}
