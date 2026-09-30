import { describe, expect, it } from "vitest";
import {
  EDEN_EVENT_ACTIONS,
  EDEN_EVENT_CUES,
  edenCueBlockers,
  edenCueReceiptId,
  edenCueStatus,
  edenEventCue,
} from "../../shared/src/eden-event.js";
import { edenEventFlow } from "../../shared/src/eden-presets.js";
import { edenPlaybookToGameMinute } from "../../shared/src/eden-clock.js";

const cue = (id: string) => {
  const found = edenEventCue(id);
  if (!found) throw new Error(`missing cue ${id}`);
  return found;
};
const done = (...ids: string[]) =>
  ids.flatMap((id) => [
    edenCueReceiptId(id),
    ...cue(id).actions.map((a) => a.id),
  ]);

describe("playbook cues", () => {
  it("cover every scripted action once except ETF windows", () => {
    const covered = EDEN_EVENT_CUES.flatMap((c) => c.actions.map((a) => a.id));
    expect(new Set(covered).size).toBe(covered.length);
    const uncovered = EDEN_EVENT_ACTIONS.filter(
      (a) => !covered.includes(a.id),
    ).map((a) => a.id);
    expect(uncovered.every((id) => id.startsWith("eden-v1/etf/"))).toBe(true);
    expect(uncovered.length).toBeGreaterThan(0);
    expect(new Set(EDEN_EVENT_CUES.map((c) => c.id)).size).toBe(
      EDEN_EVENT_CUES.length,
    );
  });

  it("keep each cue's actions in scripted order", () => {
    for (const c of EDEN_EVENT_CUES) {
      const order = c.actions.map((a) => EDEN_EVENT_ACTIONS.indexOf(a));
      expect(order).toEqual([...order].sort((x, y) => x - y));
    }
    expect(cue("halftime").actions.map((a) => a.id)).toEqual([
      "eden-v1/news/90/premium",
      "eden-v1/freeze",
      "eden-v1/news/90/public",
    ]);
  });

  it("run in playbook order", () => {
    const ids = EDEN_EVENT_CUES.map((c) => c.id);
    expect(ids[0]).toBe("open");
    expect(ids.at(-1)).toBe("close");
    const before = (a: string, b: string) =>
      expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b));
    before("list-neuro", "list-orbital");
    before("halftime", "reopen");
    before("reopen", "vote");
    before("vote", "shock");
    before("shock", "grant");
    before("grant", "squeeze");
    const minutes = EDEN_EVENT_CUES.map((c) =>
      c.kind === "auction" ? c.minute - 0.5 : c.minute,
    );
    expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
  });

  it("require the listing a beat trades or moves", () => {
    expect(cue("open").requires).toEqual([]);
    expect(cue("close").requires).toEqual([]);
    expect(cue("news-40").requires).toContain("list-neuro");
    expect(cue("otc-50").requires).toContain("list-neuro");
    expect(cue("otc-65").requires).toContain("list-orbital");
    expect(cue(`otc-${edenPlaybookToGameMinute(92)}`).requires).toContain(
      "reopen",
    );
    expect(cue("news-62").requires).toContain("list-neuro");
    expect(cue("list-orbital").requires).toContain("list-neuro");
    expect(cue("shock").requires).toEqual(
      expect.arrayContaining(["list-neuro", "reopen"]),
    );
    expect(cue("list-neuro").requires).not.toContain("list-neuro");
    for (const c of EDEN_EVENT_CUES)
      for (const id of c.requires) expect(edenEventCue(id)).toBeDefined();
  });

  it("derive status from fire and action receipts", () => {
    const neuro = cue("list-neuro");
    expect(edenCueStatus(neuro, new Set())).toBe("blocked");
    expect(edenCueBlockers(neuro, new Set())).toEqual(["open"]);
    const opened = new Set(done("open"));
    expect(edenCueStatus(neuro, opened)).toBe("ready");
    const fired = new Set([
      ...opened,
      edenCueReceiptId("list-neuro"),
      neuro.actions[0]!.id,
    ]);
    expect(edenCueStatus(neuro, fired)).toBe("running");
    expect(edenCueBlockers(cue("news-40"), fired)).toEqual(["list-neuro"]);
    const finished = new Set([...opened, ...done("list-neuro")]);
    expect(edenCueStatus(neuro, finished)).toBe("done");
    expect(edenCueStatus(cue("news-40"), finished)).toBe("ready");
  });

  it("resolve the event flow with scripted taking precedence", () => {
    expect(edenEventFlow(undefined)).toBe("host");
    expect(edenEventFlow({ playbookCues: true })).toBe("cues");
    expect(edenEventFlow({ eventScript: true, playbookCues: true })).toBe(
      "scripted",
    );
    expect(edenEventFlow({ demoScript: true })).toBe("demo");
    expect(
      edenEventFlow({ eventScript: true, demoScript: true, playbookCues: true }),
    ).toBe("scripted");
  });
});
