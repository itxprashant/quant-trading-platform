import { createHash } from "node:crypto";
import { EDEN_EVENT_ACTIONS, type EdenEventAction } from "@qtp/shared";

/** UUIDv5 with a fixed private namespace; key should include eden-v1. */
export function eventActionUuid(challengeId: string, key: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from("5e28e780fe98438fa57739f51cc3fe92", "hex"))
    .update(JSON.stringify([challengeId, key]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface EventActionContext {
  readonly challengeId: string;
  /** Deterministic UUID for this action, distinct from action.id (the receipt key). */
  readonly actionUuid: string;
  readonly scheduledAt: number;
  readonly now: number;
  /** All seconds, including short windows, scale with the game clock. */
  readonly secondMs: number;
  readonly lateByMs: number;
  readonly timestampAtSecond: (second: number) => number;
  /** Use the same key on open/resolve; use an additional user ID for each OTC recipient. */
  readonly resourceUuid: (key: string) => string;
}

export interface EventTimelineDependencies {
  readonly challengeId: string;
  /** Parent passes config.eden.eventScript === true (and checks challenge type). */
  readonly enabled: boolean;
  /** Persisted challenge.startsAt epoch milliseconds, never the runner's startup time. */
  readonly startsAt: number;
  /** Pass env.minuteMs; defaults to real-time minutes. */
  readonly minuteMs?: number;
  /** Read completed action.id strings from durable storage for this challenge only. */
  readonly loadCompletedActionIds: () => Promise<Iterable<string>>;
  /**
   * Execute in the engine, without REST calls. Successful return MUST mean the
   * effect and completed receipt are durable. Prefer a single DB transaction.
   * Reconcile in-memory state and publish via an outbox after commit.
   */
  readonly execute: (
    action: EdenEventAction,
    context: EventActionContext,
  ) => Promise<void>;
}

/**
 * Serial, restartable schedule dispatcher. No timers, Redis/DB coupling, or hidden
 * wall clock. It requires the existing per-challenge engine lock, not a new writer.
 */
export class EventTimeline {
  private readonly completed = new Set<string>();
  private readonly deps: EventTimelineDependencies;
  private readonly secondMs: number;
  private restored = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(deps: EventTimelineDependencies) {
    if (!deps.challengeId) throw new TypeError("challengeId is required");
    if (!Number.isFinite(deps.startsAt))
      throw new RangeError("startsAt must be a persisted epoch timestamp");
    const minuteMs = deps.minuteMs ?? 60_000;
    if (!Number.isFinite(minuteMs) || minuteMs <= 0)
      throw new RangeError("minuteMs must be positive and finite");
    this.deps = { ...deps };
    this.secondMs = minuteMs / 60;
  }

  /** Returns action.id strings completed by this tick. Failure blocks later actions. */
  async tick(now: number, through = now): Promise<readonly string[]> {
    if (!Number.isFinite(now)) throw new RangeError("now must be finite");
    const run = this.pending.then(async () => {
      const { deps } = this;
      if (!deps.enabled || now < deps.startsAt) return [];
      if (!this.restored) {
        const ids = await deps.loadCompletedActionIds();
        for (const id of ids) this.completed.add(id);
        this.restored = true;
      }
      const executed: string[] = [];
      for (const action of EDEN_EVENT_ACTIONS) {
        const scheduledAt = deps.startsAt + action.atSecond * this.secondMs;
        // Compare absolute deadlines: subtracting large epochs then dividing can
        // round an exact accelerated-clock boundary just below its due second.
        if (scheduledAt > Math.min(now, through)) break;
        if (this.completed.has(action.id)) continue;
        await deps.execute(action, {
          challengeId: deps.challengeId,
          actionUuid: eventActionUuid(deps.challengeId, action.id),
          scheduledAt,
          now,
          secondMs: this.secondMs,
          lateByMs: Math.max(0, now - scheduledAt),
          timestampAtSecond: (second) => deps.startsAt + second * this.secondMs,
          resourceUuid: (key) => eventActionUuid(deps.challengeId, key),
        });
        this.completed.add(action.id);
        executed.push(action.id);
      }
      return executed;
    });
    // A failed tick rejects its caller but does not poison the next retry.
    this.pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
