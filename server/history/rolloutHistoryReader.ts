import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  type HistoryEpochAuthority,
  type HistoryEpochProof,
} from "#server/history/historyEpochAuthority.ts";
import {
  legacyWindowOverlap,
  planLegacyWindow,
  stableRecordKey,
  type LegacyTurnWindowIdentity,
} from "#server/history/legacyTurnWindows.ts";
import {
  adaptCoreTurnItem,
  adaptNativeThreadItem,
  adaptCommandEvent,
  adaptGuardianReviewEnvelope,
} from "#server/history/nativeItemAdapter.ts";
import type { JsonlRecord } from "#server/ingestion/jsonlStream.ts";
import {
  readJsonlWindow,
  readOpeningJsonlWindow,
  readForwardJsonlWindow,
  type JsonlWindow,
} from "#server/ingestion/reverseJsonl.ts";
import { qualifyRawRecord } from "#server/ingestion/rolloutIdentity.ts";
import type {
  ResolvedRolloutLineage,
  ResolvedRolloutSegment,
} from "#server/ingestion/rolloutLineage.ts";
import { openRollout, type SeekableRollout } from "#server/ingestion/rolloutStream.ts";
import { observeSessionMetaSource } from "#server/ingestion/sessionMetaPrefix.ts";
import { isFinalAnswerEligible, isFinalAnswerPhase } from "#shared/timeline/finalAnswer.ts";
import {
  logicalRecordVisibility,
  unverifiedReviewRecord,
} from "#shared/timeline/reviewVisibility.ts";
import {
  jsonValueSchema,
  type JsonValue,
  type RolloutRef,
  type SourceGeneration,
} from "#shared/types/conversation.ts";
import {
  historyPageSchema,
  type HistoryCoverage,
  type HistoryItem,
  type HistoryPage,
  type HistoryTurnWindow,
  type ReviewSourceRecord,
} from "#shared/types/history.ts";
import {
  historyPageQuerySchema,
  historyItemQuerySchema,
  type HistoryPageQuery,
  type HistoryItemQuery,
} from "#shared/types/repository.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function object(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
const text = (value: JsonValue | undefined) => (typeof value === "string" ? value : null);
const number = (value: JsonValue | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
interface Proof {
  physical: string;
  ranges: SourceGeneration["verifiedDecodedRanges"];
}
function mergeProofs(proofs: readonly Proof[]): Proof[] {
  const merged = new Map<string, Map<string, SourceGeneration["verifiedDecodedRanges"][number]>>();
  for (const proof of proofs) {
    const ranges = merged.get(proof.physical) ?? new Map();
    for (const range of proof.ranges) {
      ranges.set(`${range.start}:${range.endExclusive}`, range);
    }
    merged.set(proof.physical, ranges);
  }
  return [...merged].map(([physical, ranges]) => ({ physical, ranges: [...ranges.values()] }));
}
interface EpochState {
  epoch: string;
  proofs: Proof[];
}
interface Cursor {
  purpose?: "opening" | "legacyBoundary" | "updates";
  openingBoundary?: JsonlRecord;
  selectionEnd?: number;
  selectionLimit?: number;
  updateRecords?: JsonlRecord[];
  updateCoverage?: { start: number; endExclusive: number }[];
  updateProofs?: SourceGeneration["verifiedDecodedRanges"];
  thread: string;
  lineage: string;
  epoch: string;
  physical: string;
  end: number;
  turn: string | null;
  proofs: Proof[];
}
interface Loaded {
  segment: ResolvedRolloutSegment;
  lease: SeekableRollout;
  opening: JsonlWindow;
  tail: JsonlWindow;
  suffix?: JsonlWindow;
  search?: JsonlWindow;
  searchBoundary?: JsonlRecord;
  legacy?: LegacyTurnWindowIdentity;
  updateScan?: JsonlWindow;
  carriedUpdates?: JsonlRecord[];
  updateCoverage?: { start: number; endExclusive: number }[];
  generation: SourceGeneration | null;
}
interface ItemEntry {
  item: HistoryItem;
  record: JsonlRecord;
  updatedRecord: JsonlRecord;
  canonical: boolean;
}
interface RawTurn {
  id: string;
  start: JsonlRecord;
  end: number;
  items: Map<string, ItemEntry>;
  status: HistoryTurnWindow["status"];
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  boundary: boolean;
  completion?: { text: string; record: JsonlRecord };
  context: NonNullable<HistoryTurnWindow["context"]>;
}
interface AssemblyContext {
  context: RawTurn["context"];
  contextTurnId?: string | null;
  calls: Map<string, Record<string, JsonValue>>;
}
export interface RolloutHistoryReaderOptions {
  epochAuthority?: HistoryEpochAuthority;
  open?: (ref: RolloutRef, signal?: AbortSignal) => Promise<SeekableRollout>;
  maxWindowBytes?: number;
  openingBytes?: number;
  maxProofBytes?: number;
}

function legacyItem(
  ref: RolloutRef,
  record: JsonlRecord,
  payload: Record<string, JsonValue>,
  calls: Map<string, Record<string, JsonValue>>,
): HistoryItem | null {
  const envelope = object(record.value)!;
  const type = payload["type"];
  const id = text(payload["id"]) ?? stableRecordKey(ref, record);
  const role = text(payload["role"]);
  const content = payload["content"];
  const message =
    text(payload["message"]) ??
    (typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => text(object(part)?.["text"]) ?? "").join("")
        : "");
  if (type === "user_message" || (type === "message" && role === "user")) {
    const media = [
      ...(Array.isArray(payload["images"])
        ? payload["images"].flatMap((value) =>
            typeof value === "string" ? [{ type: "image", url: value }] : [],
          )
        : []),
      ...(Array.isArray(payload["local_images"])
        ? payload["local_images"].flatMap((value) =>
            typeof value === "string" ? [{ type: "localImage", path: value }] : [],
          )
        : []),
      ...(Array.isArray(content)
        ? content.flatMap((value) => {
            const part = object(value);
            return part?.["type"] === "input_image" && typeof part["image_url"] === "string"
              ? [{ type: "image", url: part["image_url"] }]
              : [];
          })
        : []),
    ];
    return adaptNativeThreadItem({
      id,
      type: "userMessage",
      content: [{ type: "text", text: message }, ...media],
    });
  }
  if (type === "image_generation_call" || type === "image_generation_end") {
    return adaptNativeThreadItem({
      id,
      type: "imageGeneration",
      result: payload["result"] ?? null,
      savedPath: payload["saved_path"] ?? null,
      fileId: payload["file_id"] ?? null,
    });
  }
  if (type === "agent_message" || (type === "message" && role === "assistant")) {
    return adaptNativeThreadItem({
      id,
      type: "agentMessage",
      text: message,
      phase: payload["phase"] ?? null,
    });
  }
  if (type === "task_complete") {
    const supplied = text(payload["last_agent_message"]);
    return supplied === null || supplied.trim() === ""
      ? null
      : adaptNativeThreadItem({ id, type: "agentMessage", text: supplied, phase: "final" });
  }
  if (type === "reasoning" || type === "agent_reasoning") {
    const plaintext = (value: JsonValue | undefined) =>
      Array.isArray(value)
        ? value.flatMap((part) => {
            const supplied = typeof part === "string" ? part : text(object(part)?.["text"]);
            return supplied === null ? [] : [supplied];
          })
        : [];
    return adaptNativeThreadItem({
      id,
      type: "reasoning",
      summary:
        typeof payload["text"] === "string" ? [payload["text"]] : plaintext(payload["summary"]),
      content: plaintext(payload["content"]),
    });
  }
  if (type === "context_compacted" || envelope["type"] === "compacted") {
    return adaptNativeThreadItem({ id, type: "contextCompaction" });
  }
  const command = adaptCommandEvent(payload);
  if (command) {
    return command;
  }
  const callId = text(payload["call_id"]);
  if (callId && (type === "function_call" || type === "custom_tool_call")) {
    calls.set(callId, payload);
    return adaptNativeThreadItem({
      id: stableRecordKey(ref, record),
      type: "dynamicToolCall",
      namespace: payload["namespace"] ?? null,
      tool: text(payload["name"]) ?? "unknown",
      arguments: payload["arguments"] ?? payload["input"] ?? null,
      status: "inProgress",
      contentItems: null,
      success: null,
    });
  }
  if (callId && (type === "function_call_output" || type === "custom_tool_call_output")) {
    const call = calls.get(callId);
    return adaptNativeThreadItem({
      id,
      type: "functionCallOutput",
      name: text(call?.["name"]) ?? "unknown",
      namespace: call?.["namespace"] ?? null,
      output: payload["output"] ?? null,
    });
  }
  return null;
}
function contextTargetId(payload: Record<string, JsonValue>, turn: RawTurn | null): string | null {
  return text(payload["turn_id"]) ?? turn?.id ?? null;
}
export function assembleHistoryRecords(
  loaded: Omit<Loaded, "lease" | "generation">,
  inherited?: AssemblyContext,
): {
  turns: RawTurn[];
  unsupported: boolean;
  unresolvedCutoff: boolean;
  carried: AssemblyContext;
  reviewRecords: ReviewSourceRecord[];
} {
  const { segment, opening, tail } = loaded;
  const records = [
    ...new Map(
      [
        ...(loaded.suffix?.records ?? []),
        ...tail.records,
        ...opening.records,
        ...(loaded.search?.records ?? []),
        ...(loaded.searchBoundary ? [loaded.searchBoundary] : []),
        ...(loaded.carriedUpdates ?? []),
        ...(loaded.updateScan?.records ?? []),
      ].map((record) => [record.byteStart, record]),
    ).values(),
  ].toSorted((a, b) => a.byteStart - b.byteStart);
  const turns = new Map<string, RawTurn>();
  const reviewRecords: ReviewSourceRecord[] = [];
  const calls = new Map<string, Record<string, JsonValue>>(inherited?.calls);
  const contextOnlyCalls = new Set(calls.keys());
  const pairedCanonicalMessages = new Set<string>();
  const turnContexts = new Map<string, RawTurn["context"]>();
  let contextTurnId: string | null = inherited?.contextTurnId ?? null;
  let active: RawTurn | null = null;
  let unsupported = false;
  let unresolvedCutoff = false;
  let previousEnd = 0;
  let context: RawTurn["context"] = inherited
    ? { ...inherited.context }
    : {
        model: null,
        effort: null,
        cwd: null,
        complete: opening.nextEndExclusive >= (tail.records[0]?.byteStart ?? 0),
      };
  for (const sourceRecord of records) {
    if (segment.endByteOffset !== null && sourceRecord.byteEnd > segment.endByteOffset) {
      continue;
    }
    if (sourceRecord.byteStart > previousEnd) {
      context = { model: null, effort: null, cwd: null, complete: false };
      contextTurnId = null;
      if (active) {
        active.context.complete = false;
      }
      active = null;
      calls.clear();
      contextOnlyCalls.clear();
    }
    previousEnd = sourceRecord.byteEnd;
    const record = qualifyRawRecord(sourceRecord, segment.ref);
    const logicalVisibility = logicalRecordVisibility({
      ordinal: record.ordinal ?? null,
      bodyStartOrdinal: segment.bodyStartOrdinal,
      displayStartOrdinal: segment.displayStartOrdinal,
    });
    const envelope = object(record.value);
    if (
      ["item/autoApprovalReview/started", "item/autoApprovalReview/completed"].includes(
        text(envelope?.["method"]) ?? "",
      )
    ) {
      const review = adaptGuardianReviewEnvelope(envelope?.["params"]);
      if (review && record.identity && review.parentThreadId === segment.ref.stableThreadId) {
        reviewRecords.push({
          envelope: record.value,
          identity: record.identity,
          logicalVisibility,
        });
        if (logicalVisibility === "unresolved") {
          unresolvedCutoff = true;
        }
      } else {
        unsupported = true;
      }
      continue;
    }
    const payload = object(envelope?.["payload"]);
    if (!envelope || !payload) {
      unsupported = true;
      continue;
    }
    if (envelope["type"] === "session_meta") {
      continue;
    }
    if (envelope["type"] === "turn_context") {
      const observedContext: RawTurn["context"] = {
        model: text(payload["model"]),
        effort: text(payload["effort"]),
        cwd: text(payload["cwd"]),
        complete: true,
        source: {
          physicalRolloutId: segment.ref.physicalRolloutId!,
          decodedByteStart: record.byteStart,
          ordinal: record.ordinal ?? null,
          turnId: text(payload["turn_id"]),
        },
      };
      const contextTarget = contextTargetId(payload, active);
      if (contextTarget !== null) {
        turnContexts.set(contextTarget, observedContext);
        const targetTurn = turns.get(contextTarget);
        if (targetTurn) {
          targetTurn.context = { ...observedContext };
        }
      }
      if (contextTarget === null || active === null || active.id === contextTarget) {
        context = observedContext;
        contextTurnId = contextTarget;
      }
      continue;
    }
    if (
      [
        "token_usage",
        "world_state",
        "inter_agent_communication_metadata",
        "retained_context",
      ].includes(text(envelope["type"]) ?? "")
    ) {
      continue;
    }
    if (!["event_msg", "response_item", "compacted"].includes(text(envelope["type"]) ?? "")) {
      unsupported = true;
      continue;
    }
    const type = payload["type"];
    if (type === "thread_rolled_back" || envelope["type"] === "compacted") {
      unsupported = true;
    }
    const hidden = logicalVisibility === "context-only";
    if (logicalVisibility === "unresolved") {
      unresolvedCutoff = true;
      continue;
    }
    const named = text(payload["turn_id"]);
    const isStart = type === "turn_started" || type === "task_started";
    const prompt = type === "user_message";
    if (hidden) {
      legacyItem(segment.ref, record, payload, calls);
      const call = text(payload["call_id"]);
      if (call && (type === "function_call" || type === "custom_tool_call")) {
        contextOnlyCalls.add(call);
      }
      continue;
    }
    if (named !== null) {
      if (active && active.id.startsWith("raw-turn-") && !active.boundary && isStart) {
        turns.delete(active.id);
        active.id = named;
        active.boundary = true;
        turns.set(named, active);
      } else {
        active = turns.get(named) ?? {
          id: named,
          start: record,
          end: record.byteEnd,
          items: new Map(),
          status: "unknown",
          startedAt: null,
          completedAt: null,
          durationMs: null,
          boundary: isStart,
          context:
            turnContexts.get(named) ??
            (contextTurnId === null || contextTurnId === named
              ? { ...context }
              : { model: null, effort: null, cwd: null, complete: false }),
        };
        turns.set(named, active);
      }
    } else if (
      prompt &&
      (active === null ||
        active.status !== "inProgress" ||
        active.id.startsWith("legacy-window-") ||
        (active.id.startsWith("raw-turn-") &&
          [...active.items.values()].some((entry) => entry.item.type === "userMessage")))
    ) {
      active = {
        id:
          loaded.legacy?.boundary?.byteStart === record.byteStart
            ? loaded.legacy.id
            : `raw-turn-${stableRecordKey(segment.ref, record)}`,
        start: record,
        end: record.byteEnd,
        items: new Map(),
        status: "inProgress",
        startedAt: null,
        completedAt: null,
        durationMs: null,
        boundary: false,
        context:
          contextTurnId === null
            ? { ...context }
            : { model: null, effort: null, cwd: null, complete: false },
      };
      turns.set(active.id, active);
    }
    if (
      !active &&
      loaded.legacy &&
      record.byteStart >= loaded.legacy.start &&
      record.byteEnd <= loaded.legacy.end
    ) {
      const identity = loaded.legacy;
      active = turns.get(identity.id) ?? {
        id: identity.id,
        start: identity.boundary ?? record,
        end: record.byteEnd,
        items: new Map(),
        status: "unknown",
        startedAt: null,
        completedAt: null,
        durationMs: null,
        boundary: identity.boundary !== null,
        context: { model: null, effort: null, cwd: null, complete: false },
      };
      turns.set(active.id, active);
    }
    if (!active) {
      if (envelope["type"] === "response_item") {
        unsupported = true;
      }
      continue;
    }
    active.end = record.byteEnd;
    if (isStart) {
      active.boundary = true;
      active.status = "inProgress";
      active.startedAt = number(payload["started_at"]);
    }
    if (type === "turn_complete" || type === "task_complete" || type === "turn_aborted") {
      active.status =
        type === "turn_aborted" ? "interrupted" : payload["error"] == null ? "completed" : "failed";
      active.startedAt = number(payload["started_at"]) ?? active.startedAt;
      active.completedAt = number(payload["completed_at"]);
      active.durationMs = number(payload["duration_ms"]);
      const completionText = type === "task_complete" ? text(payload["last_agent_message"]) : null;
      if (completionText !== null && completionText.trim() !== "") {
        active.completion = { text: completionText, record };
      }
    }
    const canonical = type === "item_completed";
    const callId = text(payload["call_id"]);
    let item = canonical
      ? adaptCoreTurnItem(payload["item"], payload)
      : legacyItem(segment.ref, record, payload, calls);
    const completionItem = item?.type === "agentMessage" ? item : null;
    if (
      type === "task_complete" &&
      completionItem &&
      [...active.items.values()].some(
        (entry) =>
          entry.item.type === "agentMessage" &&
          isFinalAnswerEligible(entry.item.phase, entry.item.text, completionItem.text),
      )
    ) {
      item = null;
    }
    if (canonical && item === null) {
      unsupported = true;
    }
    if (!item) {
      if (
        ![
          "turn_started",
          "task_started",
          "turn_complete",
          "task_complete",
          "turn_aborted",
          "token_count",
          "thread_settings_applied",
        ].includes(text(type) ?? "")
      ) {
        unsupported = true;
      }
      continue;
    }
    if (
      (type === "function_call_output" || type === "custom_tool_call_output") &&
      callId &&
      !calls.has(callId)
    ) {
      unsupported = true;
    }
    const prior = active.items.get(item.id);
    if (prior?.canonical && !canonical) {
      pairedCanonicalMessages.add(`${active.id}:${item.id}`);
      continue;
    }
    if (canonical || prior === undefined) {
      if (!canonical) {
        const duplicate = [...active.items.values()].find(
          (entry) =>
            entry.canonical &&
            !pairedCanonicalMessages.has(`${active!.id}:${entry.item.id}`) &&
            entry.item.type === item!.type &&
            "text" in entry.item &&
            "text" in item! &&
            entry.item.text === item.text,
        );
        if (duplicate) {
          pairedCanonicalMessages.add(`${active.id}:${duplicate.item.id}`);
          continue;
        }
      } else {
        const duplicate = [...active.items.values()].find(
          (entry) =>
            !entry.canonical &&
            entry.item.type === item!.type &&
            "text" in entry.item &&
            "text" in item! &&
            entry.item.text === item.text,
        );
        if (duplicate) {
          active.items.delete(duplicate.item.id);
          pairedCanonicalMessages.add(`${active.id}:${item.id}`);
        }
      }
    }
    item = {
      ...item,
      evidence: {
        original: item.evidence,
        source: record.value,
        rawIdentity: jsonValueSchema.parse(record.identity ?? null),
        contextOnlyCall:
          type === "function_call_output" && contextOnlyCalls.has(text(payload["call_id"]) ?? ""),
      },
    };
    active.items.set(item.id, {
      item,
      record: prior?.record ?? record,
      updatedRecord: record,
      canonical,
    });
  }
  return {
    turns: [...turns.values()],
    reviewRecords,
    unsupported,
    unresolvedCutoff,
    carried: { context, contextTurnId, calls },
  };
}

