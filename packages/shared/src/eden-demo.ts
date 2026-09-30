import type { BondTemplate, EdenOptionsConfig } from "./schemas.js";
import {
  EDEN_EVENT_PREMIUM_LEAD_SEC,
  EDEN_EVENT_ETF_WINDOW_SEC,
} from "./eden-clock.js";
import {
  EDEN_DEMO_DURATION_MINUTES,
  EDEN_EVENT_DEFAULTS,
  EDEN_EVENT_ETF,
  EDEN_EVENT_NEURO,
} from "./eden-presets.js";
import type {
  EdenEventAction,
  EdenEventCue,
  EdenEventPayload,
  EdenNews,
} from "./eden-event.js";

/**
 * Practice timeline for tester accounts. Receipt ids are `eden-demo-v1/*`.
 * Do not renumber them for a demo that is already in flight, and do not reuse
 * `eden-v1` ids. Headlines here are practice copy, not the tournament script.
 */
export const EDEN_DEMO_VERSION = "eden-demo-v1";

const DEMO_BONDS: readonly BondTemplate[] = [
  {
    id: "standard",
    name: "Standard Bond",
    price: 2500,
    faceValue: 2500,
    payoutMultiplier: 2,
    maxPerUser: 1,
  },
  {
    id: "aerium_pegged",
    name: "Aerium-Pegged Yield Bond",
    price: 2500,
    faceValue: 2500,
    payoutMultiplier: 2,
    maxPerUser: 1,
  },
];

const DEMO_OPTIONS: EdenOptionsConfig = {
  enabled: true,
  underlyings: ["AERIUM"],
  cycleMinutes: 4,
  exerciseWindowSec: 15,
  autoCycle: true,
  strikeSteps: 1,
};

const delta = (symbol: string, value: number) =>
  ({ symbol, operation: "delta" as const, value });
const pulse = (symbol: string, direction: -1 | 1) => ({ symbol, direction });

function news(
  minute: number,
  classification: EdenNews["classification"],
  headline: string,
  effects: EdenNews["effects"] = [],
  momentum: EdenNews["momentum"] = [],
): EdenNews {
  return {
    id: `${EDEN_DEMO_VERSION}/news/${minute}`,
    minute,
    classification,
    headline,
    effects,
    momentum,
    original: false,
  };
}

const DEMO_NEWS: readonly EdenNews[] = [
  news(
    2,
    "signal",
    "Practice wire: Aerium refinery throughput is running ahead of plan.",
    [delta("AERIUM", 30)],
    [pulse("AERIUM", 1)],
  ),
  news(
    6,
    "noise",
    "Practice wire: unconfirmed chatter of a dock delay on Aerium shipments.",
    [],
    [pulse("AERIUM", -1)],
  ),
  news(
    9,
    "signal",
    "Practice wire: Neuro-Chips clears a pilot order from a station contractor.",
    [delta("NEURO", 20)],
    [pulse("NEURO", 1)],
  ),
  news(
    13,
    "noise",
    "Practice wire: a rumor says Neuro-Chips will miss a delivery window.",
    [],
    [pulse("NEURO", -1)],
  ),
  news(
    16,
    "signal",
    "Practice wire: Orbital Station units are now exchangeable for the Aerium and Neuro basket.",
    [],
    [pulse("ORBITAL", 1)],
  ),
  news(
    26,
    "signal",
    "Practice wire: Aerium buyers return after a short maintenance window.",
    [delta("AERIUM", 20)],
    [pulse("AERIUM", 1)],
  ),
];

