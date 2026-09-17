import {
  redisKeys,
  type BroadcastEnvelope,
  type EngineCommand,
  type EngineEvent,
} from "@qtp/shared";
import type { Redis } from "ioredis";

const FIELD = "d";

/** API -> engine: enqueue a command on the challenge's command stream. */
export async function publishCommand(
  redis: Redis,
  challengeId: string,
  cmd: EngineCommand,
): Promise<void> {
  await redis.xadd(
    redisKeys.commandStream(challengeId),
    "MAXLEN",
    "~",
    "100000",
    "*",
    FIELD,
    JSON.stringify(cmd),
  );
}

/** Engine -> durable event stream (consumed by scoring / replay). */
export async function appendEvents(
  redis: Redis,
  challengeId: string,
  events: EngineEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const pipeline = redis.pipeline();
  for (const evt of events) {
    pipeline.xadd(
      redisKeys.eventStream(challengeId),
      "MAXLEN",
      "~",
      "200000",
      "*",
      FIELD,
      JSON.stringify(evt),
    );
  }
  await pipeline.exec();
}

/** Engine -> gateway pub/sub: addressable, pre-formed client messages. */
export async function publishBroadcast(
  redis: Redis,
  challengeId: string,
  envelopes: BroadcastEnvelope[],
): Promise<void> {
  if (envelopes.length === 0) return;
  await redis.publish(
    redisKeys.broadcastChannel(challengeId),
    JSON.stringify(envelopes),
  );
}

export interface StreamMessage<T> {
  id: string;
  data: T;
}

/** Read pending commands as a blocking consumer (single engine owner). */
export async function readCommands(
  redis: Redis,
  challengeId: string,
  lastId: string,
  blockMs = 1000,
  count = 256,
): Promise<{ nextId: string; messages: StreamMessage<EngineCommand>[] }> {
  const res = (await redis.xread(
    "COUNT",
    count,
    "BLOCK",
    blockMs,
    "STREAMS",
    redisKeys.commandStream(challengeId),
    lastId,
  )) as [string, [string, string[]][]][] | null;

  if (!res) return { nextId: lastId, messages: [] };
  const entries = res[0]?.[1] ?? [];
  const messages: StreamMessage<EngineCommand>[] = [];
  let nextId = lastId;
  for (const [id, fields] of entries) {
    nextId = id;
    const raw = fieldValue(fields, FIELD);
    if (raw) messages.push({ id, data: JSON.parse(raw) as EngineCommand });
  }
  return { nextId, messages };
}

/** Consumer-group read of the event stream (scoring worker). */
export async function readEventGroup(
  redis: Redis,
  challengeId: string,
  group: string,
  consumer: string,
  blockMs = 2000,
  count = 512,
): Promise<StreamMessage<EngineEvent>[]> {
  const key = redisKeys.eventStream(challengeId);
  try {
    await redis.xgroup("CREATE", key, group, "0", "MKSTREAM");
  } catch (err) {
    // BUSYGROUP: group already exists; ignore.
    if (!(err as Error).message.includes("BUSYGROUP")) throw err;
  }
  const res = (await redis.xreadgroup(
    "GROUP",
    group,
    consumer,
    "COUNT",
    count,
    "BLOCK",
    blockMs,
    "STREAMS",
    key,
    ">",
  )) as [string, [string, string[]][]][] | null;

  if (!res) return [];
  const entries = res[0]?.[1] ?? [];
  const out: StreamMessage<EngineEvent>[] = [];
  for (const [id, fields] of entries) {
    const raw = fieldValue(fields, FIELD);
    if (raw) out.push({ id, data: JSON.parse(raw) as EngineEvent });
  }
  return out;
}

export async function ackEvents(
  redis: Redis,
  challengeId: string,
  group: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await redis.xack(redisKeys.eventStream(challengeId), group, ...ids);
}

function fieldValue(fields: string[], key: string): string | undefined {
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] === key) return fields[i + 1];
  }
  return undefined;
}
