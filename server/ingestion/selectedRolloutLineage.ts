import { JsonlStreamParser } from "#server/ingestion/jsonlStream.ts";
import { readOpeningJsonlWindow } from "#server/ingestion/reverseJsonl.ts";
import { rolloutRefFromSource } from "#server/ingestion/rolloutIdentity.ts";
import {
  resolveRolloutLineage,
  type ResolvedRolloutLineage,
} from "#server/ingestion/rolloutLineage.ts";
import { openRollout, type SeekableRollout } from "#server/ingestion/rolloutStream.ts";
import { parseSessionMetaBytes } from "#server/ingestion/sessionMetaPrefix.ts";
import type { RolloutRef } from "#shared/types/conversation.ts";
export interface SelectedLineageOptions {
  open?: (ref: RolloutRef, signal?: AbortSignal) => Promise<SeekableRollout>;
  maxSegments?: number;
  maxBoundaryBytes?: number;
  prepareCompressedAncestors?: boolean;
}
/** Known catalog/source references only, missing ancestry stays unresolved */
export async function resolveSelectedRolloutLineage(
  ref: RolloutRef,
  known: readonly RolloutRef[],
  signal?: AbortSignal,
  options: SelectedLineageOptions = {},
): Promise<ResolvedRolloutLineage> {
  const open = options.open ?? openRollout;
  let remaining = options.maxSegments ?? 16;
  const observed = new Map<string, RolloutRef>();
  async function metadata(candidate: RolloutRef): Promise<RolloutRef> {
    signal?.throwIfAborted();
    const lease = await open(candidate, signal);
    try {
      const window = await readOpeningJsonlWindow(lease, 64 * 1024, signal);
      const first = window.records[0];
      if (!first) {
        throw new Error("rollout.metadata_unavailable");
      }
      const parsed = parseSessionMetaBytes(
        lease.ref.sourcePath,
        Buffer.from(first.raw + "\n"),
      ).meta;
      if (
        !parsed ||
        (!candidate.stableThreadId.startsWith("path:") && parsed.id !== candidate.stableThreadId)
      ) {
        throw new Error("rollout.identity_mismatch");
      }
      await lease.verify(signal);
      const source = {
        ...rolloutRefFromSource(lease.ref.sourcePath, parsed, candidate.codexHomeId),
        physicalRolloutId: candidate.physicalRolloutId ?? parsed.id,
      };
      observed.set(source.physicalRolloutId, source);
      return source;
    } finally {
      await lease.close();
    }
  }
  const current = await metadata(ref);
  return resolveRolloutLineage(
    current,
    {
      async resolve(physical, resolveSignal) {
        resolveSignal?.throwIfAborted();
        remaining -= 1;
        if (remaining < 1) {
          return null;
        }
        const cached = observed.get(physical);
        if (cached) {
          return cached;
        }
        const matches = known.filter(
          (source) =>
            source.physicalRolloutId === physical && source.codexHomeId === current.codexHomeId,
        );
        const plain = matches.filter((source) => source.representation === "plain-jsonl");
        const choices = plain.length ? plain : matches;
        if (choices.length !== 1) {
          return null;
        }
        const selected = choices[0]!;
        return selected.representation === "zstd-jsonl" &&
          options.prepareCompressedAncestors !== true
          ? selected
          : metadata(selected);
      },
      async validateBoundary(source, bound, boundarySignal) {
        if (source.representation === "zstd-jsonl" && options.prepareCompressedAncestors !== true) {
          return false;
        }
        const byteBudget =
          options.maxBoundaryBytes ??
          (options.prepareCompressedAncestors === true ? 2 * 1024 ** 3 : 256 * 1024);
        if (bound.endByteOffset > byteBudget) {
          return false;
        }
        const lease = await open(source, boundarySignal);
        try {
          if (bound.endByteOffset > lease.size) {
            return false;
          }
          let nextOrdinal = source.historyBase?.endOrdinalExclusive ?? 0;
          let lastByte = 0;
          const parser = new JsonlStreamParser({
            maxRecordBytes: 1024 * 1024,
            onRecord(record) {
              nextOrdinal += 1;
              lastByte = record.byteEnd;
            },
            onError() {
              throw new Error("rollout.invalid_boundary_record");
            },
          });
          for (let offset = 0; offset < bound.endByteOffset; offset += 64 * 1024) {
            boundarySignal?.throwIfAborted();
            // oxlint-disable-next-line no-await-in-loop -- Explicit boundary preparation counts original records in bounded sequential chunks
            const bytes = await lease.read(
              offset,
              Math.min(bound.endByteOffset, offset + 64 * 1024),
              boundarySignal,
            );
            parser.write(bytes, offset);
          }
          await lease.verify(boundarySignal);
          return (
            parser.finish().pending.length === 0 &&
            lastByte === bound.endByteOffset &&
            nextOrdinal === bound.endOrdinalExclusive
          );
        } finally {
          await lease.close();
        }
      },
    },
    signal,
  );
}
