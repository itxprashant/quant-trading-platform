import type {
  BondTemplate,
  EdenBotConfig,
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
  underlyings: ["AERIUM"],
  cycleMinutes: 5,
  exerciseWindowSec: 15,
  autoCycle: true,
  strikeSteps: 1,
};
export const EDEN_EVENT_BOTS: EdenBotConfig = {
  hftMarketMakers: 0,
  momentumTraders: 0,
  vegaSnipers: 0,
  parityArbers: 0,
  spread: 1,
  quoteSize: 10,
  intensity: 0.5,
};
export type EdenEventFlow = "host" | "cues" | "scripted";

/** Scripted wins over cues so a stray flag can never run both drivers. */
export function edenEventFlow(
  eden: { eventScript?: boolean; playbookCues?: boolean } | undefined,
): EdenEventFlow {
  if (eden?.eventScript) return "scripted";
  if (eden?.playbookCues) return "cues";
  return "host";
}

export const EDEN_EVENT_DEFAULTS = {
  auctionDurationSec: 30,
  auctionWinnerFraction: 0.3,
  premiumLeadSec: 10,
  premiumAccessMinutes: 15,
  otcReplySec: 40,
  otcBargainDelaySec: 5,
  etfWindowSec: 30,
  voteDurationSec: 60,
  taxRate: 0.1,
  taxTopFraction: 0.1,
  taxBottomFraction: 0.2,
  grantPrize: 10000,
  assignmentGraceSec: 30,
  borderPenaltyFraction: 0.2,
} as const;
