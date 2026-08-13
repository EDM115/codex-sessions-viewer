import type { BigIntStats } from "node:fs";
import { open, stat } from "node:fs/promises";

const DEFAULT_CHUNK_SIZE = 64 * 1024;

export interface StableReadChunk {
  bytes: Uint8Array;
  offset: number;
}

export interface SourceIdentity {
  device: bigint;
  inode: bigint;
}

export interface ExpectedSourcePrefix {
  offset: number;
  bytes: Uint8Array;
}

export interface StableReadOptions {
  start?: number | undefined;
  endExclusive?: number | undefined;
  chunkSize?: number | undefined;
  expectedPrefix?: ExpectedSourcePrefix | undefined;
  onChunk?: ((chunk: StableReadChunk) => Promise<void> | void) | undefined;
}

export interface StableReadSuccess {
  status: "stable";
  bytesRead: number;
  start: number;
  endExclusive: number;
  identity: SourceIdentity;
  size: number;
  mtimeMs: number;
}

export interface StableReadChanged {
  status: "changed";
  retry: true;
  bytesRead: number;
}

export interface StableReadFullReparse {
  status: "full-reparse";
  reason: "prefix-mismatch" | "replaced" | "truncated";
  bytesRead: number;
}

export type StableReadResult = StableReadSuccess | StableReadChanged | StableReadFullReparse;

export interface JsonlTailPartition {
  complete: Buffer;
  pending: Buffer;
}

export interface StableBytesResult {
  read: StableReadResult;
  bytes: Buffer;
}

interface ObservedFile {
  device: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function observe(stats: BigIntStats): ObservedFile {
  return {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameIdentity(left: ObservedFile, right: ObservedFile): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameObservation(left: ObservedFile, right: ObservedFile): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function validateRange(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function changedOrReplaced(
  before: ObservedFile,
  after: ObservedFile,
  bytesRead: number,
): StableReadChanged | StableReadFullReparse {
  return sameIdentity(before, after)
    ? { status: "changed", retry: true, bytesRead }
    : { status: "full-reparse", reason: "replaced", bytesRead };
}

export async function stableRead(
  path: string,
  options: StableReadOptions = {},
): Promise<StableReadResult> {
  const start = options.start ?? 0;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  validateRange(start, "start");
  validateRange(chunkSize, "chunkSize");
  if (chunkSize === 0) {
    throw new RangeError("chunkSize must be greater than zero");
  }
  if (options.endExclusive !== undefined) {
    validateRange(options.endExclusive, "endExclusive");
    if (options.endExclusive < start) {
      throw new RangeError("endExclusive must not be less than start");
    }
  }
  if (options.expectedPrefix !== undefined) {
    validateRange(options.expectedPrefix.offset, "expectedPrefix.offset");
  }

  const pathBefore = observe(await stat(path, { bigint: true }));
  const handle = await open(path, "r");
  let bytesRead = 0;

  try {
    const handleBefore = observe(await handle.stat({ bigint: true }));
    if (!sameIdentity(pathBefore, handleBefore)) {
      return { status: "full-reparse", reason: "replaced", bytesRead };
    }

    const initialSize = Number(handleBefore.size);
    if (!Number.isSafeInteger(initialSize)) {
      throw new RangeError("Source file is too large to address safely");
    }
    const endExclusive = options.endExclusive ?? initialSize;
    if (start > initialSize || endExclusive > initialSize) {
      return { status: "full-reparse", reason: "truncated", bytesRead };
    }
    if (options.expectedPrefix !== undefined) {
      const expected = Buffer.from(options.expectedPrefix.bytes);
      if (options.expectedPrefix.offset + expected.byteLength > initialSize) {
        return { status: "full-reparse", reason: "truncated", bytesRead };
      }
      const observed = Buffer.allocUnsafe(expected.byteLength);
      const prefixRead = await handle.read(
        observed,
        0,
        observed.byteLength,
        options.expectedPrefix.offset,
      );
      if (prefixRead.bytesRead !== expected.byteLength) {
        return { status: "full-reparse", reason: "truncated", bytesRead };
      }
      if (!observed.equals(expected)) {
        return { status: "full-reparse", reason: "prefix-mismatch", bytesRead };
      }
    }

    let offset = start;
    while (offset < endExclusive) {
      const requested = Math.min(chunkSize, endExclusive - offset);
      const buffer = Buffer.allocUnsafe(requested);
      // oxlint-disable-next-line no-await-in-loop -- Positional chunks must be consumed in source order.
      const read = await handle.read(buffer, 0, requested, offset);
      if (read.bytesRead === 0) {
        return { status: "full-reparse", reason: "truncated", bytesRead };
      }
      const bytes = buffer.subarray(0, read.bytesRead);
      // oxlint-disable-next-line no-await-in-loop -- Backpressure keeps parser and hashing consumers ordered.
      await options.onChunk?.({ bytes, offset });
      offset += read.bytesRead;
      bytesRead += read.bytesRead;
    }

    const handleAfter = observe(await handle.stat({ bigint: true }));
    let pathAfter: ObservedFile;
    try {
      pathAfter = observe(await stat(path, { bigint: true }));
    } catch {
      return { status: "full-reparse", reason: "replaced", bytesRead };
    }

    if (!sameObservation(handleBefore, handleAfter)) {
      return changedOrReplaced(handleBefore, handleAfter, bytesRead);
    }
    if (!sameObservation(handleAfter, pathAfter)) {
      return changedOrReplaced(handleAfter, pathAfter, bytesRead);
    }

    return {
      status: "stable",
      bytesRead,
      start,
      endExclusive,
      identity: { device: handleAfter.device, inode: handleAfter.inode },
      size: initialSize,
      mtimeMs: Number(handleAfter.mtimeNs) / 1_000_000,
    };
  } finally {
    await handle.close();
  }
}

export function partitionJsonlTail(bytes: Uint8Array): JsonlTailPartition {
  const buffer = Buffer.from(bytes);
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    return { complete: Buffer.alloc(0), pending: buffer };
  }

  return {
    complete: Buffer.from(buffer.subarray(0, lastNewline + 1)),
    pending: Buffer.from(buffer.subarray(lastNewline + 1)),
  };
}

export async function readStableBytes(
  path: string,
  options: Omit<StableReadOptions, "onChunk"> = {},
): Promise<StableBytesResult> {
  const chunks: Buffer[] = [];
  const read = await stableRead(path, {
    ...options,
    onChunk({ bytes }) {
      chunks.push(Buffer.from(bytes));
    },
  });

  return {
    read,
    bytes: read.status === "stable" ? Buffer.concat(chunks) : Buffer.alloc(0),
  };
}
