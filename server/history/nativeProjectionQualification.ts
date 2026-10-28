import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import * as z from "zod";

import type { SourceGeneration } from "../../shared/types/conversation.ts";
import type { HistoryItem, HistoryPage, HistoryTurnWindow } from "../../shared/types/history.ts";
import type { ResolvedRolloutLineage } from "../ingestion/rolloutLineage.ts";
import { observeSessionMetaSource } from "../ingestion/sessionMetaPrefix.ts";
import { validateSourceRanges } from "../ingestion/sourceGeneration.ts";
import { stableRead } from "../ingestion/stableRead.ts";
import { historySnapshotUnchanged } from "../metadata/historySnapshot.ts";
import { consumePreparedCanonicalWindow } from "./canonicalRolloutIndex.ts";
import type {
  HistoryEpochAuthority,
  HistoryEpochProof,
  HistoryEpochTicket,
} from "./historyEpochAuthority.ts";
import {
  decodeNativeHistoryCursor,
  nativeCursorBoundary,
  nativeCursorBoundarySchema,
  nativeLineageIdentity,
  pageCursorBoundaries,
  qualifyPageCursors,
  type NativeHistoryPageResult,
} from "./nativeHistoryReader.ts";
import { adaptCoreTurnItem, NATIVE_ITEM_ADAPTER_VERSION } from "./nativeItemAdapter.ts";

