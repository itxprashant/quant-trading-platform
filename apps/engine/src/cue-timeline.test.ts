import { describe, expect, it, vi } from "vitest";
import { edenCueReceiptId, edenEventCue } from "@qtp/shared";
import { CueTimeline } from "./cue-timeline.js";
import type { EventActionContext } from "./event-timeline.js";

const MINUTE_MS = 6000;
const SECOND_MS = MINUTE_MS / 60;
const T0 = Date.UTC(2026, 8, 24, 12);

const actionIds = (cueId: string) =>
  edenEventCue(cueId)!.actions.map((a) => a.id);

function fixture(
  receipts: Array<{ actionId: string; completedAt: Date }> = [],
) {
  const executed: string[] = [];
  const contexts = new Map<string, EventActionContext>();
  const recordFire = vi.fn(async (_id: string, _at: number) => {});
  let fail: string | undefined;
  const timeline = new CueTimeline({
    challengeId: "challenge",
    minuteMs: MINUTE_MS,
    loadReceipts: async () => receipts,
    recordFire,
    execute: async (action, context) => {
      if (action.id === fail) throw new Error("boom");
      executed.push(action.id);
      contexts.set(action.id, context);
    },
  });
  return {
    timeline,
    executed,
    contexts,
    recordFire,
    failOn: (id?: string) => (fail = id),
  };
}
const done = (cueId: string, at = T0) => [
  { actionId: edenCueReceiptId(cueId), completedAt: new Date(at) },
  ...actionIds(cueId).map((actionId) => ({
    actionId,
    completedAt: new Date(at),
  })),
];

describe("CueTimeline", () => {
  it("runs a cue's first action on fire and the rest at their scripted offsets", async () => {
    const f = fixture(done("open"));
    expect(await f.timeline.fire("auction-15", T0)).toBe(true);
    expect(f.recordFire).toHaveBeenCalledWith(
      edenCueReceiptId("auction-15"),
      T0,
    );
    expect(await f.timeline.tick(T0)).toEqual(["eden-v1/auction/15/open"]);
    const open = f.contexts.get("eden-v1/auction/15/open")!;
    expect(open.scheduledAt).toBe(T0);
    // closesAtSecond maps onto the fire time, 30 game seconds later.
    expect(open.timestampAtSecond(15 * 60 - 10)).toBe(T0 + 30 * SECOND_MS);
    expect(await f.timeline.tick(T0 + 30 * SECOND_MS - 1)).toEqual([]);
    expect(await f.timeline.tick(T0 + 30 * SECOND_MS)).toEqual([
      "eden-v1/auction/15/resolve",
    ]);
  });

  it("fires a cue at most once and refuses one whose prerequisite is not done", async () => {
    const f = fixture();
    expect(await f.timeline.fire("news-5", T0)).toBe(false);
    expect(await f.timeline.fire("unknown", T0)).toBe(false);
    expect(await f.timeline.fire("open", T0)).toBe(true);
    expect(await f.timeline.fire("open", T0 + 1)).toBe(false);
    // Fired but not yet executed: dependents stay blocked.
    expect(await f.timeline.fire("news-5", T0)).toBe(false);
    await f.timeline.tick(T0);
    expect(await f.timeline.fire("news-5", T0 + 1)).toBe(true);
    expect(f.recordFire).toHaveBeenCalledTimes(2);
  });

  it("resumes a half-run cue on its original fire time after a restart", async () => {
    const firedAt = T0 - 200 * SECOND_MS;
    const grant = actionIds("grant");
    const f = fixture([
      ...done("open"),
      { actionId: edenCueReceiptId("grant"), completedAt: new Date(firedAt) },
      ...grant.slice(0, 3).map((actionId) => ({
        actionId,
        completedAt: new Date(firedAt),
      })),
    ]);
    // The award lands 5 game minutes (+10 s premium lead) after the fire.
    expect(await f.timeline.tick(T0)).toEqual([]);
    const awardAt = firedAt + 300 * SECOND_MS;
    const ran = await f.timeline.tick(awardAt);
    expect(ran).toEqual(["eden-v1/news/105/premium"]);
    expect(await f.timeline.tick(awardAt + 10 * SECOND_MS)).toEqual([
      "eden-v1/grant/award",
      "eden-v1/news/105/public",
    ]);
    expect(f.contexts.get("eden-v1/grant/award")!.scheduledAt).toBe(
      awardAt + 10 * SECOND_MS,
    );
    expect(await f.timeline.fire("grant", T0)).toBe(false);
  });

  it("interleaves overlapping cues by scheduled time", async () => {
    const f = fixture(done("open"));
    await f.timeline.fire("auction-15", T0);
    await f.timeline.fire("news-5", T0 + 5 * SECOND_MS);
    await f.timeline.tick(T0 + 60 * SECOND_MS);
    expect(f.executed).toEqual([
      "eden-v1/auction/15/open",
      "eden-v1/news/5/premium",
      "eden-v1/news/5/public",
      "eden-v1/auction/15/resolve",
    ]);
  });

  it("blocks later actions behind a failure and retries on the next tick", async () => {
    const f = fixture(done("open"));
    await f.timeline.fire("news-5", T0);
    f.failOn("eden-v1/news/5/premium");
    await expect(f.timeline.tick(T0 + 20 * SECOND_MS)).rejects.toThrow("boom");
    expect(f.executed).toEqual([]);
    f.failOn();
    expect(await f.timeline.tick(T0 + 20 * SECOND_MS)).toEqual(
      actionIds("news-5"),
    );
    expect(f.timeline.completed("eden-v1/news/5/public")).toBe(true);
  });
});
