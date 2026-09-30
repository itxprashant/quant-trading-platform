import type {
  BondTemplate,
  EdenCueKind,
  EdenCueStatus,
  EdenOptionsConfig,
  EtfConfig,
  SymbolConfig,
} from "./schemas.js";
import {
  EDEN_EVENT_AUCTION_DURATION_SEC,
  EDEN_EVENT_AUCTION_MINUTES,
  EDEN_EVENT_AUCTION_OPEN_LEAD_SEC,
  EDEN_EVENT_BOND_MINUTES,
  EDEN_EVENT_DURATION_MINUTES,
  EDEN_EVENT_ETF_LIST_MINUTE,
  EDEN_EVENT_ETF_WINDOW_MINUTES,
  EDEN_EVENT_ETF_WINDOW_SEC,
  EDEN_EVENT_GRANT_AWARD_MINUTE,
  EDEN_EVENT_GRANT_OPEN_MINUTE,
  EDEN_EVENT_HALFTIME_END_MINUTE,
  EDEN_EVENT_HALFTIME_START_MINUTE,
  EDEN_EVENT_NEURO_LIST_MINUTE,
  EDEN_EVENT_OPTIONS_OPEN_MINUTE,
  EDEN_EVENT_PREMIUM_LEAD_SEC,
  EDEN_EVENT_SHOCK_MINUTE,
  EDEN_EVENT_SQUEEZE_MINUTE,
  EDEN_EVENT_VOTE_MINUTE,
  edenPlaybookToGameMinute,
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

const tm = edenPlaybookToGameMinute;

/** Playbook headlines; half-2 minutes are stored on the linear engine clock. */
export const EDEN_EVENT_NEWS: readonly EdenNews[] = [
  news(1, "noise", "Exchange publishes today’s trading calendar."),
  news(
    2,
    "signal",
    "Depot inventories are 3% below last week.",
    [delta("AERIUM", 15)],
    [pulse("AERIUM", 1)],
  ),
  news(3, "noise", "A mining podcast releases a new episode."),
  news(
    4,
    "signal",
    "Two ore carriers arrive a day early.",
    [delta("AERIUM", -10)],
    [pulse("AERIUM", -1)],
  ),
  news(
    6,
    "signal",
    "Sector 4 reports an equipment failure at one refinery.",
    [delta("AERIUM", 20)],
    [pulse("AERIUM", 1)],
  ),
  news(7, "noise", "The mining authority reappoints its safety commissioner."),
  news(
    8,
    "signal",
    "Refinery strike in Sector 4 cuts output by 12%.",
    [delta("AERIUM", 50)],
    [pulse("AERIUM", 1)],
  ),
  news(9, "noise", "A trade magazine reprints last month’s output figures."),
  news(
    10,
    "signal",
    "The strike spreads to a second refinery.",
    [delta("AERIUM", 40)],
    [pulse("AERIUM", 1)],
  ),
  news(11, "noise", "The union posts a photo of the picket line."),
  news(
    12,
    "signal",
    "Arbitration on the refinery strike is due at TM 22. The exchange puts the chance of an early settlement at 50%. Early settlement: Aerium −70. Strike continues: Aerium +30.",
    [delta("AERIUM", -20)],
    [pulse("AERIUM", -1)],
  ),
  news(14, "noise", "A business channel runs a segment on mining history."),
  news(
    15,
    "signal",
    "Haulage fuel costs rise 4%.",
    [delta("AERIUM", 15)],
    [pulse("AERIUM", 1)],
  ),
  news(
    17,
    "signal",
    "The government confirms a 5,000-ton stockpile release.",
    [delta("AERIUM", -45)],
    [pulse("AERIUM", -1)],
  ),
  news(18, "noise", "A poll finds 62% of citizens have never heard of Aerium."),
  news(
    19,
    "signal",
    "Two smelters restart after maintenance.",
    [delta("AERIUM", -25)],
    [pulse("AERIUM", -1)],
  ),
  news(21, "noise", "The Miners’ Guild announces its charity gala."),
  news(
    22,
    "signal",
    "Arbitration ruling: the strike is settled early.",
    [delta("AERIUM", -50)],
    [pulse("AERIUM", -1)],
  ),
  news(23, "noise", "An opinion piece argues Aerium is overvalued."),
  news(
    25,
    "signal",
    "An ore processing tax proposal gains support in committee.",
    [delta("AERIUM", -30)],
    [pulse("AERIUM", -1)],
  ),
  news(26, "noise", "A logistics firm rebrands its ore transport fleet."),
  news(
    27,
    "signal",
    "Exports to the outer colonies rise 6%.",
    [delta("AERIUM", 35)],
    [pulse("AERIUM", 1)],
  ),
  news(
    29,
    "signal",
    "A large buyer cancels a standing order.",
    [delta("AERIUM", -40)],
    [pulse("AERIUM", -1)],
  ),
  news(30, "noise", "Influencer ‘Nova’ endorses Aerium on the holonet."),
  news(
    31,
    "signal",
    "Depot stocks fall to a three-month low.",
    [delta("AERIUM", 45)],
    [pulse("AERIUM", 1)],
  ),
  news(32, "noise", "The exchange reports record message traffic."),
  news(
    33,
    "signal",
    "The extraction tax goes to a vote 8 minutes later. If it passes, processing costs rise 8%.",
    [delta("AERIUM", -35)],
    [pulse("AERIUM", -1)],
  ),
  news(34, "noise", "A documentary crew films at the main depot."),
  news(
    36,
    "signal",
    "Neuro-Chips approved for civilian use.",
    [],
    [pulse("NEURO", 1)],
    false,
  ),
  news(
    37,
    "signal",
    "Chip makers confirm Aerium demand for substrates.",
    [delta("AERIUM", 30)],
    [pulse("AERIUM", 1)],
  ),
  news(38, "noise", "A forum thread speculates about military uses for chips."),
  news(
    39,
    "signal",
    "The chip plant announces a second production line.",
    [delta("NEURO", -40)],
    [pulse("NEURO", -1)],
  ),
  news(
    40,
    "signal",
    "A chip buyer defers orders by a month.",
    [delta("NEURO", -25)],
    [pulse("NEURO", -1)],
  ),
  news(
    41,
    "signal",
    "The extraction tax passes.",
    [delta("AERIUM", -25)],
    [pulse("AERIUM", -1)],
  ),
  news(
    42,
    "signal",
    "Smugglers are caught with 50,000 tons of counterfeit Aerium.",
    [delta("AERIUM", 80)],
    [pulse("AERIUM", 1)],
  ),
  news(44, "noise", "A trade journal profiles the chip company’s CEO."),
  news(
    46,
    "signal",
    "Chip exports are approved to two more systems.",
    [delta("NEURO", 60)],
    [pulse("NEURO", 1)],
  ),
  news(47, "noise", "An analyst repeats existing guidance on chips."),
  news(
    48,
    "noise",
    "Unverified rumour: the chip CEO was seen at a rival’s offices.",
  ),
  news(
    49,
    "signal",
    "Cobalt prices rise 5%.",
    [delta("NEURO", 30)],
    [pulse("NEURO", 1)],
  ),
  news(
    51,
    "signal",
    "A shipping lane closure delays chip deliveries.",
    [delta("NEURO", 35)],
    [pulse("NEURO", 1)],
  ),
  news(52, "noise", "The cobalt suppliers’ association announces a conference venue."),
  news(
    53,
    "signal",
    "Refiners raise their purchase prices for raw Aerium.",
    [delta("AERIUM", 25)],
    [pulse("AERIUM", 1)],
  ),
  news(
    54,
    "signal",
    "A cobalt shortage halts chip assembly lines.",
    [delta("NEURO", 100)],
    [pulse("NEURO", 1)],
  ),
  news(55, "noise", "A podcast interviews a retired mining executive."),
  news(
    56,
    "signal",
    "A small fire is reported at a chip plant; no injuries.",
    [delta("NEURO", 20)],
    [pulse("NEURO", 1)],
  ),
  news(
    57,
    "signal",
    "The chip regulator rules on exports at TM 64. The exchange puts the chance of a ban at 30%. Ban: Neuro-Chips −150. Cleared: +50.",
    [delta("NEURO", -10)],
    [pulse("NEURO", -1)],
  ),
  news(
    59,
    "signal",
    "A haulage contract is renewed at a lower rate.",
    [delta("AERIUM", -20)],
    [pulse("AERIUM", -1)],
  ),
  news(
    60,
    "signal",
    "Orbital-Station ETF opens for trading: 1 ETF = 2 AERIUM + 1 NEURO-CHIP.",
    [],
    [pulse("ORBITAL", 1)],
    false,
  ),
  news(61, "noise", "The ETF sponsor publishes its methodology document."),
  news(
    62,
    "signal",
    "Chip inventories build up at distributors.",
    [delta("NEURO", -30)],
    [pulse("NEURO", -1)],
  ),
  news(
    63,
    "signal",
    "A new Aerium field is confirmed in Sector 7.",
    [delta("AERIUM", -55)],
    [pulse("AERIUM", -1)],
  ),
  news(
    64,
    "signal",
    "The regulator clears chip exports.",
    [delta("NEURO", 60)],
    [pulse("NEURO", 1)],
  ),
  news(
    66,
    "signal",
    "Orbital Station announces a fleet expansion.",
    [delta("AERIUM", 30)],
    [pulse("AERIUM", 1), pulse("ORBITAL", 1)],
  ),
  news(
    68,
    "signal",
    "Chip yields improve at the main plant.",
    [delta("NEURO", -35)],
    [pulse("NEURO", -1)],
  ),
  news(69, "noise", "Two ETF trades are reported late to the tape."),
  news(
    71,
    "signal",
    "Construction demand for Aerium falls.",
    [delta("AERIUM", -40)],
    [pulse("AERIUM", -1)],
  ),
  news(72, "noise", "The Orbital Station earnings call is delayed by an hour."),
  news(
    73,
    "signal",
    "A competitor launches a cheaper chip.",
    [delta("NEURO", -60)],
    [pulse("NEURO", -1)],
  ),
  news(74, "noise", "A brokerage reports a surge in new accounts."),
  news(
    75,
    "signal",
    "A fuel-cell retrofit programme lifts Aerium demand.",
    [delta("AERIUM", 40)],
    [pulse("AERIUM", 1)],
  ),
  news(
    76,
    "signal",
    "A fire destroys stored Aerium at a depot.",
    [delta("AERIUM", 60)],
    [pulse("AERIUM", 1)],
  ),
  news(79, "noise", "Influencer ‘Nova’ now says chips are overhyped."),
  news(
    80,
    "signal",
    "The chip plant resumes full production.",
    [delta("NEURO", -40)],
    [pulse("NEURO", -1)],
  ),
  news(
    81,
    "signal",
    "A power rationing decision affecting both industries is due at TM 88.",
    [delta("AERIUM", 20), delta("NEURO", 30)],
    [pulse("AERIUM", 1), pulse("NEURO", 1)],
  ),
  news(83, "noise", "A rumour circulates that a refiner has hired advisers."),
  news(
    84,
    "signal",
    "The logistics strike ends and supply normalises.",
    [delta("AERIUM", -30)],
    [pulse("AERIUM", -1)],
  ),
  news(
    85,
    "signal",
    "Medical device demand for chips rises.",
    [delta("NEURO", 45)],
    [pulse("NEURO", 1)],
  ),
  news(86, "noise", "The colonial archive digitises fifty years of mining records."),
  news(
    88,
    "signal",
    "Power rationing is imposed on heavy industry.",
    [delta("AERIUM", 30), delta("NEURO", 40)],
    [pulse("AERIUM", 1), pulse("NEURO", 1)],
  ),
  news(89, "noise", "The exchange reminds members that the half ends at TM 90."),
  news(
    90,
    "noise",
    "Trading halted for halftime. Positions do not reset.",
    [],
    [],
    false,
  ),
  news(
    tm(91),
    "signal",
    "Aerium and Neuro-Chip calls and puts open for trading. Five-minute cycles with a 15-second exercise window.",
    [],
    [],
    false,
  ),
  news(tm(94), "noise", "A weekend supplement profiles the exchange’s history."),
  news(
    tm(95),
    "signal",
    "Aerium stockpiles at the port fall again.",
    [delta("AERIUM", 30)],
    [pulse("AERIUM", 1)],
  ),
  news(
    tm(97),
    "signal",
    "A chip distributor reports weak reorders.",
    [delta("NEURO", -25)],
    [pulse("NEURO", -1)],
  ),
  news(tm(98), "noise", "A broker note recaps the first half’s price action."),
  news(
    tm(100),
    "signal",
    "A process upgrade lifts refinery output.",
    [delta("AERIUM", -40)],
    [pulse("AERIUM", -1)],
  ),
  news(
    tm(102),
    "signal",
    "A rival chip plant halts production for maintenance.",
    [delta("NEURO", 35)],
    [pulse("NEURO", 1)],
  ),
  news(tm(104), "noise", "A retail brokerage reports record new accounts."),
  news(
    tm(105),
    "signal",
    "A salvage operator recovers 2,000 tons of Aerium.",
    [delta("AERIUM", -35)],
    [pulse("AERIUM", -1)],
  ),
  news(
    tm(108),
    "signal",
    "A defect is found in a chip batch; customers cancel orders.",
    [delta("NEURO", -80)],
    [pulse("NEURO", -1)],
  ),
  news(tm(109), "noise", "Orbital Station announces a routine crew rotation."),
  news(
    tm(110),
    "signal",
    "Two refineries cut output for scheduled maintenance.",
    [delta("AERIUM", 25)],
    [pulse("AERIUM", 1)],
  ),
  news(
    tm(112),
    "signal",
    "The grid expansion contract is decided at TM 120. The exchange puts Aerium’s chance of winning it at 45%. Won: +90. Lost: −40.",
    [delta("AERIUM", 20)],
    [pulse("AERIUM", 1)],
  ),
  news(tm(115), "noise", "The regulator publishes its quarterly conduct bulletin."),
  news(
    tm(118),
    "signal",
    "Chip demand from the transport sector rises.",
    [delta("NEURO", 40)],
    [pulse("NEURO", 1)],
  ),
  news(tm(119), "noise", "A documentary about the colony’s founding airs tonight."),
  news(
    tm(120),
    "signal",
    "Aerium wins the grid expansion contract.",
    [delta("AERIUM", 70)],
    [pulse("AERIUM", 1)],
  ),
  news(
    tm(122),
    "noise",
    "An energy blog claims a breakthrough is imminent and gives no detail.",
  ),
  news(
    tm(124),
    "noise",
    "The Solidarity Tax: a 15% tax on the free cash of the top 10% for the bottom 20% is put to a vote.",
    [],
    [],
    false,
  ),
  news(
    tm(125),
    "signal",
    "A mining cooperative announces new capacity.",
    [delta("AERIUM", -30)],
    [pulse("AERIUM", -1)],
  ),
  news(
    tm(128),
    "signal",
    "A chip plant wins a government supply contract.",
    [delta("NEURO", 30)],
    [pulse("NEURO", 1)],
  ),
  news(tm(130), "noise", "An analyst note repeats existing guidance on chips."),
  news(
    tm(132),
    "signal",
    "A solar storm warning is in effect. The observatory rules at TM 140. 50% chance of a direct hit. Hit: Neuro-Chips −60. Miss: +20.",
    [delta("NEURO", -20)],
    [pulse("NEURO", -1)],
  ),
  news(tm(134), "noise", "Floor chatter: something is happening at the zero-point lab."),
  news(
    tm(135),
    "signal",
    "A depot outage takes Aerium off the market.",
    [delta("AERIUM", 45)],
    [pulse("AERIUM", 1)],
  ),
  news(
    tm(137),
    "signal",
    "Zero-point energy prototype succeeds. Aerium is obsolete.",
    [delta("AERIUM", -300), delta("NEURO", 200)],
    [pulse("AERIUM", -1), pulse("NEURO", 1)],
  ),
  news(tm(138), "noise", "Newsfeeds replay the zero-point announcement."),
  news(
    tm(140),
    "signal",
    "The solar storm misses the colony.",
    [delta("NEURO", 40)],
    [pulse("NEURO", 1)],
  ),
  news(tm(142), "noise", "The zero-point consortium schedules a press conference."),
  news(
    tm(145),
    "signal",
    "Salvaged Aerium floods the market.",
    [delta("AERIUM", -40)],
    [pulse("AERIUM", -1)],
  ),
  news(
    tm(147),
    "noise",
    "Strategic Reserves Critical. In exactly 10 minutes, the highest Aerium inventory wins a $10,000 Government Grant. Tied leaders split the prize equally.",
    [],
    [pulse("AERIUM", 1)],
    false,
  ),
  news(
    tm(148),
    "signal",
    "Chip makers report record orders for reactor controls.",
    [delta("NEURO", 50)],
    [pulse("NEURO", 1)],
  ),
  news(tm(149), "noise", "A journal previews next-generation control systems."),
  news(
    tm(150),
    "signal",
    "A buyer takes delivery of 10,000 tons of Aerium.",
    [delta("AERIUM", 35)],
    [pulse("AERIUM", 1)],
  ),
  news(tm(154), "noise", "The CEO of Orbital Station tweets a rocket emoji."),
  news(
    tm(155),
    "signal",
    "A component shortage is reported at a chip supplier.",
    [delta("NEURO", 45)],
    [pulse("NEURO", 1)],
  ),
  news(
    tm(157),
    "noise",
    "Government Grant awarded. The Aerium inventory race is over.",
    [],
    [pulse("AERIUM", -1)],
    false,
  ),
  news(
    tm(158),
    "signal",
    "The government cancels its Aerium reserve programme.",
    [delta("AERIUM", -60)],
    [pulse("AERIUM", -1)],
  ),
  news(
    tm(160),
    "signal",
    "A chip customer switches to a rival supplier.",
    [delta("NEURO", -40)],
    [pulse("NEURO", -1)],
  ),
  news(tm(162), "noise", "A takeover rumour circulates around Orbital Station."),
  news(
    tm(164),
    "signal",
    "A solar flare scrambles chip logic gates globally.",
    [delta("NEURO", -150)],
    [pulse("NEURO", -1)],
  ),
  news(
    tm(165),
    "signal",
    "An Aerium recycling plant closes.",
    [delta("AERIUM", 30)],
    [pulse("AERIUM", 1)],
  ),
  news(
    tm(168),
    "noise",
    "Leaderboard 3 published (ranks only).",
    [],
    [],
    false,
  ),
  news(tm(169), "noise", "The exchange confirms closing procedures for TM 180."),
  news(
    tm(170),
    "signal",
    "Chip prices rise at distributors.",
    [delta("NEURO", 35)],
    [pulse("NEURO", 1)],
  ),
  news(
    tm(172),
    "noise",
    "The Final Squeeze: bot volatility parameters are tripled.",
    [],
    [],
    false,
  ),
  news(
    tm(175),
    "signal",
    "A salvage yard releases reclaimed Aerium.",
    [delta("AERIUM", -25)],
    [pulse("AERIUM", -1)],
  ),
  news(
    tm(177),
    "signal",
    "A cyberattack disables 40% of the Aerium grid.",
    [delta("AERIUM", 120)],
    [pulse("AERIUM", 1)],
  ),
  news(tm(178), "noise", "Wire service reports unusual option activity."),
  news(
    tm(179),
    "signal",
    "A chip plant reports a power outage.",
    [delta("NEURO", 30)],
    [pulse("NEURO", 1)],
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
  basis: "fair_value" | "nav" | "intrinsic" | "zero" | "fixed";
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

function otc(
  playbookMinute: number,
  deskNumber: number,
  legs: EdenOtcLeg[],
  playerChoosesQuantity = false,
): EdenOtcOffer {
  const minute = tm(playbookMinute);
  return {
    id: `${EDEN_EVENT_VERSION}/otc/${minute}`,
    minute,
    title: `Deal Desk #${deskNumber}`,
    legs,
    original: true,
    tradingRequired: true,
    playerChoosesQuantity,
  };
}

const leg = (
  asset: EdenOtcAsset,
  quantity: number,
  basis: EdenOtcLeg["basis"],
  multiplier: number,
): EdenOtcLeg => ({ asset, quantity, basis, multiplier });

export const EDEN_EVENT_OTC: readonly EdenOtcOffer[] = [
  otc(5, 1, [leg("AERIUM", 30, "fair_value", 0.97)]),
  otc(20, 2, [leg("AERIUM", 50, "fair_value", 0.95)]),
  otc(35, 3, [leg("AERIUM", -25, "fair_value", 1.03)]),
  otc(50, 4, [
    leg("AERIUM", -20, "fair_value", 1),
    leg("NEURO", 40, "fair_value", 1),
  ]),
  otc(65, 5, [leg("ORBITAL", 10, "nav", 1.02)]),
  otc(78, 6, [leg("AERIUM", -40, "fair_value", 0.96)]),
  otc(92, 7, [leg("AERIUM_ATM_CALL", -15, "fixed", 45)]),
  otc(107, 8, [leg("NEURO", 25, "fair_value", 0.98)]),
  otc(117, 9, [
    leg("AERIUM", 20, "fair_value", 1),
    leg("NEURO", -36, "fair_value", 1),
  ]),
  otc(127, 10, [leg("NEURO", -40, "fair_value", 1.01)]),
  otc(139, 11, [leg("AERIUM", 30, "fair_value", 1.2)]),
  otc(152, 12, [leg("PLAYER_CHOICE", -50, "fair_value", 0.9)], true),
  otc(167, 13, [leg("ORBITAL", 8, "nav", 0.95)]),
];

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
    add(`bond/${bond.id}`, EDEN_EVENT_BOND_MINUTES[i]! * 60, {
      kind: "bond_available",
      bond,
    }),
  );
  add("list/neuro", EDEN_EVENT_NEURO_LIST_MINUTE * 60, {
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

  for (const [index, minute] of EDEN_EVENT_AUCTION_MINUTES.entries()) {
    const next = EDEN_EVENT_AUCTION_MINUTES[index + 1];
    const closesAtSecond = minute * 60 + EDEN_EVENT_AUCTION_DURATION_SEC;
    const round = {
      roundId: `${EDEN_EVENT_VERSION}/auction/${minute}`,
      roundMinute: minute,
      closesAtSecond,
      premiumUntilSecond:
        next != null ? next * 60 : EDEN_EVENT_DURATION_MINUTES * 60,
    };
    add(
      `auction/${minute}/open`,
      minute * 60 - EDEN_EVENT_AUCTION_OPEN_LEAD_SEC,
      { kind: "auction_open", ...round },
    );
    add(`auction/${minute}/resolve`, round.closesAtSecond, {
      kind: "auction_resolve",
      ...round,
    });
  }

  const vote = {
    voteId: `${EDEN_EVENT_VERSION}/vote/solidarity`,
    title: "The Solidarity Tax",
    closesAtSecond:
      EDEN_EVENT_VOTE_MINUTE * 60 + EDEN_EVENT_DEFAULTS.voteDurationSec,
    ranking: "cash" as const,
    taxRate: EDEN_EVENT_DEFAULTS.taxRate,
    topFraction: EDEN_EVENT_DEFAULTS.taxTopFraction,
    bottomFraction: EDEN_EVENT_DEFAULTS.taxBottomFraction,
  };
  add("vote/open", EDEN_EVENT_VOTE_MINUTE * 60, { kind: "vote_open", ...vote });
  add("vote/resolve", vote.closesAtSecond, { kind: "vote_resolve", ...vote });
  const grant = {
    grantId: `${EDEN_EVENT_VERSION}/grant/aerium`,
    symbol: "AERIUM",
    prize: 10000,
    awardsAtSecond: EDEN_EVENT_GRANT_AWARD_MINUTE * 60,
  };
  add("grant/open", EDEN_EVENT_GRANT_OPEN_MINUTE * 60, {
    kind: "grant_open",
    ...grant,
  });
  add("grant/award", grant.awardsAtSecond, { kind: "grant_award", ...grant });
  const vega = {
    newsId: `${EDEN_EVENT_VERSION}/news/${EDEN_EVENT_SHOCK_MINUTE}`,
    symbol: "AERIUM",
  };
  add("vega/prepare", (EDEN_EVENT_SHOCK_MINUTE - 1) * 60, {
    kind: "vega_prepare",
    ...vega,
  });
  add("volatility/triple", EDEN_EVENT_SQUEEZE_MINUTE * 60, {
    kind: "bot_volatility",
    multiplier: 3,
  });

  for (const item of EDEN_EVENT_NEWS) {
    add(
      `news/${item.minute}/premium`,
      item.minute * 60 - EDEN_EVENT_PREMIUM_LEAD_SEC,
      {
        kind: "news",
        audience: "premium",
        news: item,
      },
    );
    add(`news/${item.minute}/public`, item.minute * 60, {
      kind: "news",
      audience: "public",
      news: item,
    });
  }
  add("vega/resolve", EDEN_EVENT_SHOCK_MINUTE * 60, {
    kind: "vega_resolve",
    ...vega,
  });
  for (const offer of EDEN_EVENT_OTC) {
    add(`otc/${offer.minute}`, offer.minute * 60, {
      kind: "otc_offer",
      offer,
      expiresAtSecond: offer.minute * 60 + EDEN_EVENT_DEFAULTS.otcReplySec,
    });
  }
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
 * its actions with their scripted offsets from the first one. ETF windows have
 * no cue; listing starts the first window and later windows cycle.
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
export const edenCueReceiptId = (
  cueId: string,
  version = EDEN_EVENT_VERSION,
): string => `${version}/cue/${cueId}`;

/** `eden-v1` or `eden-demo-v1`, taken from the cue's first action id. */
export function edenCueVersion(cue: EdenEventCue): string {
  return cue.actions[0]?.id.split("/")[0] ?? EDEN_EVENT_VERSION;
}

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
  add(
    "list-neuro",
    "List NEURO",
    EDEN_EVENT_NEURO_LIST_MINUTE,
    "scene",
    ["list/neuro", ...newsIds(EDEN_EVENT_NEURO_LIST_MINUTE)],
  );
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
    [
      "unfreeze",
      "options/open",
      ...newsIds(EDEN_EVENT_OPTIONS_OPEN_MINUTE),
    ],
    ["open", "halftime"],
  );
  add("vote", "Solidarity Tax vote", EDEN_EVENT_VOTE_MINUTE, "scene", [
    "vote/open",
    "vote/resolve",
    ...newsIds(EDEN_EVENT_VOTE_MINUTE),
  ]);
  add(
    "shock",
    "Dis-correlation shock",
    EDEN_EVENT_SHOCK_MINUTE,
    "scene",
    ["vega/prepare", "vega/resolve", ...newsIds(EDEN_EVENT_SHOCK_MINUTE)],
    ["open", "reopen"],
  );
  add("grant", "Government grant", EDEN_EVENT_GRANT_OPEN_MINUTE, "scene", [
    "grant/open",
    "grant/award",
    ...newsIds(EDEN_EVENT_GRANT_OPEN_MINUTE),
    ...newsIds(EDEN_EVENT_GRANT_AWARD_MINUTE),
  ]);
  add("squeeze", "Final squeeze", EDEN_EVENT_SQUEEZE_MINUTE, "scene", [
    "volatility/triple",
    ...newsIds(EDEN_EVENT_SQUEEZE_MINUTE),
  ]);
  add("close", "Close event", EDEN_EVENT_DURATION_MINUTES, "market", ["end"], []);

  const inScene = new Set([
    EDEN_EVENT_NEURO_LIST_MINUTE,
    EDEN_EVENT_ETF_LIST_MINUTE,
    EDEN_EVENT_HALFTIME_START_MINUTE,
    EDEN_EVENT_OPTIONS_OPEN_MINUTE,
    EDEN_EVENT_VOTE_MINUTE,
    EDEN_EVENT_SHOCK_MINUTE,
    EDEN_EVENT_GRANT_OPEN_MINUTE,
    EDEN_EVENT_GRANT_AWARD_MINUTE,
    EDEN_EVENT_SQUEEZE_MINUTE,
  ]);
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
  return cues
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...cue }) => cue);
}