export const NATIVE_VERIFICATION_LIMITS = { bytes: 2 * 1024 * 1024, records: 10000 } as const;
const dependencySchema = z.strictObject({
  physicalRolloutId: z.string(),
  sourcePath: z.string(),
  start: z.int().nonnegative(),
  startOrdinal: z.int().nonnegative().optional(),
  anchorSha256: z.string().optional(),
  endExclusive: z.int().nonnegative(),
  sha256: z.string(),
  nextOrdinal: z.int().nonnegative(),
  endOrdinalExclusive: z.int().nonnegative().nullable(),
  semanticEpoch: z.string().nullable(),
});
export type NativeProjectionDependency = z.infer<typeof dependencySchema>;
const associationSchema = z.strictObject({
  version: z.literal(2),
  key: z.string(),
  lineageKey: z.string(),
  snapshotDigest: z.string(),
  parserVersion: z.int(),
  adapterVersion: z.int(),
  historyEpoch: z.string(),
  dependencies: z.array(dependencySchema),
  cursorBoundaries: z.array(nativeCursorBoundarySchema),
});
type VerifiedProjectionAssociation = z.infer<typeof associationSchema>;
export interface CanonicalEvidenceRange {
  preparedIndex?: object;
  physicalRolloutId: string;
  start: number;
  endExclusive: number;
  sha256: string;
  startOrdinal: number | null;
}
export interface CanonicalEvidenceProvider {
  invalidate?(): void;
  proposeRanges(
    lineage: ResolvedRolloutLineage,
    source: SourceGeneration,
    signal?: AbortSignal,
  ): Promise<readonly CanonicalEvidenceRange[] | null>;
}
export interface VerifiedProjectionStoreOptions {
  canonicalEvidence?: CanonicalEvidenceProvider;
  epochAuthority?: HistoryEpochAuthority;
}
export class VerifiedProjectionStore {
  readonly #database: DatabaseSync;
  readonly canonicalEvidence: CanonicalEvidenceProvider | undefined;
  readonly epochAuthority: HistoryEpochAuthority | undefined;
  constructor(database: DatabaseSync, options: VerifiedProjectionStoreOptions = {}) {
    this.#database = database;
    this.canonicalEvidence = options.canonicalEvidence;
    this.epochAuthority = options.epochAuthority;
  }
  get(key: string): VerifiedProjectionAssociation | null {
    return this.#parse(
      this.#database
        .prepare(
          "SELECT evidence_json FROM verified_history_projections WHERE association_key = ? LIMIT 1",
        )
        .get(key)?.["evidence_json"],
    );
  }
  latest(lineageKey: string): VerifiedProjectionAssociation | null {
    return this.#parse(
      this.#database
        .prepare(
          "SELECT evidence_json FROM verified_history_projections WHERE lineage_key = ? ORDER BY verified_at DESC, rowid DESC LIMIT 1",
        )
        .get(lineageKey)?.["evidence_json"],
    );
  }
  put(association: VerifiedProjectionAssociation): void {
    const verified = associationSchema.parse(association);
    this.#database
      .prepare(
        "INSERT OR REPLACE INTO verified_history_projections(association_key,lineage_key,evidence_json,verified_at) VALUES(?,?,?,?)",
      )
      .run(verified.key, verified.lineageKey, JSON.stringify(verified), Date.now());
  }
  #parse(value: unknown): VerifiedProjectionAssociation | null {
    if (typeof value !== "string" || value.length > 128 * 1024) {
      return null;
    }
    try {
      const result = associationSchema.safeParse(JSON.parse(value));
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }
}
export interface NativeProjectionQualification {
  status: "unavailable" | "projection-only" | "stale" | "verified-range";
  snapshotDigest: string | null;
  sourceToken: string;
  historyEpoch: string | null;
  dependencies: NativeProjectionDependency[];
  verifiedRanges: HistoryTurnWindow["loadedRanges"];
  diagnostics: string[];
  association: "established" | "reused" | null;
  page: HistoryPage | null;
}
function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function comparable(item: HistoryItem): unknown {
  const { evidence: _evidence, ...value } = item;
  return value;
}
interface CanonicalItem {
  item: HistoryItem;
  ordinal: number;
  updated: number;
}
interface CanonicalTurn {
  id: string;
  segment: number;
  ordinal: number;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  finalAnswerItemId: string | null;
  items: Map<string, CanonicalItem>;
}
interface LoadedSegment {
  metadata?: Buffer;
  bytes: Buffer;
  generation: SourceGeneration;
  dependency: NativeProjectionDependency;
}
function epochProofs(loaded: LoadedSegment[], source: SourceGeneration): HistoryEpochProof[] {
  return loaded.map((entry) => ({
    physical: entry.dependency.physicalRolloutId,
    decodedSize: entry.generation.observation.encodedSize,
    ranges: [
      {
        start: entry.dependency.start,
        endExclusive: entry.dependency.endExclusive,
        sha256: entry.dependency.sha256,
      },
      ...(entry.metadata
        ? [{ start: 0, endExclusive: entry.metadata.length, sha256: hash(entry.metadata) }]
        : []),
      ...(entry.metadata && source.physicalRolloutId === entry.dependency.physicalRolloutId
        ? source.verifiedDecodedRanges
        : []),
    ],
  }));
}
async function observePreviousEpoch(
  lineage: ResolvedRolloutLineage,
  source: SourceGeneration,
  loaded: LoadedSegment[],
  ticket: HistoryEpochTicket | undefined,
  signal?: AbortSignal,
): Promise<HistoryEpochProof[]> {
  const observed = epochProofs(loaded, source);
  let remaining =
    NATIVE_VERIFICATION_LIMITS.bytes -
    loaded.reduce((sum, entry) => sum + entry.bytes.length + (entry.metadata?.length ?? 0), 0);
  for (const previous of ticket?.previous?.proofs ?? []) {
    const index = loaded.findIndex(
      (entry) => entry.dependency.physicalRolloutId === previous.physical,
    );
    if (index < 0) {
      fail("projection-only", "native.epoch_dependency_unavailable");
    }
    const entry = loaded[index]!;
    const proof = observed[index]!;
    for (const range of previous.ranges) {
      if (
        range.endExclusive > proof.decodedSize! ||
        proof.ranges.some(
          (actual) => actual.start === range.start && actual.endExclusive === range.endExclusive,
        )
      ) {
        continue;
      }
      if (
        range.start >= entry.dependency.start &&
        range.endExclusive <= entry.dependency.endExclusive
      ) {
        proof.ranges.push({
          ...range,
          sha256: hash(
            entry.bytes.subarray(
              range.start - entry.dependency.start,
              range.endExclusive - entry.dependency.start,
            ),
          ),
        });
        continue;
      }
      if (range.endExclusive - range.start > remaining) {
        fail("projection-only", "native.epoch_dependency_budget");
      }
      remaining -= range.endExclusive - range.start;
      // oxlint-disable-next-line no-await-in-loop -- A backend handoff verifies only the bounded previous decoded dependencies that current replay did not already cover
      const current = await validateSourceRanges(
        lineage.segments[index]!.ref,
        [range],
        null,
        signal,
        { parserVersion: source.parserVersion },
      );
      if (observedSource(current.generation) !== observedSource(entry.generation)) {
        fail("stale", "native.epoch_source_changed");
      }
      proof.ranges.push(...current.generation.verifiedDecodedRanges);
    }
  }
  return observed;
}
function extendsVerifiedDependencies(
  association: VerifiedProjectionAssociation,
  loaded: LoadedSegment[],
): boolean {
  return (
    association.dependencies.length === loaded.length &&
    association.dependencies.every((old, index) => {
      const next = loaded[index]!;
      return (
        old.physicalRolloutId === next.dependency.physicalRolloutId &&
        old.sourcePath === next.dependency.sourcePath &&
        old.start === next.dependency.start &&
        old.endOrdinalExclusive === next.dependency.endOrdinalExclusive &&
        old.startOrdinal === next.dependency.startOrdinal &&
        old.anchorSha256 === next.dependency.anchorSha256 &&
        old.endExclusive <= next.dependency.start + next.bytes.length &&
        old.nextOrdinal <= next.dependency.nextOrdinal &&
        hash(next.bytes.subarray(0, old.endExclusive - old.start)) === old.sha256
      );
    })
  );
}
function matchingAssociationContract(
  association: VerifiedProjectionAssociation,
  lineageKey: string,
  parserVersion: number,
): boolean {
  return (
    association.lineageKey === lineageKey &&
    association.parserVersion === parserVersion &&
    association.adapterVersion === NATIVE_ITEM_ADAPTER_VERSION
  );
}
class QualificationFailure extends Error {
  readonly status: "projection-only" | "stale";
  constructor(status: "projection-only" | "stale", code: string) {
    super(code);
    this.status = status;
  }
}
function fail(status: "projection-only" | "stale", code: string): never {
  throw new QualificationFailure(status, code);
}
function observedSource(generation: SourceGeneration): string {
  return JSON.stringify(generation.observation);
}

