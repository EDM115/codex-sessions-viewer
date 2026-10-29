import { createHash } from "node:crypto";

import {
  stableRead,
  type ExpectedSourcePrefix,
  type StableReadChunk,
  type StableReadResult,
} from "#server/ingestion/stableRead.ts";
import {
  jsonValueSchema,
  type JsonValue,
  type RawEventIdentity,
} from "#shared/types/conversation.ts";
import type { LogicalVisibility } from "#shared/types/history.ts";

export interface JsonlRecord {
  logicalVisibility?: LogicalVisibility;
  rangeSha256?: string;
  identity?: RawEventIdentity;
  ordinal?: number;
  rawEventId?: string;
  contextOnly?: boolean;
  logicalOrder?: number;
  lineNumber: number;
  byteStart: number;
  byteEnd: number;
  raw: string;
  value: JsonValue;
}

export interface JsonlParseError {
  lineNumber: number;
  byteStart: number;
  byteEnd: number;
  reason: "invalid-json";
}

export interface JsonlParserState {
  pending: Buffer;
  pendingStart: number;
  nextLineNumber: number;
  nextOffset: number;
}

export interface JsonlStreamParserOptions {
  maxRecordBytes?: number;
  state?: JsonlParserState | undefined;
  onRecord?: ((record: JsonlRecord) => void) | undefined;
  onError?: ((error: JsonlParseError) => void) | undefined;
}

export interface ReadStableJsonlOptions {
  retainRecords?: boolean;
  onRecord?: (record: JsonlRecord) => void;
  maxRecordBytes?: number;
  start?: number | undefined;
  chunkSize?: number | undefined;
  expectedPrefix?: ExpectedSourcePrefix | undefined;
  state?: JsonlParserState | undefined;
  afterChunk?: ((chunk: StableReadChunk) => Promise<void> | void) | undefined;
}

export interface StableJsonlResult {
  read: StableReadResult;
  records: JsonlRecord[];
  errors: JsonlParseError[];
  state: JsonlParserState;
}

function initialState(offset = 0): JsonlParserState {
  return {
    pending: Buffer.alloc(0),
    pendingStart: offset,
    nextLineNumber: 1,
    nextOffset: offset,
  };
}

function copyState(state: JsonlParserState): JsonlParserState {
  return { ...state, pending: Buffer.from(state.pending) };
}

export class JsonlStreamParser {
  readonly #maxRecordBytes: number;
  readonly #onRecord: ((record: JsonlRecord) => void) | undefined;
  readonly #onError: ((error: JsonlParseError) => void) | undefined;
  #state: JsonlParserState;

  constructor(options: JsonlStreamParserOptions = {}) {
    this.#maxRecordBytes = options.maxRecordBytes ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(this.#maxRecordBytes) || this.#maxRecordBytes < 1) {
      throw new RangeError("Invalid record byte budget");
    }
    this.#state = copyState(options.state ?? initialState());
    this.#onRecord = options.onRecord;
    this.#onError = options.onError;
  }

  write(bytes: Uint8Array, offset: number): void {
    if (offset !== this.#state.nextOffset) {
      throw new RangeError(
        `JSONL chunks must be contiguous: expected ${this.#state.nextOffset}, received ${offset}`,
      );
    }

    const chunk = Buffer.from(bytes);
    const combined =
      this.#state.pending.byteLength === 0 ? chunk : Buffer.concat([this.#state.pending, chunk]);
    const combinedStart = this.#state.pendingStart;
    let lineStart = 0;

    for (
      let newline = combined.indexOf(0x0a, lineStart);
      newline !== -1;
      newline = combined.indexOf(0x0a, lineStart)
    ) {
      const physicalLine = combined.subarray(lineStart, newline);
      const line =
        physicalLine.at(-1) === 0x0d
          ? physicalLine.subarray(0, physicalLine.byteLength - 1)
          : physicalLine;
      const byteStart = combinedStart + lineStart;
      const byteEnd = combinedStart + newline + 1;
      if (line.byteLength > this.#maxRecordBytes) {
        throw new Error("rollout.record_budget");
      }

      if (line.byteLength > 0) {
        let raw: string;
        let value: JsonValue;
        try {
          raw = new TextDecoder("utf-8", { fatal: true }).decode(line);
          value = jsonValueSchema.parse(JSON.parse(raw));
        } catch {
          this.#onError?.({
            lineNumber: this.#state.nextLineNumber,
            byteStart,
            byteEnd,
            reason: "invalid-json",
          });
          this.#state.nextLineNumber += 1;
          lineStart = newline + 1;
          continue;
        }
        this.#onRecord?.({
          rangeSha256: createHash("sha256")
            .update(combined.subarray(lineStart, newline + 1))
            .digest("hex"),
          lineNumber: this.#state.nextLineNumber,
          byteStart,
          byteEnd,
          raw,
          value,
        });
      }

      this.#state.nextLineNumber += 1;
      lineStart = newline + 1;
    }

    if (combined.length - lineStart > this.#maxRecordBytes) {
      throw new Error("rollout.record_budget");
    }
    this.#state.pending = Buffer.from(combined.subarray(lineStart));
    this.#state.pendingStart = combinedStart + lineStart;
    this.#state.nextOffset += chunk.byteLength;
  }

  finish(): JsonlParserState {
    return copyState(this.#state);
  }
}

export async function readStableJsonl(
  path: string,
  options: ReadStableJsonlOptions = {},
): Promise<StableJsonlResult> {
  const start = options.start ?? options.state?.nextOffset ?? 0;
  const originalState = copyState(options.state ?? initialState(start));
  if (originalState.nextOffset !== start) {
    throw new RangeError("The JSONL parser state must end at the requested read offset");
  }

  const records: JsonlRecord[] = [];
  const errors: JsonlParseError[] = [];
  const parser = new JsonlStreamParser({
    state: originalState,
    ...(options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes }),
    onRecord: (record) => {
      if (options.retainRecords !== false) {
        records.push(record);
      }
      options.onRecord?.(record);
    },
    onError: (error) => errors.push(error),
  });
  const read = await stableRead(path, {
    start,
    chunkSize: options.chunkSize,
    expectedPrefix: options.expectedPrefix,
    async onChunk(chunk) {
      parser.write(chunk.bytes, chunk.offset);
      await options.afterChunk?.(chunk);
    },
  });

  if (read.status !== "stable") {
    return {
      read,
      records: [],
      errors: [],
      state: read.status === "changed" ? originalState : initialState(),
    };
  }

  return { read, records, errors, state: parser.finish() };
}
