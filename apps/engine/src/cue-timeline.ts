import {
  EDEN_EVENT_CUES,
  edenCueBlockers,
  edenCueReceiptId,
  edenEventCue,
  type EdenEventAction,
} from "@qtp/shared";
import { eventActionUuid, type EventActionContext } from "./event-timeline.js";

export interface CueTimelineDependencies {
  readonly challengeId: string;
  /** Pass env.minuteMs; defaults to real-time minutes. */
  readonly minuteMs?: number;
  /** event_actions rows for this challenge: cue fire receipts and completed actions. */
  readonly loadReceipts: () => Promise<
    Iterable<{ actionId: string; completedAt: Date }>
  >;
  /** Durably record a fire time before any of the cue's actions run. */
  readonly recordFire: (receiptId: string, at: number) => Promise<void>;
  /** Same contract as EventTimeline: success means the effect and receipt are durable. */
  readonly execute: (
    action: EdenEventAction,
    context: EventActionContext,
  ) => Promise<void>;
}

type Step = {
  action: EdenEventAction;
  firedAt: number;
  index: number;
  scheduledAt: number;
  timestampAtSecond: (second: number) => number;
};

/**
 * Serial, restartable dispatcher for host-fired playbook cues. A cue's actions
 * keep their scripted offsets from its first action, measured from the fire
 * time, so a restart resumes a half-run cue on its original schedule.
 */
export class CueTimeline {
  private readonly fired = new Map<string, number>();
  private readonly receipts = new Set<string>();
  private readonly deps: CueTimelineDependencies;
  private readonly secondMs: number;
  private restored = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(deps: CueTimelineDependencies) {
    if (!deps.challengeId) throw new TypeError("challengeId is required");
    const minuteMs = deps.minuteMs ?? 60_000;
    if (!Number.isFinite(minuteMs) || minuteMs <= 0)
      throw new RangeError("minuteMs must be positive and finite");
    this.deps = { ...deps };
    this.secondMs = minuteMs / 60;
  }

  /** Load durable receipts once; later calls are no-ops. */
  restore(): Promise<void> {
    return this.serial(() => this.load());
  }

  /** Whether an action (or cue fire receipt) is durable. Valid after restore. */
  completed(actionId: string): boolean {
    return this.receipts.has(actionId);
  }

  /** False when the cue is unknown, already fired, or its prerequisites are not done. */
  fire(cueId: string, at: number): Promise<boolean> {
    if (!Number.isFinite(at)) throw new RangeError("at must be finite");
    return this.serial(async () => {
      await this.load();
      const cue = edenEventCue(cueId);
      if (!cue || this.fired.has(cue.id)) return false;
      if (edenCueBlockers(cue, this.receipts).length > 0) return false;
      const receipt = edenCueReceiptId(cue.id);
      await this.deps.recordFire(receipt, at);
      this.fired.set(cue.id, at);
      this.receipts.add(receipt);
      return true;
    });
  }

  /** Runs every fired action due by `now`. Failure blocks later actions. */
  tick(now: number): Promise<readonly string[]> {
    if (!Number.isFinite(now)) throw new RangeError("now must be finite");
    return this.serial(async () => {
      await this.load();
      const executed: string[] = [];
      for (const step of this.pendingSteps()) {
        if (step.scheduledAt > now) break;
        await this.deps.execute(step.action, {
          challengeId: this.deps.challengeId,
          actionUuid: eventActionUuid(this.deps.challengeId, step.action.id),
          scheduledAt: step.scheduledAt,
          now,
          secondMs: this.secondMs,
          lateByMs: Math.max(0, now - step.scheduledAt),
          timestampAtSecond: step.timestampAtSecond,
          resourceUuid: (key) => eventActionUuid(this.deps.challengeId, key),
        });
        this.receipts.add(step.action.id);
        executed.push(step.action.id);
      }
      return executed;
    });
  }

  private pendingSteps(): Step[] {
    const steps: Step[] = [];
    for (const cue of EDEN_EVENT_CUES) {
      const firedAt = this.fired.get(cue.id);
      if (firedAt === undefined) continue;
      const anchor = cue.actions[0]!.atSecond;
      const timestampAtSecond = (second: number) =>
        firedAt + (second - anchor) * this.secondMs;
      cue.actions.forEach((action, index) => {
        if (this.receipts.has(action.id)) return;
        steps.push({
          action,
          firedAt,
          index,
          scheduledAt: timestampAtSecond(action.atSecond),
          timestampAtSecond,
        });
      });
    }
    return steps.sort(
      (a, b) =>
        a.scheduledAt - b.scheduledAt ||
        a.firedAt - b.firedAt ||
        a.index - b.index,
    );
  }

  private async load(): Promise<void> {
    if (this.restored) return;
    const prefix = edenCueReceiptId("");
    for (const row of await this.deps.loadReceipts()) {
      this.receipts.add(row.actionId);
      if (row.actionId.startsWith(prefix))
        this.fired.set(
          row.actionId.slice(prefix.length),
          row.completedAt.getTime(),
        );
    }
    this.restored = true;
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.pending.then(task);
    // A failed call rejects its caller but does not poison the next retry.
    this.pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
