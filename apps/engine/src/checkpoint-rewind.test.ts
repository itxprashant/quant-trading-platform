import { describe, expect, it, vi } from "vitest";
import { shiftEngineState, type EngineState } from "@qtp/core";
import {
  challengeNews,
  loans,
  resumedEndsAt,
  resumedStartsAt,
  shiftCheckpointRow,
  shiftReceiptId,
  shiftReceipts,
  type CheckpointPayload,
} from "@qtp/db";
import {
  EDEN_DEMO_DURATION_MINUTES,
  EDEN_DEMO_VERSION,
  EDEN_EVENT_DURATION_MINUTES,
  EDEN_EVENT_GRANT_AWARD_MINUTE,
  edenCueReceiptId,
  edenEventCue,
  type ChallengeConfig,
} from "@qtp/shared";
import { CueTimeline } from "./cue-timeline.js";

const MINUTE_MS = 6000;
const SECOND_MS = MINUTE_MS / 60;
const START = Date.UTC(2026, 8, 26, 10);
/** Checkpoint taken 40 game minutes and 20 seconds in. */
const TAKEN = START + 40 * MINUTE_MS + 20 * SECOND_MS;
/** The host resumes 17 minutes and 3 seconds after the checkpoint. */
const SHIFT = 17 * MINUTE_MS + 3 * SECOND_MS;
const NOW = TAKEN + SHIFT;
const iso = (ms: number) => new Date(ms).toISOString();

type Receipt = CheckpointPayload["receipts"][number];

function payload(
  eden: Record<string, unknown> | undefined,
  opts: { endsAt?: number; receipts?: Receipt[] } = {},
): CheckpointPayload {
  return {
    version: 1,
    minuteMs: MINUTE_MS,
    challenge: {
      config: { eden } as unknown as ChallengeConfig,
      startsAt: iso(START),
      endsAt: opts.endsAt == null ? null : iso(opts.endsAt),
      frozen: false,
    },
    engine: { state: {}, minuteCount: 40 },
    openOrderIds: [],
    receipts: opts.receipts ?? [],
    rows: {} as CheckpointPayload["rows"],
    redis: {},
  };
}

const actionIds = (cueId: string) =>
  edenEventCue(cueId)!.actions.map((a) => a.id);

/** Receipts for a fired cue and its first `steps` actions (all by default). */
function fired(cueId: string, at: number, steps?: number): Receipt[] {
  return [
    { actionId: edenCueReceiptId(cueId), completedAt: iso(at) },
    ...actionIds(cueId)
      .slice(0, steps)
      .map((actionId) => ({ actionId, completedAt: iso(at) })),
  ];
}

function timeline(receipts: Array<{ actionId: string; completedAt: Date }>) {
  return new CueTimeline({
    challengeId: "challenge",
    minuteMs: MINUTE_MS,
    loadReceipts: async () => receipts,
    recordFire: vi.fn(async () => {}),
    execute: async () => {},
  });
}

