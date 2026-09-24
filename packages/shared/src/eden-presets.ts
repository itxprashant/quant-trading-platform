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
  volatility: 4,
  tickSize: 0.5,
};
export const EDEN_EVENT_NEURO: SymbolConfig = {
  symbol: "NEURO",
  name: "Neuro-Chips",
  initialPrice: 500,
  volatility: 2,
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
    couponPer5Min: 500,
    maxPerUser: 1,
  },
  {
    id: "aerium_pegged",
    name: "Aerium-Pegged Yield Bond",
    price: 10000,
    faceValue: 10000,
    peggedYield: { symbol: "AERIUM", base: 2000, divisor: 10 },
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
  hftMarketMakers: 2,
  momentumTraders: 4,
  vegaSnipers: 1,
  parityArbers: 1,
  spread: 1,
  quoteSize: 10,
  intensity: 0.5,
};
export const EDEN_EVENT_DEFAULTS = {
  auctionDurationSec: 30,
  auctionWinnerFraction: 0.3,
  premiumLeadSec: 10,
  premiumAccessMinutes: 15,
  otcReplySec: 15,
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