async function readDependencies(
  lineage: ResolvedRolloutLineage,
  source: SourceGeneration,
  provider: CanonicalEvidenceProvider | undefined,
  signal?: AbortSignal,
): Promise<LoadedSegment[]> {
  let remaining = NATIVE_VERIFICATION_LIMITS.bytes;
  const loaded: LoadedSegment[] = [];
  const proposed = await provider?.proposeRanges(lineage, source, signal);
  if (proposed != null && proposed.length !== lineage.segments.length) {
    fail("projection-only", "native.incomplete_evidence_dependencies");
  }
  for (const segment of lineage.segments) {
    signal?.throwIfAborted();
    if (segment.ref.representation !== "plain-jsonl") {
      fail("projection-only", "native.decoded_evidence_required");
    }
    // oxlint-disable-next-line no-await-in-loop -- Each segment consumes the shared bounded evidence budget before the next is admitted
    const observation = await observeSessionMetaSource(segment.ref.sourcePath);
    const size = Number(observation.size);
    const endExclusive = segment.endByteOffset ?? size;
    const proposal = proposed?.find(
      (range) => range.physicalRolloutId === segment.ref.physicalRolloutId,
    );
    const prepared = proposal?.preparedIndex
      ? consumePreparedCanonicalWindow(proposal.preparedIndex, lineage, source)
      : null;
    const start = prepared?.start ?? 0;
    if (proposed != null) {
      if (!proposal) {
        fail("projection-only", "native.incomplete_evidence_dependencies");
      }
      // A proposed offset/ordinal is not an independently qualified ordinal index
      if ((proposal.start !== 0 && prepared === null) || proposal.startOrdinal === null) {
        fail("projection-only", "native.ordinal_anchor_required");
      }
      if (
        proposal.start !== start ||
        proposal.startOrdinal !== (prepared?.startOrdinal ?? segment.bodyStartOrdinal - 1) ||
        proposal.endExclusive !== endExclusive
      ) {
        fail("stale", "native.evidence_boundary_mismatch");
      }
    }
    if (!Number.isSafeInteger(endExclusive) || endExclusive < 0 || endExclusive > size) {
      fail("stale", "native.invalid_source_bound");
    }
    if (endExclusive - start + (prepared?.metadata.length ?? 0) > remaining) {
      fail("projection-only", "native.verification_budget");
    }
    remaining -= endExclusive - start + (prepared?.metadata.length ?? 0);
    // oxlint-disable-next-line no-await-in-loop -- Source observations and byte budgets must be checked before reading the dependent segment
    const validated = await validateSourceRanges(
      segment.ref,
      [
        { start, endExclusive },
        ...(prepared ? [{ start: 0, endExclusive: prepared.metadata.length }] : []),
      ],
      null,
      signal,
      { parserVersion: source.parserVersion },
    );
    if (
      segment.ref.physicalRolloutId === source.physicalRolloutId &&
      observedSource(validated.generation) !== observedSource(source)
    ) {
      fail("stale", "native.source_generation_changed");
    }
    const chunks: Buffer[] = [];
    // oxlint-disable-next-line no-await-in-loop -- Compare the exact source bytes against the immediately preceding range validation
    const read = await stableRead(segment.ref.sourcePath, {
      start,
      endExclusive,
      onChunk({ bytes }) {
        signal?.throwIfAborted();
        chunks.push(Buffer.from(bytes));
      },
    });
    const bytes = Buffer.concat(chunks);
    const sha256 = hash(bytes);
    if (
      prepared &&
      validated.generation.verifiedDecodedRanges[1]?.sha256 !== hash(prepared.metadata)
    ) {
      fail("stale", "native.index_metadata_changed");
    }
    if (proposal && proposal.sha256 !== sha256) {
      fail("stale", "native.evidence_digest_mismatch");
    }
    if (
      read.status !== "stable" ||
      bytes.length !== endExclusive - start ||
      sha256 !== validated.generation.verifiedDecodedRanges[0]!.sha256
    ) {
      fail("stale", "native.source_changed_during_verification");
    }
    if (segment.ref.physicalRolloutId === source.physicalRolloutId) {
      for (const range of prepared ? [] : source.verifiedDecodedRanges) {
        if (
          range.endExclusive > bytes.length ||
          hash(bytes.subarray(range.start, range.endExclusive)) !== range.sha256
        ) {
          fail("stale", "native.source_dependency_mismatch");
        }
      }
      if (prepared === null && source.decodedSha256 !== null && source.decodedSha256 !== sha256) {
        fail("stale", "native.source_dependency_mismatch");
      }
    }
    loaded.push({
      ...(prepared ? { metadata: prepared.metadata } : {}),
      bytes,
      generation: validated.generation,
      dependency: {
        physicalRolloutId: segment.ref.physicalRolloutId!,
        sourcePath: segment.ref.sourcePath,
        start,
        ...(prepared
          ? { startOrdinal: prepared.startOrdinal, anchorSha256: prepared.anchorSha256 }
          : {}),
        endExclusive,
        sha256,
        nextOrdinal: 0,
        endOrdinalExclusive: segment.endOrdinalExclusive,
        semanticEpoch:
          segment.ref.physicalRolloutId === source.physicalRolloutId
            ? (source.semanticEpoch ?? null)
            : null,
      },
    });
  }
  return loaded;
}
async function replay(
  lineage: ResolvedRolloutLineage,
  loaded: LoadedSegment[],
  candidate: NativeHistoryPageResult,
  signal?: AbortSignal,
): Promise<CanonicalTurn[]> {
  let records = 0;
  const effectiveTurns = new Map<string, CanonicalTurn>();
  for (const [segmentIndex, loadedSegment] of loaded.entries()) {
    const segment = lineage.segments[segmentIndex]!;
    if (loadedSegment.bytes.at(-1) !== 10) {
      fail("projection-only", "native.incomplete_source_record");
    }
    const replayBytes = loadedSegment.metadata
      ? Buffer.concat([loadedSegment.metadata, loadedSegment.bytes])
      : loadedSegment.bytes;
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(replayBytes).split("\n");
    lines.pop();
    if (records + lines.length > NATIVE_VERIFICATION_LIMITS.records) {
      fail("projection-only", "native.verification_budget");
    }
    const local = new Map<string, CanonicalTurn>();
    for (const [index, line] of lines.entries()) {
      if (records % 128 === 0) {
        // oxlint-disable-next-line no-await-in-loop -- Cooperative replay yields keep selected serving responsive without reordering lifecycle updates
        await setImmediate();
        signal?.throwIfAborted();
      }
      records += 1;
      let entry: Record<string, unknown> | null;
      try {
        entry = record(JSON.parse(line));
      } catch {
        fail("projection-only", "native.unprojected_record");
      }
      const payload = record(entry?.["payload"]);
      if (index === 0) {
        if (
          entry?.["type"] !== "session_meta" ||
          payload?.["id"] !== segment.ref.stableThreadId ||
          (payload["session_id"] ?? null) !== segment.ref.rootSessionId
        ) {
          fail("stale", "native.source_identity_mismatch");
        }
        const base = record(payload["history_base"]);
        const expected = segment.ref.historyBase;
        if (
          !isDeepStrictEqual(
            base,
            expected === null
              ? null
              : {
                  thread_id: expected.physicalRolloutId,
                  end_ordinal_exclusive: expected.endOrdinalExclusive,
                  end_byte_offset: expected.endByteOffset,
                },
          ) ||
          (payload["subagent_history_start_ordinal"] ?? null) !==
            segment.ref.subagentHistoryStartOrdinal
        ) {
          fail("stale", "native.lineage_metadata_mismatch");
        }
        continue;
      }
      const ordinal =
        (loadedSegment.dependency.startOrdinal ?? segment.bodyStartOrdinal) + index - 1;
      if (entry?.["type"] === "turn_context" || entry?.["type"] === "token_usage") {
        continue;
      }
      if (entry?.["type"] !== "event_msg" || payload === null) {
        fail("projection-only", "native.unprojected_record");
      }
      const type = payload["type"];
      const turnId = payload["turn_id"];
      if (typeof turnId !== "string" || turnId.length === 0) {
        fail("projection-only", "native.unprojected_record");
      }
      if (type === "turn_started") {
        if (local.has(turnId)) {
          fail("projection-only", "native.ambiguous_turn_restart");
        }
        local.set(turnId, {
          id: turnId,
          segment: segmentIndex,
          ordinal,
          status: "inProgress",
          startedAt: typeof payload["started_at"] === "number" ? payload["started_at"] : null,
          completedAt: null,
          durationMs: null,
          finalAnswerItemId: null,
          items: new Map(),
        });
      } else {
        const turn = local.get(turnId);
        if (turn === undefined) {
          fail("projection-only", "native.missing_turn_boundary");
        }
        if (type === "item_completed") {
          const item = adaptCoreTurnItem(payload["item"], payload);
          if (item === null) {
            fail("projection-only", "native.unprojected_record");
          }
          const previous = turn.items.get(item.id);
          if (previous && previous.item.type !== item.type) {
            fail("projection-only", "native.changed_item_type");
          }
          turn.items.set(item.id, {
            item: previous
              ? { ...item, startedAtMs: previous.item.startedAtMs ?? item.startedAtMs }
              : item,
            ordinal: previous?.ordinal ?? ordinal,
            updated: ordinal,
          });
          if (item.type === "agentMessage" && item.phase === "final_answer") {
            turn.finalAnswerItemId = item.id;
          }
        } else if (type === "turn_complete" || type === "turn_aborted") {
          turn.status =
            type === "turn_aborted"
              ? "interrupted"
              : payload["error"] == null
                ? "completed"
                : "failed";
          turn.startedAt =
            typeof payload["started_at"] === "number" ? payload["started_at"] : turn.startedAt;
          turn.completedAt =
            typeof payload["completed_at"] === "number" ? payload["completed_at"] : null;
          turn.durationMs =
            typeof payload["duration_ms"] === "number" ? payload["duration_ms"] : null;
        } else {
          fail("projection-only", "native.unprojected_record");
        }
      }
    }
    loadedSegment.dependency.nextOrdinal =
      (loadedSegment.dependency.startOrdinal ?? segment.bodyStartOrdinal) + lines.length - 1;
    if (
      segment.endOrdinalExclusive !== null &&
      loadedSegment.dependency.nextOrdinal !== segment.endOrdinalExclusive
    ) {
      fail("stale", "native.cutoff_boundary_mismatch");
    }
    const watermark = candidate.page!.coverage.segments[segmentIndex]?.projectionWatermark;
    if (!watermark || watermark.nextOrdinal === 0 || watermark.nextByteOffset === 0) {
      fail("projection-only", "native.zero_or_missing_watermark");
    }
    if (
      segment.endOrdinalExclusive === null
        ? watermark.nextOrdinal !== loadedSegment.dependency.nextOrdinal ||
          watermark.nextByteOffset !== loadedSegment.dependency.endExclusive
        : watermark.nextOrdinal < loadedSegment.dependency.nextOrdinal ||
          watermark.nextByteOffset < loadedSegment.dependency.endExclusive
    ) {
      fail("stale", "native.projection_suffix_mismatch");
    }
    for (const [id, turn] of local) {
      effectiveTurns.delete(id);
      if (turn.ordinal >= segment.displayStartOrdinal) {
        effectiveTurns.set(id, turn);
      }
    }
  }
  return [...effectiveTurns.values()].toSorted(
    (a, b) => a.segment - b.segment || a.ordinal - b.ordinal || a.id.localeCompare(b.id),
  );
}
function compareSelected(candidate: NativeHistoryPageResult, turns: CanonicalTurn[]): void {
  const query = candidate.query;
  const cursor = "cursor" in query.anchor ? decodeNativeHistoryCursor(query.anchor.cursor) : null;
  const target =
    "turnId" in query ? query.turnId : query.anchor.kind === "turn" ? query.anchor.turnId : null;
  let selected = turns;
  if (target !== null) {
    selected = turns.filter((turn) => turn.id === target);
  } else {
    if (cursor) {
      selected = selected.filter((turn) => {
        const order =
          turn.segment - cursor.segment ||
          turn.ordinal - cursor.ordinal ||
          turn.id.localeCompare(cursor.id);
        return query.anchor.kind === "before" ? order < 0 : order > 0;
      });
    }
    const limit = query.limit ?? (query.anchor.kind === "latest" ? 5 : 20);
    selected = query.anchor.kind === "after" ? selected.slice(0, limit) : selected.slice(-limit);
  }
  if (
    !isDeepStrictEqual(
      selected.map((turn) => turn.id),
      candidate.page!.turns.map((turn) => turn.turnId),
    )
  ) {
    fail("stale", "native.turn_selection_mismatch");
  }
  for (const [index, expected] of selected.entries()) {
    const actual = candidate.page!.turns[index]!;
    if (
      actual.order !== expected.ordinal ||
      actual.status !== expected.status ||
      actual.startedAt !== expected.startedAt ||
      actual.completedAt !== expected.completedAt ||
      actual.durationMs !== expected.durationMs ||
      actual.finalAnswerItemId !== expected.finalAnswerItemId
    ) {
      fail("stale", "native.turn_lifecycle_mismatch");
    }
    let expectedItems = [...expected.items.values()].toSorted(
      (a, b) => a.ordinal - b.ordinal || a.item.id.localeCompare(b.item.id),
    );
    const opening = expectedItems.find((entry) => entry.item.type !== "contextCompaction");
    if (actual.opening.availability === "available") {
      if (
        !opening ||
        opening.item.type !== "userMessage" ||
        !actual.opening.item ||
        !isDeepStrictEqual(comparable(opening.item), comparable(actual.opening.item))
      ) {
        fail("stale", "native.opening_mismatch");
      }
    } else if (opening?.item.type === "userMessage") {
      fail("projection-only", "native.opening_unavailable");
    }
    if ("turnId" in query && cursor) {
      expectedItems = expectedItems.filter((entry) => {
        const order = entry.ordinal - cursor.ordinal || entry.item.id.localeCompare(cursor.id);
        return query.anchor.kind === "before" ? order < 0 : order > 0;
      });
    }
    const limit =
      "turnId" in query ? (query.limit ?? (query.anchor.kind === "opening" ? 2 : 100)) : 100;
    expectedItems =
      "turnId" in query && (query.anchor.kind === "after" || query.anchor.kind === "opening")
        ? expectedItems.slice(0, limit)
        : expectedItems.slice(-limit);
    if (expectedItems.length !== actual.items.length) {
      fail("stale", "native.item_selection_mismatch");
    }
    for (const [itemIndex, entry] of expectedItems.entries()) {
      const observed = actual.items[itemIndex]!;
      if (
        !observed.item ||
        observed.detail !== "full" ||
        observed.updatedAtOrdinal === null ||
        observed.updatedAtOrdinal === 0
      ) {
        fail("projection-only", "native.item_evidence_unavailable");
      }
      if (entry.item.type === "commandExecution") {
        fail("projection-only", "native.command_presentation_requires_raw");
      }
      if (
        entry.item.id !== observed.itemId ||
        entry.ordinal !== observed.ordinal ||
        entry.updated !== observed.updatedAtOrdinal ||
        !isDeepStrictEqual(comparable(entry.item), comparable(observed.item))
      ) {
        fail("stale", "native.item_payload_mismatch");
      }
    }
  }
}

