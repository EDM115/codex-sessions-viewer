import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  rolloutRefSchema,
  type RolloutHistoryBase,
  type RolloutRef,
  type SourceGeneration,
} from "../../shared/types/conversation.ts";
import { discoverSources } from "./discoverSources.ts";
import { readStableJsonl, type JsonlRecord } from "./jsonlStream.ts";
import {
  qualifyRawRecord,
  parseRolloutFilename,
  rolloutRefFromSource,
  sourceHomePath,
} from "./rolloutIdentity.ts";
import {
  readSessionMetaPrefix,
  CATALOG_METADATA_MAX_BYTES,
  parseSessionMetaBytes,
} from "./sessionMetaPrefix.ts";
import { validateSourceGeneration, type GenerationValidationOptions } from "./sourceGeneration.ts";

export interface RolloutSourceResolver {
  resolve(physicalRolloutId: string, signal?: AbortSignal): Promise<RolloutRef | null>;
  validateBoundary?(
    ref: RolloutRef,
    bound: RolloutHistoryBase,
    signal?: AbortSignal,
  ): Promise<boolean>;
}
export interface ResolvedRolloutSegment {
  ref: RolloutRef;
  bodyStartOrdinal: number;
  endOrdinalExclusive: number | null;
  endByteOffset: number | null;
  displayStartOrdinal: number;
}
export interface ResolvedRolloutLineage {
  status: "complete" | "unresolved";
  segments: ResolvedRolloutSegment[];
  diagnostics: { code: string; physicalRolloutId: string | null }[];
  historyEpoch: string;
}
export function filesystemRolloutResolver(ref: RolloutRef): RolloutSourceResolver {
  return {
    async resolve(physicalRolloutId, signal) {
      signal?.throwIfAborted();
      const discovered = await discoverSources(sourceHomePath(ref.sourcePath));
      const candidates = discovered.rollouts.filter(
        (source) => parseRolloutFilename(source.path)?.physicalRolloutId === physicalRolloutId,
      );
      const plain = candidates.filter((source) => source.path.endsWith(".jsonl"));
      const choices = plain.length > 0 ? plain : candidates;
      if (choices.length !== 1) {
        return null;
      }
      const path = choices[0]!.path;
      if (path.endsWith(".jsonl.zst")) {
        return rolloutRefFromSource(path, null, ref.codexHomeId);
      }
      const prefix = await readSessionMetaPrefix(path, CATALOG_METADATA_MAX_BYTES);
      return prefix.status === "found"
        ? rolloutRefFromSource(path, prefix.meta, ref.codexHomeId)
        : null;
    },
  };
}
export async function resolveRolloutLineage(
  ref: RolloutRef,
  sources: RolloutSourceResolver,
  signal?: AbortSignal,
): Promise<ResolvedRolloutLineage> {
  const segments: ResolvedRolloutSegment[] = [];
  const diagnostics: ResolvedRolloutLineage["diagnostics"] = [];
  const seen = new Set<string>();
  let current: RolloutRef | null = rolloutRefSchema.parse(ref);
  let bound: RolloutHistoryBase | null = null;
  while (current !== null) {
    signal?.throwIfAborted();
    const id = current.physicalRolloutId;
    if (id === null || seen.has(id)) {
      diagnostics.push({
        code: id === null ? "lineage.unknown_physical_id" : "lineage.cycle",
        physicalRolloutId: id,
      });
      break;
    }
    seen.add(id);
    if (current.historyBase !== null && seen.has(current.historyBase.physicalRolloutId)) {
      diagnostics.push({
        code: "lineage.cycle",
        physicalRolloutId: current.historyBase.physicalRolloutId,
      });
      break;
    }
    const start = current.historyBase === null ? 1 : current.historyBase.endOrdinalExclusive + 1;
    if (
      bound !== null &&
      (bound.endOrdinalExclusive < start ||
        bound.endByteOffset === 0 ||
        sources.validateBoundary === undefined ||
        // oxlint-disable-next-line no-await-in-loop -- Each boundary belongs to the base resolved by the preceding segment
        !(await sources.validateBoundary(current, bound, signal)))
    ) {
      diagnostics.push({ code: "lineage.unverified_boundary", physicalRolloutId: id });
      break;
    }
    segments.push({
      ref: current,
      bodyStartOrdinal: start,
      endOrdinalExclusive: bound?.endOrdinalExclusive ?? null,
      endByteOffset: bound?.endByteOffset ?? null,
      displayStartOrdinal: Math.max(start, ref.subagentHistoryStartOrdinal ?? 0),
    });
    bound = current.historyBase;
    if (bound === null) {
      break;
    }
    const requestedId = bound.physicalRolloutId;
    // oxlint-disable-next-line no-await-in-loop -- Physical ancestry is a dependent walk with cycle detection
    current = await sources.resolve(requestedId, signal);
    if (current === null) {
      diagnostics.push({ code: "lineage.missing_base", physicalRolloutId: requestedId });
    } else {
      current = rolloutRefSchema.parse(current);
      if (current.physicalRolloutId !== requestedId || current.codexHomeId !== ref.codexHomeId) {
        diagnostics.push({ code: "lineage.identity_mismatch", physicalRolloutId: requestedId });
        break;
      }
    }
  }
  segments.reverse();
  const historyEpoch = createHash("sha256")
    .update(
      JSON.stringify([
        ref.stableThreadId,
        ref.physicalRolloutId,
        ref.subagentHistoryStartOrdinal,
        segments.map((segment) => [
          segment.ref.physicalRolloutId,
          segment.endOrdinalExclusive,
          segment.endByteOffset,
        ]),
        "lineage-v1",
      ]),
    )
    .digest("hex");
  return {
    status: diagnostics.length === 0 ? "complete" : "unresolved",
    segments,
    diagnostics,
    historyEpoch,
  };
}

