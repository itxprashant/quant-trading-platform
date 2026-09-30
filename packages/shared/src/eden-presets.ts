import { EDEN_EVENT_DURATION_MINUTES } from "./eden-clock.js";
import type {
  BondTemplate,
  ChallengeConfig,
  EdenBotConfig,
  EdenConfig,
  EdenOptionsConfig,
  EtfConfig,
  SymbolConfig,
} from "./schemas.js";

/**
 * Instrument and bot presets for the scripted New Eden event. The admin form
 * imports these in the browser, so keep headlines out of this module.
 */
export const EDEN_EVENT_AERIUM: SymbolConfig = {
  symbol: "AERIUM",
  name: "Aerium",
  initialPrice: 1000,
  volatility: 0,
  tickSize: 0.5,
};
export const EDEN_EVENT_NEURO: SymbolConfig = {
  symbol: "NEURO",
  name: "Neuro-Chips",
  initialPrice: 500,
  volatility: 0,
  tickSize: 0.5,
};
export const EDEN_EVENT_ETF: EtfConfig = {
  symbol: "ORBITAL",
  name: "Orbital-Station ETF",
  basket: [
    { symbol: "AERIUM", weight: 2 },
    { symbol: "NEURO", weight: 1 },
  ],
};
export const EDEN_EVENT_BONDS: BondTemplate[] = [
  {
    id: "standard",
    name: "Standard Bond",
    price: 10000,
    faceValue: 10000,
    payoutMultiplier: 2,
    maxPerUser: 1,
  },
  {
    id: "aerium_pegged",
    name: "Aerium-Pegged Yield Bond",
    price: 10000,
    faceValue: 10000,
    payoutMultiplier: 2,
    maxPerUser: 1,
  },
];
export const EDEN_EVENT_OPTIONS: EdenOptionsConfig = {
  enabled: false,
  underlyings: ["AERIUM", "NEURO"],
  cycleMinutes: 5,
  exerciseWindowSec: 15,
  autoCycle: true,
  strikeSteps: 1,
};
/** Scripted / cue playbook starting cash (`eden_v2.md` deal sizes). */
export const EDEN_EVENT_STARTING_CASH = 100_000;
export const EDEN_EVENT_BOTS: EdenBotConfig = {
  hftMarketMakers: 0,
  momentumTraders: 0,
  vegaSnipers: 0,
  parityArbers: 0,
  spread: 1,
  quoteSize: 10,
  intensity: 0.5,
};
export type EdenEventFlow = "host" | "cues" | "scripted" | "demo";

/** Scripted wins so a stray flag can never run two drivers. */
export function edenEventFlow(
  eden:
    | {
        eventScript?: boolean;
        playbookCues?: boolean;
        demoScript?: boolean;
      }
    | undefined,
): EdenEventFlow {
  if (eden?.eventScript) return "scripted";
  if (eden?.demoScript) return "demo";
  if (eden?.playbookCues) return "cues";
  return "host";
}

/** Wall-clock length of the practice timeline when a game minute is one minute. */
export const EDEN_DEMO_DURATION_MINUTES = 30;

/** Game minutes a playbook event runs once its market opens; null when the host runs it. */
export function edenEventDurationMinutes(flow: EdenEventFlow): number | null {
  if (flow === "scripted" || flow === "cues") return EDEN_EVENT_DURATION_MINUTES;
  if (flow === "demo") return EDEN_DEMO_DURATION_MINUTES;
  return null;
}

/**
 * Epoch ms a playbook event ends: its duration after the market opens. A
 * scripted event opens at `startsAt`; a cue sheet opens when `open` fires.
 */
export function edenEventEndsAt(
  flow: EdenEventFlow,
  startsAt: number,
  openedAt: number | null,
  minuteMs: number,
): number | null {
  const minutes = edenEventDurationMinutes(flow);
  const opened = flow === "scripted" ? startsAt : openedAt;
  return minutes == null || opened == null ? null : opened + minutes * minuteMs;
}

/** Enough resting quotes and headline flow for a practice book. */
export const EDEN_DEMO_BOTS: EdenBotConfig = {
  hftMarketMakers: 2,
  momentumTraders: 1,
  vegaSnipers: 0,
  parityArbers: 0,
  spread: 1,
  quoteSize: 10,
  intensity: 0.6,
};

export const EDEN_EVENT_DEFAULTS = {
  auctionDurationSec: 30,
  auctionWinnerFraction: 0.3,
  premiumLeadSec: 10,
  premiumAccessMinutes: 15,
  otcReplySec: 40,
  otcBargainDelaySec: 5,
  etfWindowSec: 30,
  voteDurationSec: 90,
  taxRate: 0.15,
  taxTopFraction: 0.1,
  taxBottomFraction: 0.2,
  grantPrize: 10000,
  assignmentGraceSec: 30,
  borderPenaltyFraction: 0.2,
} as const;

/** Seeded New Eden Exchange slug (`slugify("New Eden Exchange")`). */
export const NEW_EDEN_EXCHANGE_SLUG = "new-eden-exchange";
/** Seeded practice event slug (`slugify("QuantStorm Practice")`). */
export const QUANTSTORM_PRACTICE_SLUG = "quantstorm-practice";