/** Playbook order; "Run next" fires the first cue that has not fired. */
export const EDEN_EVENT_CUES = /*#__PURE__*/ buildCues();

export function edenEventCue(
  cueId: string,
  cues: readonly EdenEventCue[] = EDEN_EVENT_CUES,
): EdenEventCue | undefined {
  return cues.find((cue) => cue.id === cueId);
}

/** `receipts` holds event_actions ids: cue fire receipts and action receipts. */
export function edenCueStatus(
  cue: EdenEventCue,
  receipts: ReadonlySet<string>,
  cues: readonly EdenEventCue[] = EDEN_EVENT_CUES,
): EdenCueStatus {
  if (receipts.has(edenCueReceiptId(cue.id, edenCueVersion(cue))))
    return cue.actions.every((a) => receipts.has(a.id)) ? "done" : "running";
  return edenCueBlockers(cue, receipts, cues).length > 0 ? "blocked" : "ready";
}

/** Required cue ids that are not done yet. */
export function edenCueBlockers(
  cue: EdenEventCue,
  receipts: ReadonlySet<string>,
  cues: readonly EdenEventCue[] = EDEN_EVENT_CUES,
): string[] {
  return cue.requires.filter((id) => {
    const required = edenEventCue(id, cues);
    return !required || edenCueStatus(required, receipts, cues) !== "done";
  });
}
