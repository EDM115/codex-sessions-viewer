import { createHash } from "node:crypto";

import { JsonlStreamParser, type JsonlRecord } from "#server/ingestion/jsonlStream.ts";
import { qualifyRawRecord, rolloutRefFromSource } from "#server/ingestion/rolloutIdentity.ts";
import {
  resolveRolloutLineage,
  type RolloutSourceResolver,
} from "#server/ingestion/rolloutLineage.ts";
import type { SeekableRollout } from "#server/ingestion/rolloutStream.ts";
import { parseSessionMetaBytes } from "#server/ingestion/sessionMetaPrefix.ts";
import { validateSourceGeneration } from "#server/ingestion/sourceGeneration.ts";
import type { RolloutRef, SourceGeneration } from "#shared/types/conversation.ts";

/** Deliberate full indexing/export only, every ancestor and exclusive cutoff is validated */
export async function readCompleteRollout(
  initial: RolloutRef,
  sources: RolloutSourceResolver,
  open: (ref: RolloutRef, signal?: AbortSignal) => Promise<SeekableRollout>,
  parserVersion: number,
  signal?: AbortSignal,
) {
  const loaded = new Map<
    string,
    { ref: RolloutRef; records: JsonlRecord[]; generation: SourceGeneration }
  >();
  async function load(candidate: RolloutRef) {
    const existing = candidate.physicalRolloutId
      ? loaded.get(candidate.physicalRolloutId)
      : undefined;
    if (existing) {
      return existing;
    }
    signal?.throwIfAborted();
    const lease = await open(candidate, signal);
    try {
      const records: JsonlRecord[] = [];
      const hash = createHash("sha256");
      const parser = new JsonlStreamParser({
        maxRecordBytes: 1024 * 1024,
        onRecord: (record) => records.push(record),
        onError: () => {
          throw new Error("history.invalid_record");
        },
      });
      for (let offset = 0; offset < lease.size; offset += 64 * 1024) {
        signal?.throwIfAborted();
        // oxlint-disable-next-line no-await-in-loop -- Full export consumes bounded contiguous reads under the selected generation lease
        const bytes = await lease.read(offset, Math.min(lease.size, offset + 64 * 1024), signal);
        hash.update(bytes);
        parser.write(bytes, offset);
      }
      if (parser.finish().pending.length || !records[0]) {
        throw new Error("history.incomplete_record");
      }
      const meta = parseSessionMetaBytes(
        lease.ref.sourcePath,
        Buffer.from(records[0].raw + "\n"),
      ).meta;
      if (!meta) {
        throw new Error("history.missing_metadata");
      }
      const parsedRef = rolloutRefFromSource(lease.ref.sourcePath, meta, candidate.codexHomeId);
      const ref = {
        ...parsedRef,
        physicalRolloutId:
          candidate.physicalRolloutId && !candidate.physicalRolloutId.startsWith("path:")
            ? candidate.physicalRolloutId
            : parsedRef.physicalRolloutId,
      };
      if (
        !candidate.stableThreadId.startsWith("path:") &&
        candidate.stableThreadId !== ref.stableThreadId
      ) {
        throw new Error("history.source_identity_mismatch");
      }
      let generation = await lease.verify(signal);
      const decodedSha256 = hash.digest("hex");
      if (ref.representation === "plain-jsonl") {
        generation = (await validateSourceGeneration(ref, null, signal, { parserVersion }))
          .generation;
      }
      if (generation.decodedSha256 !== decodedSha256 || generation.decodedSize !== lease.size) {
        throw new Error("history.source_changed");
      }
      generation = { ...generation, physicalRolloutId: ref.physicalRolloutId!, parserVersion };
      const start = ref.historyBase?.endOrdinalExclusive ?? 0;
      const value = {
        ref,
        generation,
        records: records.map((record, index) =>
          qualifyRawRecord({ ...record, ordinal: start + index }, ref),
        ),
      };
      loaded.set(ref.physicalRolloutId!, value);
      return value;
    } finally {
      await lease.close();
    }
  }
  const current = await load(initial);
  const lineage = await resolveRolloutLineage(
    current.ref,
    {
      async resolve(physical, resolveSignal) {
        const ref = await sources.resolve(physical, resolveSignal);
        return ref ? (await load(ref)).ref : null;
      },
      async validateBoundary(ref, bound) {
        const value = await load(ref);
        return (
          value.records.find((record) => record.ordinal === bound.endOrdinalExclusive - 1)
            ?.byteEnd === bound.endByteOffset
        );
      },
    },
    signal,
  );
  if (lineage.status !== "complete") {
    throw new Error(
      `history.incomplete_lineage:${lineage.diagnostics.map(({ code }) => code).join(",")}`,
    );
  }
  const records = lineage.segments
    .flatMap((segment) =>
      loaded
        .get(segment.ref.physicalRolloutId!)!
        .records.filter(
          (record) =>
            segment.endOrdinalExclusive === null ||
            (record.ordinal! < segment.endOrdinalExclusive &&
              record.byteEnd <= segment.endByteOffset!),
        )
        .map((record, index) => ({
          ...record,
          contextOnly:
            index === 0
              ? segment.ref.physicalRolloutId !== current.ref.physicalRolloutId
              : record.ordinal! < segment.displayStartOrdinal,
        })),
    )
    .map((record, logicalOrder) => ({ ...record, logicalOrder }));
  const dependencies = lineage.segments
    .filter((segment) => segment.ref.physicalRolloutId !== current.ref.physicalRolloutId)
    .map((segment) => ({
      ref: segment.ref,
      encodedSha256: loaded.get(segment.ref.physicalRolloutId!)!.generation.encodedSha256!,
    }));
  return {
    ref: current.ref,
    records,
    generation: current.generation,
    dependencies,
    historyEpoch: lineage.historyEpoch,
    lineage,
    segments: lineage.segments.map((segment) => ({
      segment,
      ...loaded.get(segment.ref.physicalRolloutId!)!,
    })),
  };
}
