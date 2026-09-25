import { describe, expect, it } from "vitest";
import { endingSettlement, profitPnl } from "./scoring.js";

describe("endingSettlement", () => {
  it("is free cash plus marked assets", () => {
    expect(endingSettlement(800, 350)).toBe(1150);
    expect(endingSettlement(0, 0)).toBe(0);
    expect(endingSettlement(-40, 120)).toBe(80);
  });

  it("is not profit versus starting cash", () => {
    expect(profitPnl(800, 350, 1000, 0)).toBe(150);
    expect(endingSettlement(800, 350)).toBe(1150);
  });
});