/** Order-ticket qty buttons on the main New Eden Exchange event. */
export const EDEN_EXCHANGE_ORDER_QTY_PRESETS: [
  number,
  number,
  number,
  number,
] = [5, 10, 25, 50];

/** Live tournament bot mix (admin New Eden economy panel). */
export const EDEN_EXCHANGE_BOTS: EdenBotConfig = {
  hftMarketMakers: 1,
  momentumTraders: 1,
  vegaSnipers: 1,
  parityArbers: 1,
  spread: 1,
  quoteSize: 10,
  intensity: 0.2,
};

const edenExchangeTimedSettings = () => ({
  auctionDurationSec: EDEN_EVENT_DEFAULTS.auctionDurationSec,
  auctionWinnerFraction: EDEN_EVENT_DEFAULTS.auctionWinnerFraction,
  premiumLeadSec: EDEN_EVENT_DEFAULTS.premiumLeadSec,
  premiumAccessMinutes: EDEN_EVENT_DEFAULTS.premiumAccessMinutes,
  otcReplySec: EDEN_EVENT_DEFAULTS.otcReplySec,
});

/** Options template for the main exchange (AERIUM-only until Neuro lists). */
export function edenExchangeOptionsTemplate(): EdenOptionsConfig {
  return {
    ...EDEN_EVENT_OPTIONS,
    enabled: false,
    underlyings: ["AERIUM"],
  };
}

/** Economy block shared by host desk and playbook flows on the main exchange. */
export function edenExchangeEconomyEdenConfig(): EdenConfig {
  return {
    rules: {
      enabled: true,
      costOfCarryPerUnitPerMinute: 1,
      loanRepayMultiplier: 1.5,
      marginCallThreshold: 0,
      forcedLiquidation: true,
      positionCap: 100,
    },
    bots: { ...EDEN_EXCHANGE_BOTS },
    options: edenExchangeOptionsTemplate(),
    bonds: [],
    etfs: [],
    ...edenExchangeTimedSettings(),
  };
}

export function newEdenExchangeEdenConfig(
  flow: "scripted" | "cues",
): EdenConfig & {
  eventScript?: boolean;
  playbookCues?: boolean;
  demoScript?: boolean;
} {
  return {
    ...edenExchangeEconomyEdenConfig(),
    eventScript: flow === "scripted",
    playbookCues: flow === "cues",
    demoScript: false,
  };
}

/** Full challenge config for the main New Eden Exchange (scripted or cue sheet). */
export function newEdenExchangeChallengeConfig(
  flow: "scripted" | "cues" = "cues",
): ChallengeConfig {
  return {
    symbols: [{ ...EDEN_EVENT_AERIUM }],
    startingCash: EDEN_EVENT_STARTING_CASH,
    minPosition: -100,
    maxPosition: 100,
    maxOrderQuantity: 50,
    maxOpenOrders: 25,
    maxOrdersPerSecond: 8,
    maxVolumePerMinute: 1000,
    allowMargin: true,
    autonomousPrice: true,
    orderQtyPresets: [...EDEN_EXCHANGE_ORDER_QTY_PRESETS],
    eden: newEdenExchangeEdenConfig(flow),
  };
}

/** Seeded QuantStorm Practice (demo cue sheet) config. */
export function newEdenDemoChallengeConfig(): ChallengeConfig {
  return {
    symbols: [{ ...EDEN_EVENT_AERIUM }],
    startingCash: 10_000,
    minPosition: -100,
    maxPosition: 100,
    maxOrderQuantity: 50,
    maxOpenOrders: 25,
    maxOrdersPerSecond: 8,
    maxVolumePerMinute: 1000,
    allowMargin: true,
    autonomousPrice: true,
    eden: {
      demoScript: true,
      eventScript: false,
      playbookCues: false,
      rules: {
        enabled: true,
        costOfCarryPerUnitPerMinute: 1,
        loanRepayMultiplier: 2,
        marginCallThreshold: 0,
        forcedLiquidation: true,
        positionCap: 100,
      },
      bots: { ...EDEN_DEMO_BOTS },
      options: { ...EDEN_EVENT_OPTIONS, enabled: false, cycleMinutes: 4 },
      bonds: [],
      etfs: [],
      ...edenExchangeTimedSettings(),
    },
  };
}

/**
 * Reset preset for New Eden challenges. Playbook flows restore the full admin
 * panel defaults; host mode keeps custom instruments and templates.
 */
export function restoreNewEdenChallengeConfig(
  current: ChallengeConfig,
  slug?: string | null,
): ChallengeConfig {
  if (slug === NEW_EDEN_EXCHANGE_SLUG) {
    return newEdenExchangeChallengeConfig("cues");
  }
  if (slug === QUANTSTORM_PRACTICE_SLUG) {
    return newEdenDemoChallengeConfig();
  }
  const flow = edenEventFlow(current.eden);
  if (flow === "scripted") return newEdenExchangeChallengeConfig("scripted");
  if (flow === "cues") return newEdenExchangeChallengeConfig("cues");
  if (flow === "demo") return newEdenDemoChallengeConfig();
  if (flow !== "host" && current.eden) {
    return {
      ...current,
      symbols: [{ ...EDEN_EVENT_AERIUM }],
      eden: {
        ...current.eden,
        bonds: [],
        etfs: [],
        options: edenExchangeOptionsTemplate(),
      },
    };
  }
  return current;
}