export class RolloutHistoryReader {
  readonly #open: NonNullable<RolloutHistoryReaderOptions["open"]>;
  readonly #maxWindowBytes: number;
  readonly #openingBytes: number;
  readonly #maxProofBytes: number;
  readonly #epochAuthority: HistoryEpochAuthority | undefined;
  readonly #epochs = new Map<string, EpochState>();
  readonly #cursors = new Map<string, Cursor>();
  readonly #lastGood = new Map<string, HistoryPage>();
  readonly #legacyWindows = new Map<string, LegacyTurnWindowIdentity>();
  constructor(options: RolloutHistoryReaderOptions = {}) {
    this.#epochAuthority = options.epochAuthority;
    this.#open = options.open ?? openRollout;
    this.#maxWindowBytes = options.maxWindowBytes ?? 512 * 1024;
    this.#openingBytes = options.openingBytes ?? 64 * 1024;
    this.#maxProofBytes = options.maxProofBytes ?? 16 * 1024 * 1024;
  }
  async read(
    lineage: ResolvedRolloutLineage,
    query: HistoryPageQuery,
    signal?: AbortSignal,
  ): Promise<HistoryPage> {
    const parsed = historyPageQuerySchema.parse(query);
    const thread = lineage.segments.at(-1)?.ref.stableThreadId;
    if (!thread) {
      throw new Error("rollout.lineage_unavailable");
    }
    try {
      const page = await this.#read(lineage, parsed, signal);
      if (parsed.anchor.kind === "latest" && !page.stale) {
        this.#lastGood.set(thread, structuredClone(page));
        if (this.#lastGood.size > 8) {
          this.#lastGood.delete(this.#lastGood.keys().next().value!);
        }
      }
      return page;
    } catch (error) {
      if (signal?.aborted || !(error instanceof Error) || /cursor/u.test(error.message)) {
        throw error;
      }
      const reason = "code" in error && typeof error.code === "string" ? error.code : error.message;
      const retained = parsed.anchor.kind === "latest" ? this.#lastGood.get(thread) : undefined;
      const gaps = lineage.segments.map((segment) => ({
        physicalRolloutId: segment.ref.physicalRolloutId!,
        turnId: null,
        reason,
        beforeOrdinal: null,
        afterOrdinal: null,
      }));
      const coverage: HistoryCoverage = {
        status: /unsupported_format/u.test(reason) ? "unsupported" : "unresolved",
        segments: retained?.coverage.segments ?? [],
        gaps,
      };
      const page: HistoryPage = retained
        ? structuredClone(retained)
        : {
            threadId: thread,
            metadataRevision: null,
            contentRevision: randomUUID(),
            historyEpoch: randomUUID(),
            turns: [],
            beforeCursor: null,
            afterCursor: null,
            coverage,
            preparation: "unavailable",
          };
      page.stale = retained !== undefined;
      page.coverage = coverage;
      page.reviewEvidence = {
        availability: "unresolved",
        records: (page.reviewEvidence?.records ?? []).map(unverifiedReviewRecord),
      };
      page.preparation = retained ? "partial" : "unavailable";
      page.beforeCursor = null;
      page.afterCursor = null;
      for (const turn of page.turns) {
        turn.coverage = structuredClone(coverage);
        turn.reviewEvidence = {
          availability: "unresolved",
          records: (turn.reviewEvidence?.records ?? []).map(unverifiedReviewRecord),
        };
        turn.itemsView = "summary";
        turn.beforeCursor = null;
        turn.afterCursor = null;
      }
      return historyPageSchema.parse(page);
    }
  }
  async readItems(
    lineage: ResolvedRolloutLineage,
    query: HistoryItemQuery,
    signal?: AbortSignal,
  ): Promise<HistoryTurnWindow> {
    const parsed = historyItemQuerySchema.parse(query);
    const page = await this.#read(lineage, parsed, signal);
    const turn = page.turns.find((entry) => entry.turnId === parsed.turnId);
    if (!turn) {
      throw new Error("rollout.turn_unavailable");
    }
    return turn;
  }
  #issue(cursor: Cursor): string {
    const key = `raw-v1-${randomUUID()}`;
    this.#cursors.set(key, cursor);
    const preparations = [...this.#cursors].filter(([, value]) => value.purpose !== undefined);
    if (preparations.length > 8) {
      this.#cursors.delete(preparations[0]![0]);
    }
    if (this.#cursors.size > 256) {
      this.#cursors.delete(this.#cursors.keys().next().value!);
    }
    return key;
  }
  async #read(
    lineage: ResolvedRolloutLineage,
    query: HistoryPageQuery | HistoryItemQuery,
    signal?: AbortSignal,
  ): Promise<HistoryPage> {
    signal?.throwIfAborted();
    const selectedRef = lineage.segments.at(-1)?.ref;
    if (!selectedRef) {
      throw new Error("rollout.lineage_unavailable");
    }
    if (lineage.segments.length > 16) {
      throw new Error("rollout.lineage_budget");
    }
    const lineageKey = hash(
      JSON.stringify([
        selectedRef.codexHomeId,
        selectedRef.stableThreadId,
        lineage.historyEpoch,
        lineage.segments.map((segment) => [
          segment.ref.physicalRolloutId,
          segment.endOrdinalExclusive,
          segment.endByteOffset,
          segment.displayStartOrdinal,
        ]),
      ]),
    );
    const cursor = "cursor" in query.anchor ? this.#cursors.get(query.anchor.cursor) : undefined;
    const target =
      "turnId" in query ? query.turnId : query.anchor.kind === "turn" ? query.anchor.turnId : null;
    const requestedLegacy = target === null ? undefined : this.#legacyWindows.get(target);
    const updatingRequest = cursor?.purpose === "updates";
    const legacyOpeningRequest =
      requestedLegacy !== undefined &&
      "turnId" in query &&
      (query.anchor.kind === "opening" || cursor?.purpose === "legacyBoundary");
    const openingRequest =
      !requestedLegacy &&
      "turnId" in query &&
      (query.anchor.kind === "opening" || cursor?.purpose === "opening");
    if (
      "cursor" in query.anchor &&
      (!cursor ||
        cursor.thread !== selectedRef.stableThreadId ||
        cursor.lineage !== lineageKey ||
        cursor.turn !== ("turnId" in query ? query.turnId : null))
    ) {
      throw new Error("rollout.invalid_cursor");
    }
    const epochTicket = this.#epochAuthority?.begin(lineage);
    let epochState = epochTicket?.previous ??
      this.#epochs.get(lineageKey) ?? { epoch: randomUUID(), proofs: [] };
    if (cursor && cursor.epoch !== epochState.epoch) {
      throw new Error("rollout.stale_cursor");
    }
    const loaded: Loaded[] = [];
    const leases: SeekableRollout[] = [];
    const deferred: ResolvedRolloutSegment[] = [];
    const legacyCandidates = new Map<string, LegacyTurnWindowIdentity>();
    try {
      for (const segment of lineage.segments) {
        if (
          selectedRef.representation === "plain-jsonl" &&
          segment.ref.physicalRolloutId !== selectedRef.physicalRolloutId &&
          segment.ref.representation === "zstd-jsonl" &&
          query.anchor.kind === "latest" &&
          !("turnId" in query)
        ) {
          deferred.push(segment);
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- Segment windows and cutoffs are read in lineage order
        const lease = await this.#open(segment.ref, signal);
        leases.push(lease);
        // oxlint-disable-next-line no-await-in-loop -- Opening is a separate bounded dependency of the selected tail
        const opening = await readOpeningJsonlWindow(
          lease,
          Math.min(this.#openingBytes, segment.endByteOffset ?? lease.size),
          signal,
        );
        const meta = object(opening.records[0]?.value);
        const payload = object(meta?.["payload"]);
        if (!meta && opening.budgetExceeded) {
          throw new Error("rollout.metadata_budget");
        }
        if (meta?.["type"] !== "session_meta") {
          throw new Error("rollout.unsupported_format");
        }
        if (
          payload?.["id"] !== segment.ref.stableThreadId ||
          (payload["session_id"] ?? null) !== segment.ref.rootSessionId
        ) {
          throw new Error("rollout.identity_mismatch");
        }
        const base = object(payload["history_base"]);
        const expectedBase =
          segment.ref.historyBase === null
            ? null
            : {
                thread_id: segment.ref.historyBase.physicalRolloutId,
                end_ordinal_exclusive: segment.ref.historyBase.endOrdinalExclusive,
                end_byte_offset: segment.ref.historyBase.endByteOffset,
              };
        if (
          !isDeepStrictEqual(base, expectedBase) ||
          (payload["subagent_history_start_ordinal"] ?? null) !==
            segment.ref.subagentHistoryStartOrdinal
        ) {
          throw new Error("rollout.lineage_metadata_changed");
        }
        const endExclusive =
          cursor?.physical === segment.ref.physicalRolloutId
            ? updatingRequest
              ? cursor.selectionEnd!
              : cursor.end
            : (segment.endByteOffset ?? lease.size);
        const tail =
          query.anchor.kind === "after" &&
          !updatingRequest &&
          cursor?.physical === segment.ref.physicalRolloutId
            ? // oxlint-disable-next-line no-await-in-loop -- Forward scanning depends on the issued boundary for this segment
              await readForwardJsonlWindow(
                lease,
                {
                  start: cursor.end,
                  endExclusive: segment.endByteOffset ?? lease.size,
                  maxBytes: this.#maxWindowBytes,
                  maxRecords: "turnId" in query ? 300 : 1500,
                },
                signal,
              )
            : // oxlint-disable-next-line no-await-in-loop -- Reverse scanning depends on this segment's validated opening and cutoff
              await readJsonlWindow(
                lease,
                {
                  endExclusive,
                  maxBytes: this.#maxWindowBytes,
                  maxRecords: "turnId" in query ? 300 : 1500,
                },
                signal,
              );
        if (
          tail.reachedStart &&
          segment.endOrdinalExclusive !== null &&
          (tail.records.at(-1)?.ordinal ?? -1) + 1 !== segment.endOrdinalExclusive
        ) {
          throw new Error("rollout.cutoff_mismatch");
        }
        let suffix: JsonlWindow | undefined;
        if ("turnId" in query && query.anchor.kind !== "latest") {
          if (
            endExclusive === (segment.endByteOffset ?? lease.size) &&
            query.anchor.kind !== "after"
          ) {
            suffix = tail;
          } else {
            // oxlint-disable-next-line no-await-in-loop -- Older item payloads require independent current suffix/update evidence
            suffix = await readJsonlWindow(
              lease,
              {
                endExclusive: segment.endByteOffset ?? lease.size,
                maxBytes: this.#maxWindowBytes,
                maxRecords: 1500,
              },
              signal,
            );
          }
        }
        let search: JsonlWindow | undefined;
        let searchBoundary: JsonlRecord | undefined;
        if (openingRequest && (!cursor || cursor.physical === segment.ref.physicalRolloutId)) {
          // oxlint-disable-next-line no-await-in-loop -- An explicit opening request searches a separate bounded forward window rather than draining the turn tail
          search = await readForwardJsonlWindow(
            lease,
            {
              start: cursor?.purpose === "opening" ? cursor.end : 0,
              endExclusive: segment.endByteOffset ?? lease.size,
              maxBytes: this.#maxWindowBytes,
              maxRecords: 10000,
            },
            signal,
          );
          searchBoundary = cursor?.openingBoundary;
          if (searchBoundary) {
            // oxlint-disable-next-line no-await-in-loop -- A carried boundary is reread before it can authorize a later opening window
            const bytes = await lease.read(
              searchBoundary.byteStart,
              searchBoundary.byteEnd,
              signal,
            );
            if (hash(bytes) !== searchBoundary.rangeSha256) {
              throw new Error("rollout.stale_cursor");
            }
          }
          searchBoundary ??= search.records.find((record) => {
            const candidatePayload = object(object(record.value)?.["payload"]);
            return (
              candidatePayload?.["turn_id"] === target &&
              ["turn_started", "task_started"].includes(text(candidatePayload["type"]) ?? "")
            );
          });
        }
        const previousLegacy =
          requestedLegacy?.physical === segment.ref.physicalRolloutId
            ? requestedLegacy
            : [...this.#legacyWindows.values()].find(
                (window) =>
                  window.physical === segment.ref.physicalRolloutId &&
                  window.epoch === epochState.epoch &&
                  legacyWindowOverlap(segment.ref, window, tail.records),
              );
        if (previousLegacy && previousLegacy.epoch === epochState.epoch) {
          legacyCandidates.set(segment.ref.physicalRolloutId!, previousLegacy);
          if (legacyOpeningRequest) {
            if (previousLegacy.boundary) {
              // oxlint-disable-next-line no-await-in-loop -- A resolved legacy opening has its own bounded source window
              search = await readForwardJsonlWindow(
                lease,
                {
                  start: previousLegacy.boundary.byteStart,
                  endExclusive: segment.endByteOffset ?? lease.size,
                  maxBytes: this.#openingBytes,
                  maxRecords: 10000,
                },
                signal,
              );
            } else {
              // oxlint-disable-next-line no-await-in-loop -- Legacy boundary preparation expands the verified island by one bounded reverse window
              search = await readJsonlWindow(
                lease,
                {
                  endExclusive:
                    cursor?.purpose === "legacyBoundary" ? cursor.end : previousLegacy.start,
                  maxBytes: this.#maxWindowBytes,
                  maxRecords: 1500,
                },
                signal,
              );
            }
          }
        }
        let updateScan: JsonlWindow | undefined;
        if (updatingRequest && cursor.physical === segment.ref.physicalRolloutId) {
          // oxlint-disable-next-line no-await-in-loop -- Update preparation scans one new bounded interval while retaining original item positions
          updateScan = await readForwardJsonlWindow(
            lease,
            {
              start: cursor.end,
              endExclusive: segment.endByteOffset ?? lease.size,
              maxBytes: this.#maxWindowBytes,
              maxRecords: 10000,
            },
            signal,
          );
        }
        loaded.push({
          segment,
          lease,
          opening,
          tail,
          ...(suffix ? { suffix } : {}),
          ...(search ? { search } : {}),
          ...(searchBoundary ? { searchBoundary } : {}),
          ...(updateScan
            ? {
                updateScan,
                carriedUpdates: cursor!.updateRecords ?? [],
                updateCoverage: [
                  ...(cursor!.updateCoverage ?? []),
                  ...(updateScan.errors.length === 0 && updateScan.records.length > 0
                    ? [
                        {
                          start: updateScan.records[0]!.byteStart,
                          endExclusive: updateScan.records.at(-1)!.byteEnd,
                        },
                      ]
                    : []),
                ],
              }
            : {}),
          generation: null,
        });
      }
      let proofBytes = 0;
      let unchanged = true;
      let evidenceUnavailable = false;
      const additionalEpochProofs = new Map<string, HistoryEpochProof["ranges"]>();
      const proofs: Proof[] = mergeProofs([
        ...loaded.map((entry) => ({
          physical: entry.segment.ref.physicalRolloutId!,
          ranges: entry.lease.readRanges(),
        })),
        ...(updatingRequest && cursor.updateProofs
          ? [{ physical: cursor.physical, ranges: cursor.updateProofs }]
          : []),
      ]);
      const priorProofs = mergeProofs([
        ...(cursor?.proofs ?? epochState.proofs),
        ...[...legacyCandidates.values()].map((window) => ({
          physical: window.physical,
          ranges: window.proofs,
        })),
      ]);
      for (const proof of priorProofs) {
        const segment = loaded.find(
          (entry) => entry.segment.ref.physicalRolloutId === proof.physical,
        );
        if (!segment) {
          unchanged = false;
          evidenceUnavailable = true;
          break;
        }
        for (const range of proof.ranges) {
          proofBytes += range.endExclusive - range.start;
          const receivingBudget =
            epochTicket &&
            selectedRef.representation === "plain-jsonl" &&
            query.anchor.kind === "latest" &&
            !("turnId" in query)
              ? this.#maxWindowBytes + this.#openingBytes
              : this.#maxProofBytes;
          if (proofBytes > receivingBudget || range.endExclusive > segment.lease.size) {
            unchanged = false;
            evidenceUnavailable = proofBytes > receivingBudget;
            break;
          }
          const rangeHash = createHash("sha256");
          for (let offset = range.start; offset < range.endExclusive; offset += 64 * 1024) {
            // oxlint-disable-next-line no-await-in-loop -- A receiving backend verifies the exact previous dependency with bounded buffers
            const bytes = await segment.lease.read(
              offset,
              Math.min(offset + 64 * 1024, range.endExclusive),
              signal,
            );
            rangeHash.update(bytes);
          }
          const observedRange = { ...range, sha256: rangeHash.digest("hex") };
          const extra = additionalEpochProofs.get(proof.physical) ?? [];
          extra.push(observedRange);
          additionalEpochProofs.set(proof.physical, extra);
          if (observedRange.sha256 !== range.sha256) {
            unchanged = false;
            break;
          }
        }
        if (!unchanged) {
          break;
        }
      }
      if (!unchanged) {
        if (!evidenceUnavailable) {
          epochState = { epoch: randomUUID(), proofs: [] };
        }
        if (cursor) {
          this.#epochs.set(lineageKey, epochState);
          throw new Error("rollout.stale_cursor");
        }
      }
      const turns: HistoryTurnWindow[] = [];
      const reviewRecords: ReviewSourceRecord[] = [];
      const stagedLegacyWindows: LegacyTurnWindowIdentity[] = [];
      const boundaries = new Map<string, { start: number; end: number }>();
      const selectedItems = new Map<string, ItemEntry[]>();
      let inherited: AssemblyContext | undefined =
        deferred.length > 0 || lineage.status === "unresolved"
          ? { context: { model: null, effort: null, cwd: null, complete: false }, calls: new Map() }
          : undefined;
      let previousSegmentIndex = -1;
      const coverage: HistoryCoverage = {
        status: lineage.status === "complete" && deferred.length === 0 ? "complete" : "unresolved",
        segments: deferred.map((segment) => ({
          physicalRolloutId: segment.ref.physicalRolloutId!,
          endOrdinalExclusive: segment.endOrdinalExclusive,
          endDecodedByteExclusive: segment.endByteOffset,
          coveredRanges: [],
          projectionWatermark: null,
          sourceWatermark: null,
        })),
        gaps: [
          ...lineage.diagnostics.map((diagnostic) => ({
            physicalRolloutId: diagnostic.physicalRolloutId ?? selectedRef.physicalRolloutId!,
            turnId: null,
            reason: diagnostic.code,
            beforeOrdinal: null,
            afterOrdinal: null,
          })),
          ...deferred.map((segment) => ({
            physicalRolloutId: segment.ref.physicalRolloutId!,
            turnId: null,
            reason: "ancestor-preparation-pending",
            beforeOrdinal: null,
            afterOrdinal: null,
          })),
        ],
      };
      for (const entry of loaded) {
        const { segment, tail, opening } = entry;
        const candidate = legacyCandidates.get(segment.ref.physicalRolloutId!);
        const previousLegacy = candidate?.epoch === epochState.epoch ? candidate : null;
        const legacyWindow = planLegacyWindow(
          segment.ref,
          epochState.epoch,
          [tail, ...(legacyOpeningRequest && entry.search ? [entry.search] : [])],
          evidenceUnavailable && previousLegacy
            ? {
                ...previousLegacy,
                boundary: null,
                start: tail.records[0]?.byteStart ?? previousLegacy.start,
                end: tail.records.at(-1)?.byteEnd ?? previousLegacy.end,
                proofs: [],
                clean: true,
              }
            : previousLegacy,
          entry.lease.readRanges(),
          requestedLegacy?.id === previousLegacy?.id && previousLegacy !== null,
        );
        if (legacyWindow) {
          entry.legacy = legacyWindow;
          if (legacyWindow.boundary) {
            entry.searchBoundary = legacyWindow.boundary;
          }
          stagedLegacyWindows.push(legacyWindow);
          const proof = proofs.find(
            (candidateProof) => candidateProof.physical === legacyWindow.physical,
          );
          if (proof) {
            proof.ranges = [
              ...new Map(
                [...proof.ranges, ...legacyWindow.proofs].map((range) => [
                  `${range.start}:${range.endExclusive}`,
                  range,
                ]),
              ).values(),
            ];
          }
        }
        const currentSegmentIndex = lineage.segments.indexOf(segment);
        if (
          deferred.some((skipped) => {
            const index = lineage.segments.indexOf(skipped);
            return index > previousSegmentIndex && index < currentSegmentIndex;
          })
        ) {
          inherited = {
            context: { model: null, effort: null, cwd: null, complete: false },
            calls: new Map(),
          };
        }
        previousSegmentIndex = currentSegmentIndex;
        const physical = segment.ref.physicalRolloutId!;
        const assembled = assembleHistoryRecords(entry, inherited);
        reviewRecords.push(...assembled.reviewRecords);
        inherited = tail.reachedStart && tail.errors.length === 0 ? assembled.carried : undefined;
        const full =
          tail.reachedStart &&
          (tail.records.at(-1)?.byteEnd ?? 0) >= (segment.endByteOffset ?? entry.lease.size) &&
          !tail.unfinishedFinalRecord &&
          tail.errors.length === 0 &&
          !assembled.unsupported &&
          !assembled.unresolvedCutoff;
        const ranges = [
          opening,
          tail,
          ...(entry.suffix ? [entry.suffix] : []),
          ...(entry.search ? [entry.search] : []),
          ...(entry.updateScan ? [entry.updateScan] : []),
        ].flatMap((window) =>
          window.records.length
            ? [
                {
                  physicalRolloutId: physical,
                  startOrdinal: window.records[0]!.ordinal ?? null,
                  endOrdinalExclusive:
                    window.records.at(-1)!.ordinal === undefined
                      ? null
                      : window.records.at(-1)!.ordinal! + 1,
                  startDecodedByte: window.records[0]!.byteStart,
                  endDecodedByteExclusive: window.records.at(-1)!.byteEnd,
                },
              ]
            : [],
        );
        coverage.segments.push({
          physicalRolloutId: physical,
          endOrdinalExclusive: segment.endOrdinalExclusive,
          endDecodedByteExclusive: segment.endByteOffset,
          coveredRanges: ranges,
          projectionWatermark: null,
          sourceWatermark: full
            ? {
                nextOrdinal: tail.records.at(-1)!.ordinal! + 1,
                nextByteOffset: tail.records.at(-1)!.byteEnd,
              }
            : null,
        });
        if (!full) {
          if (coverage.status === "complete") {
            coverage.status = "partial";
          }
          coverage.gaps.push({
            physicalRolloutId: physical,
            turnId: target,
            reason: assembled.unresolvedCutoff
              ? "ordinal-cutoff-unproved"
              : tail.errors.length || assembled.unsupported
                ? "unresolved-records"
                : tail.unfinishedFinalRecord
                  ? "unfinished-final-record"
                  : "unloaded-history",
            beforeOrdinal: null,
            afterOrdinal: null,
          });
        }
        for (const turn of assembled.turns) {
          if (target && turn.id !== target) {
            continue;
          }
          if (cursor && !("turnId" in query)) {
            const segmentIndex = lineage.segments.findIndex(
              (dependency) => dependency.ref.physicalRolloutId === physical,
            );
            const cursorIndex = lineage.segments.findIndex(
              (dependency) => dependency.ref.physicalRolloutId === cursor.physical,
            );
            if (
              query.anchor.kind === "before" &&
              (segmentIndex > cursorIndex ||
                (segmentIndex === cursorIndex && turn.start.byteStart >= cursor.end))
            ) {
              continue;
            }
            if (
              query.anchor.kind === "after" &&
              (segmentIndex < cursorIndex ||
                (segmentIndex === cursorIndex && turn.start.byteStart < cursor.end))
            ) {
              continue;
            }
          }
          boundaries.set(`${physical}:${turn.id}`, { start: turn.start.byteStart, end: turn.end });
          const all = [...turn.items.values()].toSorted(
            (a, b) => a.record.byteStart - b.record.byteStart,
          );
          const openingItem = all.find((item) => item.item.type !== "contextCompaction");
          const limit =
            "turnId" in query
              ? updatingRequest
                ? (cursor.selectionLimit ?? 100)
                : (query.limit ?? (query.anchor.kind === "opening" ? 2 : 100))
              : 100;
          let candidates = all;
          if (cursor && "turnId" in query && !openingRequest && !legacyOpeningRequest) {
            candidates = all.filter((item) =>
              query.anchor.kind === "before" || updatingRequest
                ? item.record.byteStart < (updatingRequest ? cursor.selectionEnd! : cursor.end)
                : item.record.byteStart >= cursor.end,
            );
          }
          if (openingRequest || legacyOpeningRequest) {
            candidates =
              entry.searchBoundary && entry.search
                ? all.filter(
                    (item) =>
                      item.record.byteStart >= entry.searchBoundary!.byteStart &&
                      item.record.byteEnd <=
                        (entry.search!.records.at(-1)?.byteEnd ?? entry.searchBoundary!.byteEnd),
                  )
                : [];
            const first = candidates.findIndex((item) => item.item.type !== "contextCompaction");
            candidates =
              first < 0 || candidates[first]?.item.type !== "userMessage"
                ? []
                : candidates.slice(first);
          }
          const chosen =
            "turnId" in query &&
            (openingRequest ||
              legacyOpeningRequest ||
              (query.anchor.kind === "after" && !updatingRequest))
              ? candidates.slice(0, limit)
              : candidates.slice(-limit);
          selectedItems.set(`${physical}:${turn.id}`, chosen);
          const currentItems = chosen.map((item) => {
            let qualifiedThrough = item.updatedRecord.byteStart;
            const intervals = [
              ...[
                opening,
                tail,
                ...(entry.suffix ? [entry.suffix] : []),
                ...(entry.search ? [entry.search] : []),
                ...(entry.updateScan ? [entry.updateScan] : []),
              ]
                .filter((window) => window.errors.length === 0 && window.records.length > 0)
                .map((window) => ({
                  start: window.records[0]!.byteStart,
                  endExclusive: window.records.at(-1)!.byteEnd,
                })),
              ...(entry.updateCoverage ?? []),
            ].toSorted((left, right) => left.start - right.start);
            for (const interval of intervals) {
              const start = interval.start;
              const end = interval.endExclusive;
              if (
                start !== undefined &&
                end !== undefined &&
                start <= qualifiedThrough &&
                end > qualifiedThrough
              ) {
                qualifiedThrough = end;
              }
            }
            const current =
              !("turnId" in query) ||
              query.anchor.kind === "latest" ||
              qualifiedThrough >= (segment.endByteOffset ?? entry.lease.size);
            return { ...item, current };
          });
          const explicitFinal = all.findLast(
            (finalRecord) =>
              finalRecord.item.type === "agentMessage" &&
              isFinalAnswerPhase(finalRecord.item.phase),
          );
          const completionFinal =
            explicitFinal || !turn.completion
              ? undefined
              : currentItems.findLast(
                  (finalRecord) =>
                    finalRecord.current &&
                    finalRecord.item.type === "agentMessage" &&
                    isFinalAnswerEligible(
                      finalRecord.item.phase,
                      finalRecord.item.text,
                      turn.completion!.text,
                    ),
                );
          const finalAnswerItemId = (explicitFinal ?? completionFinal)?.item.id ?? null;
          const turnCoverage: HistoryCoverage = structuredClone(coverage);
          const itemComplete =
            full &&
            chosen.length === all.length &&
            coverage.status === "complete" &&
            currentItems.every((item) => item.current);
          if (currentItems.some((item) => !item.current)) {
            if (turnCoverage.status === "complete") {
              turnCoverage.status = "partial";
            }
            turnCoverage.gaps.push({
              physicalRolloutId: physical,
              turnId: turn.id,
              reason: "unverified-item-updates",
              beforeOrdinal: null,
              afterOrdinal: null,
            });
          }
          if (!itemComplete && turnCoverage.status === "complete") {
            turnCoverage.status = "partial";
          }
          const replaced = turns.findIndex((existing) => existing.turnId === turn.id);
          if (replaced >= 0) {
            turns.splice(replaced, 1);
          }
          turns.push({
            turnId: turn.id,
            physicalRolloutId: physical,
            order: turn.start.ordinal ?? turn.start.byteStart,
            decodedByteOrder: turn.start.byteStart,
            orderKind: turn.start.ordinal === undefined ? "decodedByte" : "ordinal",
            boundary:
              entry.legacy?.id === turn.id
                ? {
                    status: entry.legacy.boundary ? "verified" : "unresolved",
                    sourceTurnId: null,
                    decodedByteStart: entry.legacy.boundary?.byteStart ?? null,
                    identityAliases: entry.legacy.boundary ? entry.legacy.aliases : [],
                  }
                : {
                    status:
                      turn.id.startsWith("raw-turn-") || turn.boundary ? "verified" : "unresolved",
                    sourceTurnId: turn.id.startsWith("raw-turn-") ? null : turn.id,
                    decodedByteStart:
                      turn.id.startsWith("raw-turn-") || turn.boundary
                        ? turn.start.byteStart
                        : null,
                    identityAliases: [],
                  },
            context: turn.context,
            status: turn.status,
            startedAt: turn.startedAt,
            completedAt: turn.completedAt,
            durationMs: turn.durationMs,
            opening: {
              itemId: openingItem?.item.type === "userMessage" ? openingItem.item.id : null,
              availability:
                openingItem?.item.type === "userMessage"
                  ? "available"
                  : full
                    ? "absent"
                    : "notLoaded",
              item: openingItem?.item.type === "userMessage" ? openingItem.item : null,
            },
            items: currentItems.map(({ item, record, updatedRecord, current }) => ({
              physicalRolloutId: physical,
              ordinal: record.ordinal ?? null,
              decodedByteStart: record.byteStart,
              decodedByteEnd: record.byteEnd,
              updatedAtOrdinal: updatedRecord.ordinal ?? null,
              updatedAtDecodedByte: updatedRecord.byteStart,
              detail: current ? "full" : "unresolved",
              itemId: item.id,
              item:
                completionFinal?.item.id === item.id && turn.completion
                  ? {
                      ...item,
                      evidence: {
                        ...object(item.evidence),
                        finalAnswerEvidence: {
                          envelope: turn.completion.record.value,
                          identity: jsonValueSchema.parse(turn.completion.record.identity ?? null),
                        },
                      },
                    }
                  : item,
            })),
            itemsView: chosen.length === 0 ? "notLoaded" : itemComplete ? "full" : "summary",
            beforeCursor: null,
            afterCursor: null,
            loadedRanges: ranges,
            coverage: turnCoverage,
            finalAnswerItemId,
            historyEpoch: epochState.epoch,
            contentRevision: "pending",
          });
        }
      }
      if (openingRequest && target !== null && turns.length === 0) {
        const searching = loaded.findLast((entry) => entry.search !== undefined)!;
        const physical = searching.segment.ref.physicalRolloutId!;
        const pendingCoverage: HistoryCoverage = {
          ...structuredClone(coverage),
          status: "unresolved",
          gaps: [
            ...coverage.gaps,
            {
              physicalRolloutId: physical,
              turnId: target,
              reason: "opening-boundary-not-loaded",
              beforeOrdinal: null,
              afterOrdinal: null,
            },
          ],
        };
        const start = searching.search!.scannedStart;
        boundaries.set(`${physical}:${target}`, { start, end: searching.search!.nextEndExclusive });
        turns.push({
          turnId: target,
          physicalRolloutId: physical,
          order: start,
          decodedByteOrder: start,
          orderKind: "decodedByte",
          boundary: {
            status: "unresolved",
            sourceTurnId: null,
            decodedByteStart: null,
            identityAliases: [],
          },
          context: { model: null, effort: null, cwd: null, complete: false },
          status: "unknown",
          startedAt: null,
          completedAt: null,
          durationMs: null,
          opening: { itemId: null, availability: "notLoaded", item: null },
          items: [],
          itemsView: "notLoaded",
          beforeCursor: null,
          afterCursor: null,
          loadedRanges:
            coverage.segments.find((segment) => segment.physicalRolloutId === physical)
              ?.coveredRanges ?? [],
          coverage: pendingCoverage,
          finalAnswerItemId: null,
          historyEpoch: epochState.epoch,
          contentRevision: "pending",
        });
      }
      for (const entry of loaded) {
        // oxlint-disable-next-line no-await-in-loop -- Commit page evidence only after every selected lease verifies
        entry.generation = await entry.lease.verify(signal);
      }
      for (const entry of loaded) {
        // oxlint-disable-next-line no-await-in-loop -- Publication checks every contributing source again after all dependency verifications
        const observed = await observeSessionMetaSource(entry.lease.ref.sourcePath);
        const expected = entry.generation!.observation;
        if (
          String(observed.device) !== expected.device ||
          String(observed.inode) !== expected.inode ||
          Number(observed.size) !== expected.encodedSize ||
          String(observed.mtimeNs) !== expected.mtimeNs ||
          String(observed.ctimeNs) !== expected.ctimeNs
        ) {
          throw new Error("rollout.source_changed_before_publish");
        }
      }
      const epochObservations: HistoryEpochProof[] = loaded.map((entry) => ({
        physical: entry.segment.ref.physicalRolloutId!,
        decodedSize: entry.lease.size,
        ranges: [
          ...entry.lease.readRanges(),
          ...(additionalEpochProofs.get(entry.segment.ref.physicalRolloutId!) ?? []),
        ],
      }));
      const epochSelection = epochTicket
        ? this.#epochAuthority!.select(epochTicket, epochObservations, epochState.epoch)
        : undefined;
      const staleEpoch = epochTicket !== undefined ? epochSelection === null : evidenceUnavailable;
      if (epochSelection) {
        epochState = { epoch: epochSelection.epoch, proofs };
      }
      if (staleEpoch) {
        epochState = {
          epoch: this.#epochAuthority?.begin(lineage).previous?.epoch ?? epochState.epoch,
          proofs: [],
        };
        coverage.status = "unresolved";
        coverage.gaps.push({
          physicalRolloutId: selectedRef.physicalRolloutId!,
          turnId: null,
          reason: "epoch-dependencies-unverified",
          beforeOrdinal: null,
          afterOrdinal: null,
        });
      }
      if (staleEpoch) {
        for (let index = 0; index < reviewRecords.length; index += 1) {
          reviewRecords[index] = unverifiedReviewRecord(reviewRecords[index]!);
        }
      }
      const unresolvedReviewScope = reviewRecords.some(
        (record) => record.logicalVisibility === "unresolved",
      );
      const revision = hash(JSON.stringify(proofs));
      const limit =
        "turnId" in query ? 1 : (query.limit ?? (query.anchor.kind === "latest" ? 5 : 20));
      const selected = query.anchor.kind === "after" ? turns.slice(0, limit) : turns.slice(-limit);
      for (const turn of selected) {
        turn.historyEpoch = epochState.epoch;
        turn.contentRevision = revision;
        turn.reviewEvidence = {
          availability:
            staleEpoch ||
            unresolvedReviewScope ||
            coverage.status === "unresolved" ||
            coverage.status === "unsupported"
              ? "unresolved"
              : coverage.status === "complete"
                ? "complete"
                : "partial",
          records: reviewRecords.filter(
            (record) =>
              record.identity.physicalRolloutId === turn.physicalRolloutId &&
              text(object(object(record.envelope)?.["params"])?.["turnId"]) ===
                (turn.boundary?.sourceTurnId ?? turn.turnId),
          ),
        };
        if (staleEpoch) {
          turn.itemsView = "summary";
          turn.coverage = structuredClone(coverage);
          continue;
        }
        const openingSource = loaded.find(
          (entry) => entry.segment.ref.physicalRolloutId === turn.physicalRolloutId,
        );
        if (
          (openingRequest || legacyOpeningRequest) &&
          turn.items.length === 0 &&
          openingSource?.search
        ) {
          const next = legacyOpeningRequest
            ? (openingSource.legacy?.start ?? 0)
            : openingSource.search.nextEndExclusive;
          const canContinue = legacyOpeningRequest
            ? next > 0 &&
              next < (cursor?.purpose === "legacyBoundary" ? cursor.end : requestedLegacy.start)
            : next > (cursor?.purpose === "opening" ? cursor.end : 0) &&
              next < (openingSource.segment.endByteOffset ?? openingSource.lease.size);
          const purpose = legacyOpeningRequest ? "legacyBoundary" : "opening";
          const continuation = canContinue
            ? this.#issue({
                purpose,
                ...(openingSource.searchBoundary
                  ? { openingBoundary: openingSource.searchBoundary }
                  : {}),
                thread: selectedRef.stableThreadId,
                lineage: lineageKey,
                epoch: epochState.epoch,
                physical: turn.physicalRolloutId,
                end: next,
                turn: turn.turnId,
                proofs,
              })
            : null;
          turn.preparation = { kind: purpose, cursor: continuation };
          turn.afterCursor = continuation;
          turn.coverage.status = "unresolved";
          turn.coverage.gaps.push({
            physicalRolloutId: turn.physicalRolloutId,
            turnId: turn.turnId,
            reason: "opening-boundary-not-loaded",
            beforeOrdinal: null,
            afterOrdinal: null,
          });
          continue;
        }
        if (
          "turnId" in query &&
          cursor &&
          (query.anchor.kind === "before" || updatingRequest) &&
          turn.items.some((item) => item.detail === "unresolved") &&
          openingSource
        ) {
          const selectionEnd = updatingRequest ? cursor.selectionEnd! : cursor.end;
          const retained = (selectedItems.get(`${turn.physicalRolloutId}:${turn.turnId}`) ?? [])
            .filter((item) => item.canonical && item.updatedRecord.byteStart >= selectionEnd)
            .map((item) => item.updatedRecord);
          const bytes = retained.reduce((sum, record) => sum + Buffer.byteLength(record.raw), 0);
          const next = openingSource.updateScan?.nextEndExclusive ?? selectionEnd;
          const updateProofs = [
            ...(cursor.updateProofs ?? []),
            ...(openingSource.updateScan
              ? openingSource.lease
                  .readRanges()
                  .filter(
                    (range) =>
                      range.start === cursor.end &&
                      range.endExclusive <=
                        Math.min(
                          cursor.end + this.#maxWindowBytes,
                          openingSource.segment.endByteOffset ?? openingSource.lease.size,
                        ),
                  )
              : []),
            ...retained.map((record) => ({
              start: record.byteStart,
              endExclusive: record.byteEnd,
              sha256: record.rangeSha256!,
            })),
          ];
          const nextProofs = mergeProofs([
            ...proofs,
            { physical: turn.physicalRolloutId, ranges: updateProofs },
          ]);
          const canContinue =
            bytes <= this.#maxWindowBytes &&
            next < (openingSource.segment.endByteOffset ?? openingSource.lease.size) &&
            (!updatingRequest || next > cursor.end);
          const preparationCursor = canContinue
            ? this.#issue({
                purpose: "updates",
                selectionEnd,
                selectionLimit: turn.items.length,
                updateRecords: retained,
                updateCoverage: openingSource.updateCoverage ?? [],
                updateProofs,
                thread: selectedRef.stableThreadId,
                lineage: lineageKey,
                epoch: epochState.epoch,
                physical: turn.physicalRolloutId,
                end: next,
                turn: turn.turnId,
                proofs: nextProofs,
              })
            : null;
          turn.preparation = { kind: "updates", cursor: preparationCursor };
        }
        if (
          turn.itemsView !== "full" &&
          turn.items[0]?.decodedByteStart !== undefined &&
          turn.items[0].decodedByteStart > 0
        ) {
          turn.beforeCursor = this.#issue({
            thread: selectedRef.stableThreadId,
            lineage: lineageKey,
            epoch: epochState.epoch,
            physical: turn.physicalRolloutId,
            end: turn.items[0].decodedByteStart,
            turn: turn.turnId,
            proofs,
          });
        }
        const lastItem = turn.items.at(-1);
        const boundary = boundaries.get(`${turn.physicalRolloutId}:${turn.turnId}`)!;
        if (
          lastItem?.decodedByteEnd !== undefined &&
          (lastItem.decodedByteEnd < boundary.end || query.anchor.kind === "before")
        ) {
          turn.afterCursor = this.#issue({
            thread: selectedRef.stableThreadId,
            lineage: lineageKey,
            epoch: epochState.epoch,
            physical: turn.physicalRolloutId,
            end: lastItem.decodedByteEnd,
            turn: turn.turnId,
            proofs,
          });
        }
      }
      const first = selected[0];
      const firstByte = first
        ? boundaries.get(`${first.physicalRolloutId}:${first.turnId}`)!.start
        : 0;
      const beforeCursor =
        !staleEpoch &&
        first &&
        (turns.length > selected.length || coverage.status !== "complete") &&
        firstByte > 0
          ? this.#issue({
              thread: selectedRef.stableThreadId,
              lineage: lineageKey,
              epoch: epochState.epoch,
              physical: first.physicalRolloutId,
              end: firstByte,
              turn: null,
              proofs,
            })
          : null;
      const last = selected.at(-1);
      const afterCursor =
        !staleEpoch &&
        last &&
        (query.anchor.kind === "before" ||
          (query.anchor.kind === "after" && turns.length > selected.length))
          ? this.#issue({
              thread: selectedRef.stableThreadId,
              lineage: lineageKey,
              epoch: epochState.epoch,
              physical: last.physicalRolloutId,
              end: boundaries.get(`${last.physicalRolloutId}:${last.turnId}`)!.end,
              turn: null,
              proofs,
            })
          : null;
      if (turns.length > selected.length) {
        if (coverage.status === "complete") {
          coverage.status = "partial";
        }
        coverage.gaps.push({
          physicalRolloutId: selectedRef.physicalRolloutId!,
          turnId: null,
          reason: "unloaded-turns",
          beforeOrdinal: null,
          afterOrdinal: null,
        });
      }
      if (cursor && coverage.status === "complete") {
        coverage.status = "partial";
        coverage.gaps.push({
          physicalRolloutId: selectedRef.physicalRolloutId!,
          turnId: null,
          reason: "outside-page-boundary",
          beforeOrdinal: null,
          afterOrdinal: null,
        });
      }
      if (coverage.status === "complete") {
        coverage.total = turns.length;
      }
      if (epochSelection) {
        this.#epochAuthority!.publish(epochSelection, proofs);
      }
      if (!staleEpoch) {
        this.#epochs.set(lineageKey, { epoch: epochState.epoch, proofs });
        for (const window of stagedLegacyWindows) {
          const committed = { ...window, epoch: epochState.epoch };
          this.#legacyWindows.set(window.id, committed);
          for (const alias of window.aliases) {
            this.#legacyWindows.set(alias, {
              ...committed,
              id: alias,
              aliases: [...new Set([window.id, ...window.aliases.filter((id) => id !== alias)])],
            });
          }
        }
        while (this.#legacyWindows.size > 128) {
          this.#legacyWindows.delete(this.#legacyWindows.keys().next().value!);
        }
      }
      if (this.#epochs.size > 128) {
        this.#epochs.delete(this.#epochs.keys().next().value!);
      }
      return historyPageSchema.parse({
        ...(staleEpoch ? { stale: true } : {}),
        threadId: selectedRef.stableThreadId,
        metadataRevision: null,
        historyEpoch: epochState.epoch,
        contentRevision: revision,
        turns: selected,
        beforeCursor,
        afterCursor,
        coverage,
        preparation: coverage.status === "complete" ? "ready" : "partial",
        reviewEvidence: {
          availability:
            staleEpoch ||
            unresolvedReviewScope ||
            coverage.status === "unresolved" ||
            coverage.status === "unsupported"
              ? "unresolved"
              : coverage.status === "complete"
                ? "complete"
                : "partial",
          records: reviewRecords,
        },
      });
    } finally {
      await Promise.all(leases.map((lease) => lease.close()));
    }
  }
}
const defaultReader = new RolloutHistoryReader();
export function readRolloutHistoryPage(
  lineage: ResolvedRolloutLineage,
  query: HistoryPageQuery,
  signal?: AbortSignal,
): Promise<HistoryPage> {
  return defaultReader.read(lineage, query, signal);
}
