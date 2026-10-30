import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createZstdDecompress } from "node:zlib";

import type { RolloutRef } from "#shared/types/conversation.ts";

export const ZSTD_DECODER_VERSION = `node-${process.versions.node}-zstd-${process.versions["zstd"]}-jsonl-v1`;
export interface DecodeLimits {
  maxDecodedBytes: number;
  maxRecordBytes: number;
  windowLogMax: number;
}
export class RolloutFramingValidator {
  #pending = Buffer.alloc(0);
  #records = 0;
  readonly ref: RolloutRef;
  readonly maxRecordBytes: number;
  constructor(ref: RolloutRef, maxRecordBytes: number) {
    this.ref = ref;
    this.maxRecordBytes = maxRecordBytes;
  }
  write(chunk: Buffer): void {
    let start = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      this.#append(chunk.subarray(start, end));
      this.#line();
      start = end + 1;
    }
    this.#append(chunk.subarray(start));
  }
  #append(bytes: Buffer): void {
    if (this.#pending.length + bytes.length > this.maxRecordBytes) {
      throw new Error("rollout.record_budget");
    }
    this.#pending = Buffer.concat([this.#pending, bytes]);
  }
  #line(): void {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(this.#pending);
    this.#pending = Buffer.alloc(0);
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value) || !("type" in value)) {
      throw new Error("rollout.unsupported_format");
    }
    if (this.#records === 0) {
      const payload = "payload" in value ? value.payload : null;
      if (
        value.type !== "session_meta" ||
        payload === null ||
        typeof payload !== "object" ||
        !("id" in payload) ||
        payload.id !== this.ref.stableThreadId
      ) {
        throw new Error("rollout.unsupported_format_or_identity");
      }
    }
    this.#records += 1;
  }
  finish(): void {
    if (this.#pending.length > 0) {
      this.#line();
    }
    if (this.#records === 0) {
      throw new Error("rollout.unsupported_format");
    }
  }
}
export async function decodeZstdRollout(
  ref: RolloutRef,
  destination: string,
  limits: DecodeLimits,
  signal: AbortSignal,
): Promise<{ encodedSha256: string; decodedSha256: string; decodedSize: number }> {
  const encoded = createHash("sha256");
  const decoded = createHash("sha256");
  const framing = new RolloutFramingValidator(ref, limits.maxRecordBytes);
  let decodedSize = 0;
  const encodedHash = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      encoded.update(chunk);
      callback(null, chunk);
    },
  });
  const decodedCheck = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        decodedSize += chunk.length;
        if (decodedSize > limits.maxDecodedBytes) {
          throw new Error("rollout.decoded_disk_budget");
        }
        framing.write(chunk);
        decoded.update(chunk);
        callback(null, chunk);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    flush(callback) {
      try {
        framing.finish();
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  await pipeline(
    createReadStream(ref.sourcePath, { highWaterMark: 64 * 1024 }),
    encodedHash,
    createZstdDecompress({
      rejectGarbageAfterEnd: true,
      chunkSize: 64 * 1024,
      params: { [constants.ZSTD_d_windowLogMax]: limits.windowLogMax },
    }),
    decodedCheck,
    createWriteStream(destination, { flags: "wx", highWaterMark: 64 * 1024 }),
    { signal },
  );
  return {
    encodedSha256: encoded.digest("hex"),
    decodedSha256: decoded.digest("hex"),
    decodedSize,
  };
}
