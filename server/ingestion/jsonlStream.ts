import { jsonValueSchema, type JsonValue } from "../../shared/types/conversation.ts";
import {
  stableRead,
  type ExpectedSourcePrefix,
  type StableReadChunk,
  type StableReadResult,
} from "./stableRead.ts";

export interface JsonlRecord {
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
  state?: JsonlParserState | undefined;
  onRecord?: ((record: JsonlRecord) => void) | undefined;
  onError?: ((error: JsonlParseError) => void) | undefined;
}

export interface ReadStableJsonlOptions {
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
  readonly #onRecord: ((record: JsonlRecord) => void) | undefined;
  readonly #onError: ((error: JsonlParseError) => void) | undefined;
  #state: JsonlParserState;

  constructor(options: JsonlStreamParserOptions = {}) {
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

      if (line.byteLength > 0) {
        const raw = line.toString("utf8");
        try {
          const value = jsonValueSchema.parse(JSON.parse(raw));
          this.#onRecord?.({
            lineNumber: this.#state.nextLineNumber,
            byteStart,
            byteEnd,
            raw,
            value,
          });
        } catch {
          this.#onError?.({
            lineNumber: this.#state.nextLineNumber,
            byteStart,
            byteEnd,
            reason: "invalid-json",
          });
        }
      }

      this.#state.nextLineNumber += 1;
      lineStart = newline + 1;
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
    onRecord: (record) => records.push(record),
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
