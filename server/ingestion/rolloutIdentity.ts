import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";

import type { JsonlRecord } from "#server/ingestion/jsonlStream.ts";
import type { SessionMetaPrefix } from "#server/ingestion/sessionMetaPrefix.ts";
import type { RawEventIdentity, RolloutRef } from "#shared/types/conversation.ts";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const filename = new RegExp(
  `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${uuid})(?:_(${uuid}))?\\.jsonl(\\.zst)?$`,
  "iu",
);
export function parseRolloutFilename(
  path: string,
): Pick<RolloutRef, "stableThreadId" | "physicalRolloutId" | "representation"> | null {
  const match = filename.exec(basename(path));
  return match === null
    ? null
    : {
        stableThreadId: match[1]!,
        physicalRolloutId: match[2] ?? match[1]!,
        representation: match[3] === undefined ? "plain-jsonl" : "zstd-jsonl",
      };
}
export function sourceHomeIdentity(path: string): string {
  return createHash("sha256").update(sourceHomePath(path)).digest("hex");
}
export function sourceHomePath(path: string): string {
  const absolute = resolve(path);
  const marker = /[\\/](?:archived_sessions|sessions)[\\/]/u.exec(absolute);
  return marker === null ? dirname(absolute) : absolute.slice(0, marker.index);
}
export function sameObservedItem(
  raw: RawEventIdentity,
  native: Pick<RawEventIdentity, "codexHomeId" | "physicalRolloutId" | "correlationKeys">,
): boolean {
  return (
    raw.codexHomeId === native.codexHomeId &&
    raw.physicalRolloutId === native.physicalRolloutId &&
    raw.correlationKeys.some(
      (key) => key.startsWith("item:") && native.correlationKeys.includes(key),
    )
  );
}
export function rolloutRefFromSource(
  path: string,
  meta: SessionMetaPrefix | null,
  codexHomeId = sourceHomeIdentity(path),
): RolloutRef {
  const discovered = parseRolloutFilename(path);
  return {
    codexHomeId,
    stableThreadId: meta?.id ?? discovered?.stableThreadId ?? `path:${resolve(path)}`,
    physicalRolloutId:
      discovered?.physicalRolloutId ?? meta?.id ?? `path:${resolve(path).replace(/\.zst$/u, "")}`,
    rootSessionId: meta?.rootSessionId ?? null,
    sourcePath: path,
    representation: path.endsWith(".jsonl.zst")
      ? "zstd-jsonl"
      : path.endsWith(".jsonl")
        ? "plain-jsonl"
        : "unsupported",
    historyBase: meta?.historyBase ?? null,
    subagentHistoryStartOrdinal: meta?.subagentHistoryStartOrdinal ?? null,
    forkedFromId: meta?.forkedFromId ?? null,
    forkedFromOrdinalExclusive: meta?.forkedFromOrdinalExclusive ?? null,
    parentThreadId: meta?.parentThreadId ?? null,
    attachedThread: meta?.attachedThread ?? null,
    historyMode: meta?.historyMode ?? null,
  };
}
export function qualifyRawRecord(record: JsonlRecord, ref: RolloutRef): JsonlRecord {
  if (record.identity !== undefined) {
    return record;
  }
  const value = record.value;
  const payload =
    value !== null && typeof value === "object" && !Array.isArray(value) ? value["payload"] : null;
  const object =
    payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const correlationKeys = [
    ["id", "item"],
    ["item_id", "item"],
    ["call_id", "call"],
    ["cell_id", "cell"],
  ].flatMap(([field, kind]) => {
    const correlation = object[field!];
    return typeof correlation === "string" ? [`${kind}:${correlation}`] : [];
  });
  const identity: RawEventIdentity = {
    codexHomeId: ref.codexHomeId,
    physicalRolloutId: ref.physicalRolloutId ?? `path:${resolve(ref.sourcePath)}`,
    ordinal: record.ordinal ?? null,
    decodedByteStart: record.byteStart,
    decodedByteEnd: record.byteEnd,
    rangeSha256: record.rangeSha256 ?? createHash("sha256").update(record.raw).digest("hex"),
    correlationKeys: [...new Set(correlationKeys)],
  };
  return { ...record, identity };
}
export function rawRecordIdentity(record: JsonlRecord): string {
  if (record.rawEventId !== undefined) {
    return record.rawEventId;
  }
  const identity = record.identity;
  const parts =
    identity === undefined
      ? ["unscoped", record.byteStart, createHash("sha256").update(record.raw).digest("hex")]
      : [
          identity.codexHomeId,
          identity.physicalRolloutId,
          identity.ordinal === null
            ? `byte:${identity.decodedByteStart}`
            : `ordinal:${identity.ordinal}`,
          identity.rangeSha256,
        ];
  return `raw-v2-${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}