/** Compatibility reader for the existing deliberate full-normalization path */
export async function readPlainRolloutLineage(
  ref: RolloutRef,
  sources: RolloutSourceResolver,
  signal?: AbortSignal,
  options: GenerationValidationOptions = {},
): Promise<{
  records: JsonlRecord[];
  dependencies: NonNullable<SourceGeneration["dependencies"]>;
  historyEpoch: string;
  currentGeneration: SourceGeneration;
}> {
  const loaded = new Map<string, { records: JsonlRecord[]; generation: SourceGeneration }>();
  async function load(source: RolloutRef) {
    const existing = loaded.get(source.physicalRolloutId!);
    if (existing !== undefined) {
      return existing;
    }
    if (source.representation !== "plain-jsonl") {
      throw new Error("Compressed lineage requires the decoded-source reader");
    }
    const validated = await validateSourceGeneration(source, null, signal, options);
    const hash = createHash("sha256");
    const result = await readStableJsonl(source.sourcePath, {
      afterChunk({ bytes }) {
        signal?.throwIfAborted();
        hash.update(bytes);
      },
    });
    if (
      result.read.status !== "stable" ||
      result.errors.length > 0 ||
      result.state.pending.length > 0 ||
      hash.digest("hex") !== validated.generation.encodedSha256
    ) {
      throw new Error("Lineage source is incomplete or changed during validation");
    }
    const first = result.records[0]?.value;
    const payload =
      first !== null && typeof first === "object" && !Array.isArray(first)
        ? first["payload"]
        : null;
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      payload["id"] !== source.stableThreadId
    ) {
      throw new Error("Lineage stable thread identity mismatch");
    }
    const metadata = parseSessionMetaBytes(
      source.sourcePath,
      Buffer.from(result.records[0]!.raw + "\n"),
    ).meta;
    if (metadata === null) {
      throw new Error("Lineage metadata is invalid");
    }
    const observedRef = rolloutRefFromSource(source.sourcePath, metadata, source.codexHomeId);
    const metadataKeys = [
      "stableThreadId",
      "rootSessionId",
      "historyBase",
      "subagentHistoryStartOrdinal",
      "forkedFromId",
      "forkedFromOrdinalExclusive",
      "parentThreadId",
      "attachedThread",
      "historyMode",
    ] as const;
    if (
      metadataKeys.some((key) => !isDeepStrictEqual(observedRef[key] ?? null, source[key] ?? null))
    ) {
      throw new Error("Lineage metadata changed before generation validation");
    }
    const bodyStart = source.historyBase === null ? 1 : source.historyBase.endOrdinalExclusive + 1;
    if (!Number.isSafeInteger(bodyStart + result.records.length - 2)) {
      throw new RangeError("Physical rollout ordinals exceed the safe integer range");
    }
    const records = result.records.map((record, index) =>
      qualifyRawRecord(
        { ...record, ordinal: index === 0 ? bodyStart - 1 : bodyStart + index - 1 },
        source,
      ),
    );
    const value = { records, generation: validated.generation };
    loaded.set(source.physicalRolloutId!, value);
    return value;
  }
  await load(ref);
  const lineage = await resolveRolloutLineage(
    ref,
    {
      ...sources,
      async validateBoundary(source, bound) {
        const value = await load(source);
        const last = value.records.find(
          (record) => record.ordinal === bound.endOrdinalExclusive - 1,
        );
        return last !== undefined && last.byteEnd === bound.endByteOffset;
      },
    },
    signal,
  );
  if (lineage.status !== "complete") {
    throw new Error(
      `Unresolved rollout lineage: ${lineage.diagnostics.map((item) => item.code).join(", ")}`,
    );
  }
  const records = lineage.segments.flatMap((segment) =>
    loaded
      .get(segment.ref.physicalRolloutId!)!
      .records.filter(
        (record) =>
          segment.endOrdinalExclusive === null ||
          (record.ordinal! < segment.endOrdinalExclusive &&
            record.byteEnd <= segment.endByteOffset!),
      )
      .map((record) => {
        const isMeta =
          record.value !== null &&
          typeof record.value === "object" &&
          !Array.isArray(record.value) &&
          record.value["type"] === "session_meta";
        return Object.assign({}, record, {
          contextOnly: isMeta
            ? segment.ref.physicalRolloutId !== ref.physicalRolloutId
            : record.ordinal! < segment.displayStartOrdinal,
        });
      }),
  );
  const dependencies = lineage.segments
    .filter((segment) => segment.ref.physicalRolloutId !== ref.physicalRolloutId)
    .map((segment) => ({
      ref: segment.ref,
      encodedSha256: loaded.get(segment.ref.physicalRolloutId!)!.generation.encodedSha256!,
    }));
  return {
    records: records.map((record, logicalOrder) => Object.assign({}, record, { logicalOrder })),
    dependencies,
    historyEpoch: lineage.historyEpoch,
    currentGeneration: loaded.get(ref.physicalRolloutId!)!.generation,
  };
}