/** Establishes authority only by comparing actual canonical dependencies, never by matching watermarks */
export async function qualifyNativeProjection(
  candidate: NativeHistoryPageResult,
  lineage: ResolvedRolloutLineage,
  source: SourceGeneration,
  verifiedAssociations: VerifiedProjectionStore,
  signal?: AbortSignal,
): Promise<NativeProjectionQualification> {
  signal?.throwIfAborted();
  const result: NativeProjectionQualification = {
    status: "projection-only",
    snapshotDigest: candidate.snapshot.digest,
    sourceToken: source.token,
    historyEpoch: null,
    dependencies: [],
    verifiedRanges: [],
    diagnostics: [...candidate.diagnostics],
    association: null,
    page: null,
  };
  if (candidate.status === "unavailable" || candidate.page === null) {
    return { ...result, status: "unavailable" };
  }
  try {
    const current = lineage.segments.at(-1)?.ref;
    if (
      !current ||
      current.codexHomeId !== source.codexHomeId ||
      current.physicalRolloutId !== source.physicalRolloutId ||
      current.sourcePath !== source.sourcePath ||
      candidate.page.threadId !== current.stableThreadId
    ) {
      fail("stale", "native.source_identity_mismatch");
    }
    if (lineage.status !== "complete") {
      fail("projection-only", "native.unresolved_lineage");
    }
    if (candidate.diagnostics.includes("native.cutoff_update")) {
      fail("stale", "native.cutoff_update");
    }
    if (
      !candidate.snapshot.capabilities.updatedAtOrdinal ||
      !candidate.snapshot.capabilities.turnEndOrdinal
    ) {
      fail("projection-only", "native.old_projection_writer");
    }
    const loaded = await readDependencies(
      lineage,
      source,
      verifiedAssociations.canonicalEvidence,
      signal,
    );
    const epochTicket = verifiedAssociations.epochAuthority?.begin(lineage);
    const epochObservations = await observePreviousEpoch(
      lineage,
      source,
      loaded,
      epochTicket,
      signal,
    );
    const turns = await replay(lineage, loaded, candidate, signal);
    result.dependencies = loaded.map((entry) => entry.dependency);
    const lineageKey = hash(
      JSON.stringify([
        nativeLineageIdentity(lineage),
        source.parserVersion,
        NATIVE_ITEM_ADAPTER_VERSION,
      ]),
    );
    if (!(await historySnapshotUnchanged(candidate.snapshot))) {
      fail("stale", "native.snapshot_changed");
    }
    for (const [index, segment] of lineage.segments.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- Publication rechecks every physical dependency after canonical replay
      const observation = await observeSessionMetaSource(segment.ref.sourcePath);
      const verified = loaded[index]!.generation.observation;
      if (
        String(observation.device) !== verified.device ||
        String(observation.inode) !== verified.inode ||
        Number(observation.size) !== verified.encodedSize ||
        String(observation.mtimeNs) !== verified.mtimeNs ||
        String(observation.ctimeNs) !== verified.ctimeNs
      ) {
        fail("stale", "native.source_changed_before_publish");
      }
    }
    signal?.throwIfAborted();
    // Keep epoch selection, issued-proof revalidation and synchronous persistence indivisible after all asynchronous publication fences
    const previous = verifiedAssociations.latest(lineageKey);
    const localHistoryEpoch =
      previous !== null &&
      matchingAssociationContract(previous, lineageKey, source.parserVersion) &&
      extendsVerifiedDependencies(previous, loaded)
        ? previous.historyEpoch
        : randomUUID();
    const epochSelection = epochTicket
      ? verifiedAssociations.epochAuthority!.select(
          epochTicket,
          epochObservations,
          localHistoryEpoch,
        )
      : undefined;
    if (epochTicket && epochSelection === null) {
      fail("projection-only", "native.epoch_dependencies_unverified");
    }
    const historyEpoch = epochSelection?.epoch ?? localHistoryEpoch;
    if (candidate.requestDependency !== null) {
      const issued = verifiedAssociations.get(candidate.requestDependency);
      const cursor =
        "cursor" in candidate.query.anchor
          ? decodeNativeHistoryCursor(candidate.query.anchor.cursor)
          : null;
      if (
        issued === null ||
        issued.key !== candidate.requestDependency ||
        !matchingAssociationContract(issued, lineageKey, source.parserVersion) ||
        cursor === null ||
        cursor.dependency !== issued.key ||
        cursor.epoch !== issued.historyEpoch ||
        !issued.cursorBoundaries.some((boundary) =>
          isDeepStrictEqual(boundary, nativeCursorBoundary(cursor)),
        )
      ) {
        fail("stale", "native.cursor_association_mismatch");
      }
      // The issued prefix must still match, current replay and selected comparison reconcile every newly required suffix/update
      if (!extendsVerifiedDependencies(issued, loaded)) {
        fail("stale", "native.cursor_dependencies_changed");
      }
      if (issued.historyEpoch !== historyEpoch) {
        fail("stale", "native.cursor_epoch_changed");
      }
    }
    const key = hash(
      JSON.stringify([
        lineageKey,
        candidate.snapshot.digest,
        result.dependencies,
        candidate.query,
        candidate.page,
      ]),
    );
    const stored = verifiedAssociations.get(key);
    const existing =
      stored !== null &&
      stored.key === key &&
      stored.lineageKey === lineageKey &&
      stored.snapshotDigest === candidate.snapshot.digest &&
      stored.parserVersion === source.parserVersion &&
      stored.adapterVersion === NATIVE_ITEM_ADAPTER_VERSION &&
      stored.historyEpoch === historyEpoch &&
      isDeepStrictEqual(stored.dependencies, result.dependencies)
        ? stored
        : null;
    if (existing === null) {
      compareSelected(candidate, turns);
      verifiedAssociations.put({
        version: 2,
        key,
        lineageKey,
        snapshotDigest: candidate.snapshot.digest,
        parserVersion: source.parserVersion,
        adapterVersion: NATIVE_ITEM_ADAPTER_VERSION,
        historyEpoch,
        dependencies: result.dependencies,
        cursorBoundaries: pageCursorBoundaries(candidate.page),
      });
    }
    if (epochSelection) {
      verifiedAssociations.epochAuthority!.publish(epochSelection, epochProofs(loaded, source));
    }
    const page = qualifyPageCursors(structuredClone(candidate.page), key, historyEpoch);
    for (const [index, segment] of page.coverage.segments.entries()) {
      segment.sourceWatermark = {
        nextOrdinal: result.dependencies[index]!.nextOrdinal,
        nextByteOffset: result.dependencies[index]!.endExclusive,
      };
    }
    return {
      ...result,
      status: "verified-range",
      historyEpoch,
      verifiedRanges: page.turns.flatMap((turn) => turn.loadedRanges),
      association: existing === null ? "established" : "reused",
      page,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return {
      ...result,
      status: error instanceof QualificationFailure ? error.status : "projection-only",
      diagnostics: [
        ...result.diagnostics,
        error instanceof QualificationFailure ? error.message : "native.verification_unavailable",
      ],
    };
  }
}
