import { createRedis, type Redis } from "@qtp/bus";
import { redisKeys, type BroadcastEnvelope } from "@qtp/shared";

const PREFIX = "qtp:bc:";

export type Dispatch = (
  challengeId: string,
  envelopes: BroadcastEnvelope[],
) => void;

/**
 * One Redis subscriber per gateway node. Challenge channels are subscribed
 * with reference counting so we only listen while at least one client cares.
 */
export class Fanout {
  private readonly sub: Redis;
  private readonly refcount = new Map<string, number>();

  constructor(url: string, dispatch: Dispatch) {
    this.sub = createRedis(url);
    this.sub.on("message", (channel: string, message: string) => {
      if (!channel.startsWith(PREFIX)) return;
      const challengeId = channel.slice(PREFIX.length);
      try {
        const envs = JSON.parse(message) as BroadcastEnvelope[];
        dispatch(challengeId, envs);
      } catch {
        /* malformed payload; ignore */
      }
    });
  }

  async add(challengeId: string): Promise<void> {
    const c = this.refcount.get(challengeId) ?? 0;
    if (c === 0) {
      await this.sub.subscribe(redisKeys.broadcastChannel(challengeId));
    }
    this.refcount.set(challengeId, c + 1);
  }

  async remove(challengeId: string): Promise<void> {
    const c = this.refcount.get(challengeId) ?? 0;
    if (c <= 1) {
      this.refcount.delete(challengeId);
      await this.sub.unsubscribe(redisKeys.broadcastChannel(challengeId));
    } else {
      this.refcount.set(challengeId, c - 1);
    }
  }

  async close(): Promise<void> {
    await this.sub.quit().catch(() => {});
  }
}
