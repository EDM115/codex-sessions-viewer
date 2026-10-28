import { createHash, randomUUID } from "node:crypto";

import type { JsonValue, RolloutRef, SourceGeneration } from "../../shared/types/conversation.ts";
import type { JsonlRecord } from "../ingestion/jsonlStream.ts";
import type { JsonlWindow } from "../ingestion/reverseJsonl.ts";

export interface LegacyTurnWindowIdentity {
  id: string;
  physical: string;
  epoch: string;
  anchor: JsonlRecord;
  start: number;
  end: number;
  boundary: JsonlRecord | null;
  aliases: string[];
  proofs: SourceGeneration["verifiedDecodedRanges"];
  clean: boolean;
}
function object(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
export function stableRecordKey(ref: RolloutRef, record: JsonlRecord): string {
  return `raw-item-${createHash("sha256")
    .update(JSON.stringify([ref.codexHomeId, ref.physicalRolloutId, record.byteStart, record.raw]))
    .digest("hex")}`;
}
export function isLegacyPrompt(record: JsonlRecord): boolean {
  const value = object(record.value);
  return value?.["type"] === "event_msg" && object(value["payload"])?.["type"] === "user_message";
}
function unnamed(record: JsonlRecord): boolean {
  const value = object(record.value);
  const payload = object(value?.["payload"]);
  return (
    payload !== null &&
    typeof payload["turn_id"] !== "string" &&
    (value?.["type"] === "response_item" ||
      (value?.["type"] === "event_msg" &&
        ["agent_message", "user_message", "agent_reasoning"].includes(
          typeof payload["type"] === "string" ? payload["type"] : "",
        )))
  );
}
export function legacyWindowOverlap(
  ref: RolloutRef,
  window: LegacyTurnWindowIdentity,
  records: readonly JsonlRecord[],
): boolean {
  return records.some(
    (record) =>
      record.byteStart === window.anchor.byteStart &&
      stableRecordKey(ref, record) === stableRecordKey(ref, window.anchor),
  );
}
/** Keep a bounded digest cover, not every overlapping range from every refresh */
export function coverLegacyWindow(
  ranges: SourceGeneration["verifiedDecodedRanges"],
  start: number,
  end: number,
): SourceGeneration["verifiedDecodedRanges"] | null {
  const cover: SourceGeneration["verifiedDecodedRanges"] = [];
  let position = start;
  while (position < end) {
    const next = ranges
      .filter((range) => range.start <= position && range.endExclusive > position)
      .toSorted((left, right) => right.endExclusive - left.endExclusive)[0];
    if (!next) {
      return null;
    }
    cover.push(next);
    position = next.endExclusive;
  }
  return cover;
}
export function planLegacyWindow(
  ref: RolloutRef,
  epoch: string,
  windows: readonly JsonlWindow[],
  previous: LegacyTurnWindowIdentity | null,
  ranges: SourceGeneration["verifiedDecodedRanges"],
  requested = false,
): LegacyTurnWindowIdentity | null {
  const records = [
    ...new Map(
      windows.flatMap((window) => window.records).map((record) => [record.byteStart, record]),
    ).values(),
  ].toSorted((left, right) => left.byteStart - right.byteStart);
  const last = records.findLast(unnamed);
  if (!last && !previous) {
    return null;
  }
  const prompt = records.findLast(
    (record) =>
      isLegacyPrompt(record) &&
      record.byteStart <=
        (requested ? (previous?.anchor.byteStart ?? Infinity) : (last?.byteStart ?? Infinity)),
  );
  const namedStart = records.findLast((record) => {
    const payload = object(object(record.value)?.["payload"]);
    return (
      typeof payload?.["turn_id"] === "string" &&
      ["turn_started", "task_started"].includes(
        typeof payload["type"] === "string" ? payload["type"] : "",
      )
    );
  });
  if (
    !requested &&
    namedStart &&
    namedStart.byteStart >= (prompt?.byteStart ?? -1) &&
    namedStart.byteStart <= (last?.byteStart ?? Infinity)
  ) {
    return null;
  }
  if (!requested && previous && prompt && prompt.byteStart > previous.anchor.byteStart) {
    previous = null;
  }
  const intervals = [
    ...windows.flatMap((window) =>
      window.records.length
        ? [{ start: window.records[0]!.byteStart, end: window.records.at(-1)!.byteEnd }]
        : [],
    ),
    ...(previous ? [{ start: previous.start, end: previous.end }] : []),
  ].toSorted((left, right) => left.start - right.start);
  const components: { start: number; end: number }[] = [];
  for (const interval of intervals) {
    const tail = components.at(-1);
    if (tail && interval.start <= tail.end) {
      tail.end = Math.max(tail.end, interval.end);
    } else {
      components.push({ ...interval });
    }
  }
  const anchor = requested ? previous!.anchor : (last ?? previous!.anchor);
  const component = components.find(
    (interval) => interval.start <= anchor.byteStart && interval.end >= anchor.byteEnd,
  );
  if (!component) {
    return null;
  }
  const candidate =
    previous?.boundary ??
    (prompt && prompt.byteStart >= component.start && prompt.byteEnd <= anchor.byteEnd
      ? prompt
      : null);
  const start = candidate?.byteStart ?? component.start;
  const proof = coverLegacyWindow(ranges, start, component.end);
  const clean =
    (previous?.clean ?? true) &&
    windows.every((window) => window.errors.length === 0) &&
    proof !== null;
  const boundary = clean ? candidate : null;
  const id =
    previous?.id ??
    (boundary ? `raw-turn-${stableRecordKey(ref, boundary)}` : `legacy-window-${randomUUID()}`);
  const sourceKey = boundary ? `raw-turn-${stableRecordKey(ref, boundary)}` : null;
  return {
    id,
    physical: ref.physicalRolloutId!,
    epoch,
    anchor,
    start,
    end: component.end,
    boundary,
    aliases: [
      ...new Set([
        ...(previous?.aliases ?? []),
        ...(sourceKey && sourceKey !== id ? [sourceKey] : []),
      ]),
    ],
    proofs: proof ?? [],
    clean,
  };
}
