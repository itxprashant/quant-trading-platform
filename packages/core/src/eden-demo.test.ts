import { describe, expect, it } from "vitest";
import {
  EDEN_DEMO_ACTIONS,
  EDEN_DEMO_CUES,
  EDEN_DEMO_VERSION,
} from "../../shared/src/eden-demo.js";
import { EDEN_DEMO_DURATION_MINUTES } from "../../shared/src/eden-presets.js";
import {
  edenCueBlockers,
  edenCueStatus,
  edenEventCue,
} from "../../shared/src/eden-event.js";

describe("practice timeline", () => {
  it("covers a 30-minute tester session without tournament action ids", () => {
    const ids = EDEN_DEMO_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith(`${EDEN_DEMO_VERSION}/`))).toBe(
      true,
    );
    expect(ids.some((id) => id.startsWith("eden-v1/"))).toBe(false);
    const seconds = EDEN_DEMO_ACTIONS.map((action) => action.atSecond);
    expect(seconds).toEqual([...seconds].sort((a, b) => a - b));
    expect(EDEN_DEMO_ACTIONS.at(-1)).toMatchObject({
      kind: "end",
      atSecond: EDEN_DEMO_DURATION_MINUTES * 60,
    });

    const kinds = new Set(EDEN_DEMO_ACTIONS.map((action) => action.kind));
    for (const kind of [
      "market_open",
      "news",
      "bond_available",
      "list_underlying",
      "list_etf",
      "etf_window",
      "options_open",
      "auction_open",
      "auction_resolve",
      "otc_offer",
      "end",
    ]) {
      expect(kinds.has(kind as never)).toBe(true);
    }

    const neuroAt = EDEN_DEMO_ACTIONS.find(
      (action) => action.kind === "list_underlying",
    )!.atSecond;
    const neuroNews = EDEN_DEMO_ACTIONS.find(
      (action) =>
        action.kind === "news" &&
        action.news.effects.some((effect) => effect.symbol === "NEURO"),
    )!;
    expect(neuroNews.atSecond).toBeGreaterThan(neuroAt);

    const etfAt = EDEN_DEMO_ACTIONS.find(
      (action) => action.kind === "list_etf",
    )!.atSecond;
    const windowAt = EDEN_DEMO_ACTIONS.find(
      (action) => action.kind === "etf_window" && action.open,
    )!.atSecond;
    expect(windowAt).toBe(etfAt);

    const optionsAt = EDEN_DEMO_ACTIONS.find(
      (action) => action.kind === "options_open",
    )!.atSecond;
    expect(optionsAt).toBeLessThan(EDEN_DEMO_DURATION_MINUTES * 60);
  });

  it("splits the practice timeline into cues the admin fires", () => {
    const covered = EDEN_DEMO_CUES.flatMap((cue) =>
      cue.actions.map((action) => action.id),
    );
    expect(new Set(covered)).toEqual(
      new Set(EDEN_DEMO_ACTIONS.map((action) => action.id)),
    );
    expect(covered).toHaveLength(EDEN_DEMO_ACTIONS.length);
    const open = edenEventCue("open", EDEN_DEMO_CUES)!;
    expect(edenCueStatus(open, new Set(), EDEN_DEMO_CUES)).toBe("ready");
    const neuroNews = edenEventCue("news-9", EDEN_DEMO_CUES)!;
    expect(edenCueBlockers(neuroNews, new Set(), EDEN_DEMO_CUES)).toEqual([
      "open",
      "list-neuro",
    ]);
    const windowCue = edenEventCue("etf-window-15", EDEN_DEMO_CUES)!;
    expect(windowCue.actions.map((action) => action.atSecond)).toEqual([
      15 * 60,
      15 * 60 + 30,
    ]);
    expect(edenEventCue("close", EDEN_DEMO_CUES)?.requires).toEqual([]);
  });
});