function buildDemoSchedule(): readonly EdenEventAction[] {
  const actions: EdenEventAction[] = [];
  const add = (id: string, atSecond: number, payload: EdenEventPayload) => {
    actions.push({ id: `${EDEN_DEMO_VERSION}/${id}`, atSecond, ...payload });
  };

  add("open", 0, { kind: "market_open" });
  add("bond/standard", 4 * 60, {
    kind: "bond_available",
    bond: DEMO_BONDS[0]!,
  });
  add("list/neuro", 8 * 60, {
    kind: "list_underlying",
    config: EDEN_EVENT_NEURO,
  });
  add("bond/aerium_pegged", 11 * 60, {
    kind: "bond_available",
    bond: DEMO_BONDS[1]!,
  });
  add("list/orbital", 15 * 60, { kind: "list_etf", config: EDEN_EVENT_ETF });
  for (const minute of [15, 22, 28]) {
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
  add("options/open", 18 * 60, {
    kind: "options_open",
    config: DEMO_OPTIONS,
  });

  const auctionMinute = 20;
  const auction = {
    roundId: `${EDEN_DEMO_VERSION}/auction/${auctionMinute}`,
    roundMinute: auctionMinute,
    closesAtSecond: auctionMinute * 60 + 30,
    premiumUntilSecond: EDEN_DEMO_DURATION_MINUTES * 60,
  };
  add(`auction/${auctionMinute}/open`, auctionMinute * 60, {
    kind: "auction_open",
    ...auction,
  });
  add(`auction/${auctionMinute}/resolve`, auction.closesAtSecond, {
    kind: "auction_resolve",
    ...auction,
  });

  const otcMinute = 24;
  add(`otc/${otcMinute}`, otcMinute * 60, {
    kind: "otc_offer",
    offer: {
      id: `${EDEN_DEMO_VERSION}/otc/${otcMinute}`,
      minute: otcMinute,
      title: "Deal Desk #1",
      legs: [
        {
          asset: "AERIUM",
          quantity: 5,
          basis: "fair_value",
          multiplier: 1,
        },
      ],
      original: false,
      tradingRequired: true,
      playerChoosesQuantity: false,
    },
    expiresAtSecond: otcMinute * 60 + EDEN_EVENT_DEFAULTS.otcReplySec,
  });

  for (const item of DEMO_NEWS) {
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

  add("end", EDEN_DEMO_DURATION_MINUTES * 60, { kind: "end" });
  return actions.sort((a, b) => a.atSecond - b.atSecond);
}

export const EDEN_DEMO_ACTIONS = /*#__PURE__*/ buildDemoSchedule();

const DEMO_LISTING: Readonly<Record<string, string>> = {
  AERIUM: "open",
  NEURO: "list-neuro",
  ORBITAL: "list-orbital",
};

function demoActionSymbols(action: EdenEventAction): string[] {
  if (action.kind === "news")
    return [
      ...action.news.effects.map((effect) => effect.symbol),
      ...action.news.momentum.map((effect) => effect.symbol),
    ];
  if (action.kind === "otc_offer")
    return action.offer.legs.map((leg) => leg.asset);
  if (action.kind === "list_etf")
    return action.config.basket.map((component) => component.symbol);
  if (action.kind === "etf_window") return [action.symbol];
  return [];
}

function buildDemoCues(): readonly EdenEventCue[] {
  const cues: Array<EdenEventCue & { order: number }> = [];
  const add = (
    id: string,
    label: string,
    minute: number,
    kind: EdenEventCue["kind"],
    actionIds: readonly string[],
    requires: readonly string[] = ["open"],
    order = minute,
  ) => {
    const wanted = new Set(actionIds.map((actionId) => `${EDEN_DEMO_VERSION}/${actionId}`));
    const actions = EDEN_DEMO_ACTIONS.filter((action) => wanted.has(action.id));
    if (actions.length !== wanted.size)
      throw new Error(`Demo cue ${id} references a missing action`);
    const needs = new Set(requires);
    for (const symbol of actions.flatMap(demoActionSymbols)) {
      const listing = DEMO_LISTING[symbol];
      if (listing && listing !== id) needs.add(listing);
    }
    cues.push({
      id,
      label,
      minute,
      kind,
      actions,
      requires: [...needs],
      order,
    });
  };
  const newsIds = (minute: number) => [
    `news/${minute}/premium`,
    `news/${minute}/public`,
  ];

  add("open", "Open market", 0, "market", ["open"], []);
  add("news-2", "Aerium throughput headline", 2, "news", newsIds(2));
  add("bond-standard", "List Standard Bond", 4, "market", ["bond/standard"]);
  add("news-6", "Aerium dock rumor", 6, "news", newsIds(6));
  add("list-neuro", "List NEURO", 8, "scene", ["list/neuro"]);
  add("news-9", "Neuro-Chips pilot headline", 9, "news", newsIds(9));
  add("bond-pegged", "List Aerium-Pegged Yield Bond", 11, "market", [
    "bond/aerium_pegged",
  ]);
  add("news-13", "Neuro delivery rumor", 13, "news", newsIds(13));
  add("list-orbital", "List ORBITAL ETF", 15, "scene", ["list/orbital"]);
  add(
    "etf-window-15",
    "Open ETF window",
    15,
    "market",
    ["etf/15/open", "etf/15/close"],
    ["open", "list-orbital"],
    15.2,
  );
  add("news-16", "Orbital exchange headline", 16, "news", newsIds(16));
  add("options", "Open Aerium options", 18, "scene", ["options/open"]);
  add("auction", "Premium feed auction", 20, "auction", [
    "auction/20/open",
    "auction/20/resolve",
  ]);
  add(
    "etf-window-22",
    "Open ETF window again",
    22,
    "market",
    ["etf/22/open", "etf/22/close"],
    ["open", "list-orbital"],
  );
  add("otc", "Deal Desk: 5 Aerium at fair value", 24, "otc", ["otc/24"]);
  add("news-26", "Aerium buyers return", 26, "news", newsIds(26));
  add(
    "etf-window-28",
    "Open the last ETF window",
    28,
    "market",
    ["etf/28/open", "etf/28/close"],
    ["open", "list-orbital"],
  );
  add("close", "Close event", 30, "market", ["end"], []);

  return cues
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...cue }) => cue);
}

/** Practice order. The admin fires each cue; nothing runs on the clock. */
export const EDEN_DEMO_CUES = /*#__PURE__*/ buildDemoCues();