describe("checkpoint clock shift", () => {
  it("resumes at the checkpoint's game minute, so the gap is not replayed", () => {
    const p = payload({ eventScript: true });
    const startsAt = resumedStartsAt(p, SHIFT)!.getTime();
    expect(NOW - startsAt).toBe(TAKEN - START);
    expect(Math.floor((NOW - startsAt) / MINUTE_MS)).toBe(p.engine.minuteCount);
  });

  it("ends a scripted event its duration after the shifted start", () => {
    const endsAt = resumedEndsAt(payload({ eventScript: true }), SHIFT)!;
    expect(endsAt.getTime()).toBe(
      START + SHIFT + EDEN_EVENT_DURATION_MINUTES * MINUTE_MS,
    );
    // Time left is exactly what it was when the checkpoint was taken.
    expect(endsAt.getTime() - NOW).toBe(
      START + EDEN_EVENT_DURATION_MINUTES * MINUTE_MS - TAKEN,
    );
  });

  it("ends a cue sheet its duration after the shifted open cue", () => {
    const openAt = START + 2 * MINUTE_MS;
    const receipts = fired("open", openAt);
    expect(
      resumedEndsAt(payload({ playbookCues: true }, { receipts }), SHIFT),
    ).toEqual(
      new Date(openAt + SHIFT + EDEN_EVENT_DURATION_MINUTES * MINUTE_MS),
    );
    const demo = [
      { actionId: edenCueReceiptId("open", EDEN_DEMO_VERSION), completedAt: iso(openAt) },
    ];
    expect(
      resumedEndsAt(payload({ demoScript: true }, { receipts: demo }), SHIFT),
    ).toEqual(new Date(openAt + SHIFT + EDEN_DEMO_DURATION_MINUTES * MINUTE_MS));
  });

  it("leaves a cue sheet without an end until its open cue fires", () => {
    expect(
      resumedEndsAt(
        payload({ playbookCues: true }, { endsAt: START + MINUTE_MS }),
        SHIFT,
      ),
    ).toBeNull();
  });

  it("keeps a host-run event's configured length", () => {
    const endsAt = START + 90 * MINUTE_MS;
    expect(resumedEndsAt(payload(undefined, { endsAt }), SHIFT)).toEqual(
      new Date(endsAt + SHIFT),
    );
    expect(resumedEndsAt(payload(undefined), SHIFT)).toBeNull();
  });

  it("moves premium-feed deadlines embedded in receipt ids", () => {
    expect(shiftReceiptId(`auction:a1:premium:${TAKEN + 5000}`, SHIFT)).toBe(
      `auction:a1:premium:${TAKEN + 5000 + SHIFT}`,
    );
    expect(shiftReceiptId("eden-v1/news/3/public", SHIFT)).toBe(
      "eden-v1/news/3/public",
    );
  });

  it("shifts every timestamp column of a restored row and nothing else", () => {
    const loan = shiftCheckpointRow(
      loans,
      {
        id: "loan",
        principal: 500,
        nextPaymentAt: iso(TAKEN + MINUTE_MS),
        fundedAt: null,
        createdAt: new Date(TAKEN - MINUTE_MS),
      },
      SHIFT,
    );
    expect(loan).toEqual({
      id: "loan",
      principal: 500,
      nextPaymentAt: new Date(TAKEN + MINUTE_MS + SHIFT),
      fundedAt: null,
      createdAt: new Date(TAKEN - MINUTE_MS + SHIFT),
    });
    const news = shiftCheckpointRow(
      challengeNews,
      { publishAt: iso(TAKEN + 30_000), embargoUntil: iso(TAKEN + 10_000) },
      SHIFT,
    );
    expect(news.publishAt).toEqual(new Date(TAKEN + 30_000 + SHIFT));
    expect(news.embargoUntil).toEqual(new Date(TAKEN + 10_000 + SHIFT));
  });

  it("keeps option series' remaining life", () => {
    const state = {
      accounts: [{ userId: "u", cash: 1 }],
      options: [{ symbol: "C", openedAt: TAKEN - 1000, expiresAt: TAKEN + 9000 }],
    } as unknown as EngineState;
    const shifted = shiftEngineState(state, SHIFT);
    expect(shifted.options[0]).toMatchObject({
      openedAt: TAKEN - 1000 + SHIFT,
      expiresAt: TAKEN + 9000 + SHIFT,
    });
    expect(shifted.accounts).toBe(state.accounts);
  });
});

describe("cue timing after a resume", () => {
  // Grant fired 200 game seconds before the checkpoint; 3 steps had run.
  const grantAt = TAKEN - 200 * SECOND_MS;
  const snapshot = [
    ...fired("open", START),
    ...fired("grant", grantAt, 3),
  ];
  // The award headline is 10 game minutes after the fire (premium lead first).
  const awardAt = grantAt + 600 * SECOND_MS;
  const premium = `eden-v1/news/${EDEN_EVENT_GRANT_AWARD_MINUTE}/premium`;

  it("keeps a step that was in the future at the checkpoint in the future", async () => {
    const t = timeline(shiftReceipts(snapshot, SHIFT));
    expect(await t.tick(NOW)).toEqual([]);
    expect(await t.tick(awardAt + SHIFT - 1)).toEqual([]);
    expect(await t.tick(awardAt + SHIFT)).toEqual([premium]);
    expect(awardAt + SHIFT - NOW).toBe(awardAt - TAKEN);
  });

  it("does not rerun steps the checkpoint had already receipted", async () => {
    const t = timeline(shiftReceipts(snapshot, SHIFT));
    const ran = await t.tick(awardAt + SHIFT + 60 * SECOND_MS);
    for (const done of actionIds("grant").slice(0, 3))
      expect(ran).not.toContain(done);
    expect(await t.fire("grant", NOW)).toBe(false);
  });

  it("would fire the step at once without the shift", async () => {
    const unshifted = snapshot.map((r) => ({
      actionId: r.actionId,
      completedAt: new Date(r.completedAt),
    }));
    expect(await timeline(unshifted).tick(NOW)).toContain(premium);
  });

  it("lets a cue that fired after the checkpoint run again", async () => {
    const t = timeline(shiftReceipts(fired("open", START), SHIFT));
    expect(await t.fire("auction-13", NOW)).toBe(true);
    expect(await t.tick(NOW)).toEqual(["eden-v1/auction/13/open"]);
  });
});
