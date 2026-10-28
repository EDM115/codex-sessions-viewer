import { createHash } from "node:crypto";

import { jsonValueSchema } from "../../shared/types/conversation.ts";
import type { JsonlRecord } from "./jsonlStream.ts";
import type { SeekableRollout } from "./rolloutStream.ts";
export interface JsonlWindowOptions {
  endExclusive: number;
  maxBytes?: number;
  maxRecords?: number;
  blockBytes?: number;
  ordinalOrigin?: number;
  stop?: (record: JsonlRecord, recordsRead: number) => boolean;
}
export interface JsonlWindow {
  records: JsonlRecord[];
  unfinishedFinalRecord: boolean;
  scannedStart: number;
  nextEndExclusive: number;
  reachedStart: boolean;
  budgetExceeded: boolean;
  errors: { byteStart: number; byteEnd: number; reason: string }[];
}
export async function readOpeningJsonlWindow(
  rollout: SeekableRollout,
  maxBytes = 64 * 1024,
  signal?: AbortSignal,
): Promise<JsonlWindow> {
  return readForwardJsonlWindow(rollout, { start: 0, maxBytes }, signal);
}
export async function readForwardJsonlWindow(
  rollout: SeekableRollout,
  options: { start: number; endExclusive?: number; maxBytes?: number; maxRecords?: number },
  signal?: AbortSignal,
): Promise<JsonlWindow> {
  const startOffset = options.start;
  const bound = options.endExclusive ?? rollout.size;
  const end = Math.min(bound, startOffset + (options.maxBytes ?? 512 * 1024));
  const bytes = await rollout.read(startOffset, end, signal);
  const completeEnd = end === rollout.size ? bytes.length : bytes.lastIndexOf(10) + 1;
  const records: JsonlRecord[] = [];
  const errors: JsonlWindow["errors"] = [];
  let start = 0;
  let unfinishedFinalRecord = false;
  let ordinal = rollout.ref.historyBase?.endOrdinalExclusive ?? 0;
  while (start < completeEnd && records.length < (options.maxRecords ?? 10000)) {
    const newline = bytes.indexOf(10, start);
    const lineEnd = newline === -1 ? completeEnd : newline + 1;
    const physical = bytes.subarray(start, lineEnd);
    const content = physical.at(-1) === 10 ? physical.subarray(0, -1) : physical;
    try {
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(
        content.at(-1) === 13 ? content.subarray(0, -1) : content,
      );
      records.push({
        byteStart: startOffset + start,
        byteEnd: startOffset + lineEnd,
        lineNumber: startOffset === 0 ? records.length + 1 : 0,
        ...(startOffset === 0 ? { ordinal } : {}),
        raw,
        value: jsonValueSchema.parse(JSON.parse(raw)),
        rangeSha256: createHash("sha256").update(physical).digest("hex"),
      });
    } catch {
      if (newline === -1 && startOffset + lineEnd === rollout.size) {
        unfinishedFinalRecord = true;
      } else {
        errors.push({
          byteStart: startOffset + start,
          byteEnd: startOffset + lineEnd,
          reason: "invalid-json-or-utf8",
        });
      }
    }
    ordinal += 1;
    start = lineEnd;
  }
  return {
    records,
    errors,
    unfinishedFinalRecord,
    scannedStart: startOffset,
    nextEndExclusive: startOffset + start,
    reachedStart: startOffset === 0,
    budgetExceeded: startOffset + start < bound,
  };
}
export async function readJsonlWindow(
  rollout: SeekableRollout,
  options: JsonlWindowOptions,
  signal?: AbortSignal,
): Promise<JsonlWindow> {
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const maxRecords = options.maxRecords ?? 1000;
  const blockBytes = options.blockBytes ?? 64 * 1024;
  for (const value of [options.endExclusive, maxBytes, maxRecords, blockBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("Invalid reverse window budget");
    }
  }
  if (
    maxBytes === 0 ||
    maxRecords === 0 ||
    blockBytes === 0 ||
    options.endExclusive > rollout.size
  ) {
    throw new RangeError("Invalid reverse window boundary");
  }
  const records: JsonlRecord[] = [];
  const errors: JsonlWindow["errors"] = [];
  let pending = Buffer.alloc(0);
  let cursor = options.endExclusive;
  let right = options.endExclusive;
  let readBytes = 0;
  let unfinishedFinalRecord = false;
  let stopped = false;
  while (cursor > 0 && readBytes < maxBytes && !stopped) {
    signal?.throwIfAborted();
    const start = Math.max(0, cursor - Math.min(blockBytes, maxBytes - readBytes));
    // oxlint-disable-next-line no-await-in-loop -- Reverse blocks depend on the remaining partial record
    const block = await rollout.read(start, cursor, signal);
    readBytes += block.length;
    pending = Buffer.concat([block, pending]);
    cursor = start;
    while (pending.length > 0) {
      const terminated = pending.at(-1) === 10;
      const preceding = pending.lastIndexOf(10, pending.length - (terminated ? 2 : 1));
      if (preceding < 0 && cursor > 0) {
        break;
      }
      const localStart = preceding + 1;
      const physical = pending.subarray(localStart);
      const byteStart = cursor + localStart;
      const byteEnd = right;
      const content = terminated ? physical.subarray(0, -1) : physical;
      const line = content.at(-1) === 13 ? content.subarray(0, -1) : content;
      try {
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(line);
        const value = jsonValueSchema.parse(JSON.parse(raw));
        const record: JsonlRecord = {
          lineNumber: 0,
          byteStart,
          byteEnd,
          raw,
          value,
          rangeSha256: createHash("sha256").update(physical).digest("hex"),
        };
        records.push(record);
        stopped = records.length >= maxRecords || options.stop?.(record, records.length) === true;
      } catch {
        if (!terminated && byteEnd === rollout.size) {
          unfinishedFinalRecord = true;
        } else {
          errors.push({ byteStart, byteEnd, reason: "invalid-json-or-utf8" });
        }
      }
      pending = pending.subarray(0, localStart);
      right = byteStart;
      if (stopped) {
        break;
      }
    }
  }
  const reachedStart = right === 0;
  records.reverse();
  if (reachedStart && errors.length === 0) {
    const origin = options.ordinalOrigin ?? rollout.ref.historyBase?.endOrdinalExclusive ?? 0;
    for (const [index, record] of records.entries()) {
      record.ordinal = origin + index;
      record.lineNumber = index + 1;
    }
  }
  return {
    records,
    unfinishedFinalRecord,
    scannedStart: cursor,
    nextEndExclusive: right,
    reachedStart,
    budgetExceeded: !stopped && !reachedStart && readBytes >= maxBytes,
    errors,
  };
}
