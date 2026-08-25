import { createHash } from "node:crypto";
import { basename } from "node:path";

import {
  conversationSummarySchema,
  conversationTurnSchema,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_REFERENCE_PREVIEW_LENGTH,
  type ActivityStatus,
  type CompactionActivity,
  type ConversationActivity,
  type ConversationMessage,
  type ConversationScope,
  type ConversationSummary,
  type ConversationTurn,
  type JsonObject,
  type JsonValue,
  type MediaActivity,
  type MediaReference,
  type MediaReferenceProvenance,
  type PatchActivity,
  type PlanActivity,
  type ReasoningActivity,
  type StatusActivity,
  type SubagentActivity,
  type TokenUsage,
  type TurnEntryReference,
  type WebSearchActivity,
} from "../../shared/types/conversation.ts";
import { createViewerDiagnostic, type ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import type { RichTextDocument } from "../../shared/types/richText.ts";
import type { JsonlRecord } from "../ingestion/jsonlStream.ts";
import type { SessionIndexEntry } from "../metadata/sessionIndex.ts";
import type { StateMetadataSnapshot } from "../metadata/stateSnapshot.ts";
import {
  codexEventType,
  isUnknownCodexEvent,
  parseCodexEvent,
  payloadObject,
  sessionMetaPayloadSchema,
  type CodexEvent,
  type TurnScopedEvent,
} from "./eventSchema.ts";
import { mergeSessionMetadata } from "./metadataMerge.ts";
import { pairToolCalls } from "./toolPairing.ts";
import { assembleTurnEvents, type AssembledTurnEvents } from "./turnAssembler.ts";
import { createUnknownActivity, sanitizeUnknownPayload } from "./unknownEvents.ts";

const filenameUuidPattern =
  /([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?=\.jsonl$)/i;
const epochTimestamp = "1970-01-01T00:00:00.000Z";
export const NORMALIZATION_PARSER_VERSION = 4;

export interface NormalizeSessionInput {
  records: readonly JsonlRecord[];
  sourcePath: string;
  scope: ConversationScope;
  sessionIndexEntries: SessionIndexEntry[];
  stateSnapshot: StateMetadataSnapshot | null;
  revision?: string | undefined;
}

export interface NormalizedRawEvent {
  id: string;
  turnId: string | null;
  type: string;
  timestamp: string | null;
  payload: JsonValue;
}

export interface NormalizedSession {
  summary: ConversationSummary;
  turns: ConversationTurn[];
  rawEvents: NormalizedRawEvent[];
}

export interface NormalizeSessionResult {
  session: NormalizedSession | null;
  diagnostics: ViewerDiagnostic[];
}

interface SessionMetaEvidence {
  id: string | null;
  timestamp: string | null;
  cwd: string | null;
  gitBranch: string | null;
  gitSha: string | null;
  gitOriginUrl: string | null;
  parentThreadId: string | null;
}

interface MessageCandidate {
  event: CodexEvent;
  id: string;
  phase: string | null;
  source: "event_msg" | "response_item";
  timestamp: string;
  text: string;
  rawEventId: string;
}

interface MergedMessageCandidate extends MessageCandidate {
  events: CodexEvent[];
  rawEventIds: string[];
}

function objectValue(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numberValue(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestampValue(value: JsonValue | undefined): string | null {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  return new Date(milliseconds).toISOString();
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function plainDocument(text: string): RichTextDocument {
  return {
    type: "document" as const,
    children: text === "" ? [] : [{ type: "text" as const, text }],
  };
}

function contentText(value: JsonValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .flatMap((item) => {
      const content = objectValue(item);
      const text = stringValue(content?.["text"]);
      return text === null ? [] : [text];
    })
    .join("\n");
}

function eventTimestamp(event: CodexEvent, fallback: string): string {
  return event.timestamp ?? fallback;
}

function statusValue(value: JsonValue | undefined): ActivityStatus {
  if (typeof value !== "string") {
    return "unknown";
  }
  switch (value.toLowerCase()) {
    case "completed":
    case "complete":
    case "succeeded":
    case "success":
      return "succeeded";
    case "failed":
    case "error":
      return "failed";
    case "aborted":
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "running":
    case "in_progress":
      return "running";
    case "pending":
      return "pending";
    default:
      return "unknown";
  }
}

function planStatus(value: JsonValue | undefined): "pending" | "in_progress" | "completed" {
  const status = statusValue(value);
  return status === "succeeded" ? "completed" : status === "running" ? "in_progress" : "pending";
}

function sessionMeta(events: readonly CodexEvent[]): SessionMetaEvidence {
  const evidence: SessionMetaEvidence = {
    id: null,
    timestamp: null,
    cwd: null,
    gitBranch: null,
    gitSha: null,
    gitOriginUrl: null,
    parentThreadId: null,
  };
  for (const event of events) {
    if (event.type !== "session_meta") {
      continue;
    }
    const parsed = sessionMetaPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      const payload = payloadObject(event);
      evidence.id ??= stringValue(payload?.["id"]) ?? stringValue(payload?.["session_id"]);
      continue;
    }
    const payload = parsed.data;
    evidence.id ??= payload.id ?? payload.session_id ?? null;
    evidence.timestamp ??= payload.timestamp ?? event.timestamp;
    evidence.cwd = nonEmpty(payload.cwd) ?? evidence.cwd;
    evidence.parentThreadId =
      nonEmpty(payload.parent_thread_id) ??
      nonEmpty(payload.forked_from_id) ??
      evidence.parentThreadId;
    evidence.gitBranch = nonEmpty(payload.git?.branch) ?? evidence.gitBranch;
    evidence.gitSha = nonEmpty(payload.git?.commit_hash) ?? evidence.gitSha;
    evidence.gitOriginUrl = nonEmpty(payload.git?.repository_url) ?? evidence.gitOriginUrl;
  }
  return evidence;
}

function filenameSessionId(path: string): string | null {
  return filenameUuidPattern.exec(basename(path))?.[1] ?? null;
}

function invalidEnvelopeDiagnostic(path: string, line: number): ViewerDiagnostic {
  return createViewerDiagnostic({
    code: "source.invalid_jsonl",
    severity: "warning",
    area: "source",
    message: "A rollout record has an invalid event envelope and was skipped.",
    path,
    details: { line },
  });
}

function missingSessionIdDiagnostic(path: string): ViewerDiagnostic {
  return createViewerDiagnostic({
    code: "source.invalid_jsonl",
    severity: "error",
    area: "source",
    message: "A rollout session identity could not be determined.",
    path,
    recoverable: false,
    details: { reason: "missing-session-id" },
  });
}

function mediaReferenceHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalidMediaReference(
  value: string | null,
  reason: Extract<MediaReference, { kind: "invalid" }>["reason"],
): MediaReference {
  return {
    kind: "invalid",
    reason,
    preview: value?.slice(0, MAX_MEDIA_REFERENCE_PREVIEW_LENGTH) ?? "",
    sourceHash: value === null ? null : mediaReferenceHash(value),
  };
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^(?:[a-z]:[\\/]|\\\\|\/)/iu.test(value);
}

function percentDecodedSize(payload: string): number | null {
  let size = 0;
  for (let index = 0; index < payload.length;) {
    if (payload[index] === "%") {
      if (!/^[\da-f]{2}$/iu.test(payload.slice(index + 1, index + 3))) {
        return null;
      }
      size += 1;
      index += 3;
    } else {
      const codePoint = payload.codePointAt(index);
      if (codePoint === undefined) {
        return null;
      }
      const character = String.fromCodePoint(codePoint);
      size += Buffer.byteLength(character);
      index += character.length;
    }
    if (size > MAX_MEDIA_BYTES) {
      return size;
    }
  }
  return size;
}

function supportedDataMime(mediaType: MediaActivity["mediaType"], mimeType: string): boolean {
  if (!mimeType.startsWith("image/") && !mimeType.startsWith("audio/")) {
    return false;
  }
  return mediaType === "file" || mimeType.startsWith(`${mediaType}/`);
}

function classifyDataReference(
  value: string,
  mediaType: MediaActivity["mediaType"],
): MediaReference {
  const separator = value.indexOf(",");
  if (separator < 6) {
    return invalidMediaReference(value, "malformed-data");
  }
  const header = value.slice(5, separator);
  const [declaredMimeType, ...parameters] = header.split(";");
  const mimeType = declaredMimeType?.trim().toLowerCase() ?? "";
  if (
    mimeType === "" ||
    !supportedDataMime(mediaType, mimeType) ||
    parameters.some((parameter) => parameter !== "base64" && !parameter.startsWith("charset=")) ||
    parameters.filter((parameter) => parameter === "base64").length > 1
  ) {
    return invalidMediaReference(value, "unsupported-media-type");
  }
  const payload = value.slice(separator + 1);
  const encoding = parameters.includes("base64") ? "base64" : "percent";
  let decodedSize: number | null;
  if (encoding === "base64") {
    if (payload.length % 4 !== 0 || !/^[a-z\d+/]*={0,2}$/iu.test(payload)) {
      return invalidMediaReference(value, "malformed-data");
    }
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    decodedSize = (payload.length / 4) * 3 - padding;
  } else {
    decodedSize = percentDecodedSize(payload);
    if (decodedSize === null) {
      return invalidMediaReference(value, "malformed-data");
    }
  }
  if (decodedSize > MAX_MEDIA_BYTES) {
    return invalidMediaReference(value, "oversized-data");
  }
  return {
    kind: "data",
    mimeType,
    encoding,
    payload,
    sourceHash: mediaReferenceHash(value),
  };
}

function classifyMediaReference(
  value: string | null,
  mediaType: MediaActivity["mediaType"],
  provenance: MediaReferenceProvenance,
): MediaReference {
  if (value === null) {
    return invalidMediaReference(null, "missing");
  }
  const normalized = value.trim();
  if (normalized === "") {
    return invalidMediaReference(value, "empty");
  }
  if (normalized.startsWith("data:")) {
    return classifyDataReference(normalized, mediaType);
  }
  if (isAbsoluteLocalPath(normalized)) {
    return normalized.length <= 4_096
      ? { kind: "local-file", path: normalized, provenance }
      : invalidMediaReference(normalized, "malformed-path");
  }
  try {
    const url = new URL(normalized);
    if ((url.protocol === "http:" || url.protocol === "https:") && normalized.length <= 2_048) {
      return { kind: "remote", url: normalized };
    }
    return invalidMediaReference(normalized, "unsupported-scheme");
  } catch {
    return invalidMediaReference(normalized, "relative-path");
  }
}

function attachmentSources(
  event: CodexEvent,
): Array<{ mediaType: MediaActivity["mediaType"]; reference: MediaReference }> {
  const payload = payloadObject(event);
  if (payload === null) {
    return [];
  }
  const sources: Array<{ mediaType: MediaActivity["mediaType"]; reference: MediaReference }> = [];
  if (event.type === "event_msg" && event.payloadType === "user_message") {
    for (const key of ["local_images", "images"] as const) {
      const values = payload[key];
      if (Array.isArray(values)) {
        for (const value of values) {
          if (typeof value === "string") {
            sources.push({
              mediaType: "image",
              reference: classifyMediaReference(value, "image", "user-message"),
            });
          }
        }
      }
    }
    for (const key of ["local_audio", "audio"] as const) {
      const values = payload[key];
      if (Array.isArray(values)) {
        for (const value of values) {
          if (typeof value === "string") {
            sources.push({
              mediaType: "audio",
              reference: classifyMediaReference(value, "audio", "user-message"),
            });
          }
        }
      }
    }
  }
  if (
    event.type === "response_item" &&
    event.payloadType === "message" &&
    Array.isArray(payload["content"])
  ) {
    for (const item of payload["content"]) {
      const content = objectValue(item);
      if (content?.["type"] === "input_image" && typeof content["image_url"] === "string") {
        sources.push({
          mediaType: "image",
          reference: classifyMediaReference(content["image_url"], "image", "response-input"),
        });
      }
    }
  }
  return sources;
}

function messageCandidate(
  event: CodexEvent,
  role: "user" | "assistant",
  fallbackTimestamp: string,
): MessageCandidate | null {
  const payload = payloadObject(event);
  if (payload === null) {
    return null;
  }
  if (event.type === "event_msg") {
    const expectedType = role === "user" ? "user_message" : "agent_message";
    if (event.payloadType !== expectedType) {
      return null;
    }
    const text = stringValue(payload["message"]);
    return text === null
      ? null
      : {
          id: `message-${event.id}`,
          event,
          phase: role === "assistant" ? stringValue(payload["phase"]) : null,
          source: "event_msg",
          timestamp: eventTimestamp(event, fallbackTimestamp),
          text,
          rawEventId: event.id,
        };
  }
  if (
    event.type !== "response_item" ||
    event.payloadType !== "message" ||
    payload["role"] !== role
  ) {
    return null;
  }
  const text = contentText(payload["content"]);
  return text === ""
    ? null
    : {
        id: `message-${stringValue(payload["id"]) ?? event.id}`,
        event,
        phase: stringValue(payload["phase"]),
        source: "response_item",
        timestamp: eventTimestamp(event, fallbackTimestamp),
        text,
        rawEventId: event.id,
      };
}

function mergedMessageCandidates(
  turn: AssembledTurnEvents,
  role: "user" | "assistant",
  fallbackTimestamp: string,
): MergedMessageCandidate[] {
  const merged: MergedMessageCandidate[] = [];
  for (const { event } of turn.events) {
    const candidate = messageCandidate(event, role, fallbackTimestamp);
    if (candidate === null) {
      continue;
    }
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      previous.source !== candidate.source &&
      previous.text === candidate.text &&
      (previous.phase === candidate.phase || previous.phase === null || candidate.phase === null)
    ) {
      previous.rawEventIds.push(candidate.rawEventId);
      previous.events.push(candidate.event);
      previous.phase ??= candidate.phase;
      continue;
    }
    merged.push({
      ...candidate,
      events: [candidate.event],
      rawEventIds: [candidate.rawEventId],
    });
  }
  return merged;
}

function normalizeMessages(
  turn: AssembledTurnEvents,
  fallbackTimestamp: string,
): {
  userMessage: ConversationMessage | null;
  steeringMessages: ConversationMessage[];
  assistantMessages: ConversationMessage[];
  media: MediaActivity[];
} {
  const media: MediaActivity[] = [];
  const users = mergedMessageCandidates(turn, "user", fallbackTimestamp).map(
    (candidate): ConversationMessage => {
      const attachmentSourcesForMessage = candidate.events.flatMap(attachmentSources);
      const attachmentIds = attachmentSourcesForMessage.map(
        (_, index) => `asset-${candidate.event.id}-${index}`,
      );
      media.push(
        ...attachmentSourcesForMessage.map((source, index): MediaActivity => ({
          id: `media-${candidate.event.id}-${index}`,
          turnId: turn.id,
          createdAt: candidate.event.timestamp,
          rawEventIds: [...candidate.rawEventIds],
          kind: "media",
          assetId: attachmentIds[index]!,
          mediaType: source.mediaType,
          reference: source.reference,
        })),
      );
      return {
        id: candidate.id,
        turnId: turn.id,
        role: "user",
        phase: candidate.phase,
        createdAt: candidate.timestamp,
        sourceMarkdown: candidate.text,
        body: plainDocument(candidate.text),
        attachmentIds,
        rawEventIds: [...candidate.rawEventIds],
      };
    },
  );
  const assistantMessages = mergedMessageCandidates(turn, "assistant", fallbackTimestamp).map(
    (candidate): ConversationMessage => ({
      id: candidate.id,
      turnId: turn.id,
      role: "assistant",
      phase: candidate.phase,
      createdAt: candidate.timestamp,
      sourceMarkdown: candidate.text,
      body: plainDocument(candidate.text),
      attachmentIds: [],
      rawEventIds: [...candidate.rawEventIds],
    }),
  );
  if (assistantMessages.length === 0) {
    const completion = turn.events.find(
      ({ event }) => event.type === "event_msg" && event.payloadType === "task_complete",
    )?.event;
    const payload = completion === undefined ? null : payloadObject(completion);
    const text = stringValue(payload?.["last_agent_message"]);
    if (completion !== undefined && text !== null) {
      assistantMessages.push({
        id: `message-${completion.id}`,
        turnId: turn.id,
        role: "assistant",
        phase: "final",
        createdAt: eventTimestamp(completion, fallbackTimestamp),
        sourceMarkdown: text,
        body: plainDocument(text),
        attachmentIds: [],
        rawEventIds: [completion.id],
      });
    }
  }
  return {
    userMessage: users[0] ?? null,
    steeringMessages: users.slice(1),
    assistantMessages,
    media,
  };
}

function normalizeReasoning(
  events: readonly TurnScopedEvent[],
  turnId: string,
): ReasoningActivity[] {
  const activities: Array<ReasoningActivity & { source: "event_msg" | "response_item" }> = [];
  for (const { event } of events) {
    const payload = payloadObject(event);
    if (payload === null) {
      continue;
    }
    let summaries: string[] = [];
    let encrypted = false;
    if (event.type === "event_msg" && event.payloadType === "agent_reasoning") {
      const summary = stringValue(payload["text"]);
      summaries = summary === null ? [] : [summary];
    } else if (event.type === "response_item" && event.payloadType === "reasoning") {
      const source = Array.isArray(payload["summary"]) ? payload["summary"] : payload["content"];
      summaries = Array.isArray(source)
        ? source.flatMap((item) => {
            const text = stringValue(objectValue(item)?.["text"]);
            return text === null ? [] : [text];
          })
        : [];
      encrypted = stringValue(payload["encrypted_content"]) !== null;
    } else {
      continue;
    }
    if (summaries.length === 0 && encrypted) {
      summaries = [""];
    }
    if (summaries.length === 0) {
      continue;
    }
    summaries.forEach((text, index) => {
      const source = event.type === "event_msg" ? "event_msg" : "response_item";
      const previous = activities.at(-1);
      if (
        index === 0 &&
        previous !== undefined &&
        previous.source !== source &&
        previous.summary === text
      ) {
        previous.rawEventIds.push(event.id);
        previous.encrypted ||= encrypted;
        return;
      }
      activities.push({
        id: `reasoning-${event.id}${summaries.length === 1 ? "" : `-${index}`}`,
        turnId,
        createdAt: event.timestamp,
        rawEventIds: [event.id],
        kind: "reasoning",
        summary: text,
        body: text === "" ? null : plainDocument(text),
        encrypted,
        source,
      });
    });
  }
  return activities.map(({ source: _source, ...activity }) => activity);
}

function normalizeWebSearch(event: CodexEvent, turnId: string): WebSearchActivity | null {
  const payload = payloadObject(event);
  if (payload === null) {
    return null;
  }
  if (event.type === "event_msg" && event.payloadType === "web_search_end") {
    return {
      id: `web-${stringValue(payload["call_id"]) ?? event.id}`,
      turnId,
      createdAt: event.timestamp,
      rawEventIds: [event.id],
      kind: "web_search",
      query: stringValue(payload["query"]) ?? "",
      status: "succeeded",
      resultCount: Array.isArray(payload["results"]) ? payload["results"].length : null,
    };
  }
  if (event.type === "response_item" && event.payloadType === "web_search_call") {
    const action = objectValue(payload["action"]);
    const queries = Array.isArray(action?.["queries"])
      ? action["queries"].filter((value): value is string => typeof value === "string")
      : [];
    return {
      id: `web-${stringValue(payload["id"]) ?? event.id}`,
      turnId,
      createdAt: event.timestamp,
      rawEventIds: [event.id],
      kind: "web_search",
      query: stringValue(action?.["query"]) ?? queries.join(", "),
      status: statusValue(payload["status"]),
      resultCount: null,
    };
  }
  return null;
}

function normalizePatch(event: CodexEvent, turnId: string): PatchActivity | null {
  if (event.type !== "event_msg" || event.payloadType !== "patch_apply_end") {
    return null;
  }
  const payload = payloadObject(event);
  const changes = objectValue(payload?.["changes"]);
  if (payload === null) {
    return null;
  }
  return {
    id: `patch-${stringValue(payload["call_id"]) ?? event.id}`,
    turnId,
    createdAt: event.timestamp,
    rawEventIds: [event.id],
    kind: "patch",
    status: payload["success"] === true ? "succeeded" : statusValue(payload["status"]),
    patch: stringValue(payload["stdout"]) ?? "",
    affectedPaths: changes === null ? [] : Object.keys(changes),
  };
}

function normalizePlan(event: CodexEvent, turnId: string): PlanActivity | null {
  const payload = payloadObject(event);
  if (payload === null || event.type !== "event_msg") {
    return null;
  }
  if (event.payloadType === "item_completed") {
    const item = objectValue(payload["item"]);
    const step = stringValue(item?.["text"]);
    if (item?.["type"] !== "Plan" || step === null) {
      return null;
    }
    return {
      id: `plan-${stringValue(item["id"]) ?? event.id}`,
      turnId,
      createdAt: event.timestamp,
      rawEventIds: [event.id],
      kind: "plan",
      status: "succeeded",
      title: null,
      items: [{ step, status: "completed" }],
    };
  }
  if (event.payloadType === "thread_goal_updated") {
    const goal = objectValue(payload["goal"]);
    const objective = stringValue(goal?.["objective"]);
    if (objective === null) {
      return null;
    }
    return {
      id: `plan-${event.id}`,
      turnId,
      createdAt: event.timestamp,
      rawEventIds: [event.id],
      kind: "plan",
      status: statusValue(goal?.["status"]),
      title: objective,
      items: [{ step: objective, status: planStatus(goal?.["status"]) }],
    };
  }
  return null;
}

function normalizeSubagent(event: CodexEvent, turnId: string): SubagentActivity | null {
  const payload = payloadObject(event);
  if (payload === null) {
    return null;
  }
  if (event.type === "event_msg" && event.payloadType === "sub_agent_activity") {
    return {
      id: `subagent-${stringValue(payload["event_id"]) ?? event.id}`,
      turnId,
      createdAt: event.timestamp,
      rawEventIds: [event.id],
      kind: "subagent",
      status: statusValue(payload["kind"]),
      agentId: stringValue(payload["agent_path"]),
      parentThreadId: null,
      childThreadId: stringValue(payload["agent_thread_id"]),
      description: stringValue(payload["kind"]) ?? "Subagent activity",
    };
  }
  if (event.type === "response_item" && event.payloadType === "agent_message") {
    return {
      id: `subagent-${stringValue(payload["id"]) ?? event.id}`,
      turnId,
      createdAt: event.timestamp,
      rawEventIds: [event.id],
      kind: "subagent",
      status: "succeeded",
      agentId: stringValue(payload["author"]),
      parentThreadId: stringValue(payload["recipient"]),
      childThreadId: null,
      description: contentText(payload["content"]),
    };
  }
  return null;
}

function normalizeCompaction(event: CodexEvent, turnId: string): CompactionActivity | null {
  const isCompaction =
    event.type === "compacted" ||
    (event.type === "event_msg" && event.payloadType === "context_compacted");
  if (!isCompaction) {
    return null;
  }
  const payload = payloadObject(event);
  return {
    id: `compaction-${event.id}`,
    turnId,
    createdAt: event.timestamp,
    rawEventIds: [event.id],
    kind: "compaction",
    summary: stringValue(payload?.["message"]),
  };
}

function normalizeStatus(event: CodexEvent, turnId: string): StatusActivity | null {
  if (event.type !== "event_msg") {
    return null;
  }
  const payload = payloadObject(event);
  if (payload === null) {
    return null;
  }
  if (event.payloadType === "turn_aborted") {
    return {
      id: `status-${event.id}`,
      turnId,
      createdAt: event.timestamp,
      rawEventIds: [event.id],
      kind: "status",
      status: "cancelled",
      message: stringValue(payload["reason"]) ?? "Turn cancelled.",
    };
  }
  if (event.payloadType === "thread_rolled_back") {
    const count = numberValue(payload["num_turns"]) ?? 0;
    return {
      id: `status-${event.id}`,
      turnId,
      createdAt: event.timestamp,
      rawEventIds: [event.id],
      kind: "status",
      status: "succeeded",
      message: `Rolled back ${count} ${count === 1 ? "turn" : "turns"}.`,
    };
  }
  if (event.payloadType === "task_complete") {
    const error = objectValue(payload["error"]);
    const message = stringValue(error?.["message"]);
    return message === null
      ? null
      : {
          id: `status-${event.id}`,
          turnId,
          createdAt: event.timestamp,
          rawEventIds: [event.id],
          kind: "status",
          status: "failed",
          message,
        };
  }
  return null;
}

function normalizeGeneratedMedia(event: CodexEvent, turnId: string): MediaActivity | null {
  const payload = payloadObject(event);
  if (payload === null) {
    return null;
  }
  if (event.type === "event_msg" && event.payloadType === "image_generation_end") {
    return {
      id: `media-${event.id}`,
      turnId,
      createdAt: event.timestamp,
      rawEventIds: [event.id],
      kind: "media",
      assetId: `asset-${stringValue(payload["call_id"]) ?? event.id}`,
      mediaType: "image",
      reference: classifyMediaReference(stringValue(payload["saved_path"]), "image", "generated"),
    };
  }
  if (event.type === "response_item" && event.payloadType === "image_generation_call") {
    return {
      id: `media-${event.id}`,
      turnId,
      createdAt: event.timestamp,
      rawEventIds: [event.id],
      kind: "media",
      assetId: `asset-${stringValue(payload["id"]) ?? event.id}`,
      mediaType: "image",
      reference: invalidMediaReference(null, "missing"),
    };
  }
  return null;
}

function activityOffset(
  activity: ConversationActivity,
  offsets: ReadonlyMap<string, number>,
): number {
  return Math.min(...activity.rawEventIds.map((id) => offsets.get(id) ?? Number.MAX_SAFE_INTEGER));
}

function turnEntryOrder(
  messages: readonly ConversationMessage[],
  activities: readonly ConversationActivity[],
  offsets: ReadonlyMap<string, number>,
): TurnEntryReference[] {
  return [
    ...messages.map((message) => ({
      reference: { kind: "message" as const, id: message.id },
      offset: Math.min(
        ...message.rawEventIds.map((id) => offsets.get(id) ?? Number.MAX_SAFE_INTEGER),
      ),
    })),
    ...activities.map((activity) => ({
      reference: { kind: "activity" as const, id: activity.id },
      offset: activityOffset(activity, offsets),
    })),
  ]
    .toSorted((left, right) => left.offset - right.offset)
    .map(({ reference }) => reference);
}

function normalizeActivities(
  turn: AssembledTurnEvents,
  media: MediaActivity[],
  eventOffsets: ReadonlyMap<string, number>,
  tools: readonly ConversationActivity[],
  consumedToolEventIds: ReadonlySet<string>,
): ConversationActivity[] {
  const activities: ConversationActivity[] = [
    ...normalizeReasoning(turn.events, turn.id),
    ...tools.filter(({ turnId }) => turnId === turn.id),
    ...media,
  ];
  for (const { event } of turn.events) {
    if (consumedToolEventIds.has(event.id)) {
      continue;
    }
    const activity =
      normalizeWebSearch(event, turn.id) ??
      normalizePatch(event, turn.id) ??
      normalizePlan(event, turn.id) ??
      normalizeSubagent(event, turn.id) ??
      normalizeCompaction(event, turn.id) ??
      normalizeStatus(event, turn.id) ??
      normalizeGeneratedMedia(event, turn.id) ??
      (isUnknownCodexEvent(event) ? createUnknownActivity(event, turn.id) : null);
    if (activity !== null) {
      activities.push(activity);
    }
  }
  return activities.toSorted(
    (left, right) =>
      activityOffset(left, eventOffsets) - activityOffset(right, eventOffsets) ||
      left.id.localeCompare(right.id),
  );
}

function mergedActivityStatus(left: ActivityStatus, right: ActivityStatus): ActivityStatus {
  const priority: Record<ActivityStatus, number> = {
    failed: 6,
    cancelled: 5,
    succeeded: 4,
    running: 3,
    pending: 2,
    unknown: 1,
  };
  return priority[right] > priority[left] ? right : left;
}

function reconcileActivity(
  activity: ConversationActivity,
  seen: Map<string, ConversationActivity>,
  eventOffsets: ReadonlyMap<string, number>,
): ConversationActivity | null {
  const existing = seen.get(activity.id);
  if (existing === undefined) {
    seen.set(activity.id, activity);
    return activity;
  }
  if (existing.kind === "web_search" && activity.kind === "web_search") {
    existing.rawEventIds = unique([...existing.rawEventIds, ...activity.rawEventIds]).toSorted(
      (left, right) =>
        (eventOffsets.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (eventOffsets.get(right) ?? Number.MAX_SAFE_INTEGER),
    );
    existing.query ||= activity.query;
    existing.status = mergedActivityStatus(existing.status, activity.status);
    existing.resultCount ??= activity.resultCount;
    return null;
  }

  const occurrence = activity.rawEventIds[0] ?? `turn-${activity.turnId}`;
  const baseId = `${activity.id}:${occurrence}`;
  let id = baseId;
  let suffix = 2;
  while (seen.has(id)) {
    id = `${baseId}:${suffix}`;
    suffix += 1;
  }
  activity.id = id;
  seen.set(id, activity);
  return activity;
}

function tokenSnapshot(turn: AssembledTurnEvents): TokenUsage | null {
  let latest: TokenUsage | null = null;
  for (const { event } of turn.events) {
    if (event.type !== "event_msg" || event.payloadType !== "token_count") {
      continue;
    }
    const payload = payloadObject(event);
    const info = objectValue(payload?.["info"]);
    const usage = objectValue(info?.["total_token_usage"]);
    if (usage === null) {
      continue;
    }
    const inputTokens = numberValue(usage["input_tokens"]);
    const cachedInputTokens = numberValue(usage["cached_input_tokens"]);
    const outputTokens = numberValue(usage["output_tokens"]);
    const reasoningOutputTokens = numberValue(usage["reasoning_output_tokens"]);
    const totalTokens = numberValue(usage["total_tokens"]);
    if (
      inputTokens !== null &&
      cachedInputTokens !== null &&
      outputTokens !== null &&
      reasoningOutputTokens !== null &&
      totalTokens !== null
    ) {
      latest = { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
    }
  }
  return latest;
}

function tokenDelta(current: TokenUsage | null, previous: TokenUsage | null): TokenUsage | null {
  if (current === null) {
    return null;
  }
  if (previous === null || current.totalTokens < previous.totalTokens) {
    return current;
  }
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningOutputTokens: Math.max(
      0,
      current.reasoningOutputTokens - previous.reasoningOutputTokens,
    ),
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
  };
}

interface ThreadSettingsEvidence {
  model: string | null;
  effort: string | null;
}

function settingsEvidenceByTurn(
  events: readonly CodexEvent[],
  turns: readonly AssembledTurnEvents[],
): ReadonlyMap<AssembledTurnEvents, ThreadSettingsEvidence> {
  let model: string | null = null;
  let effort: string | null = null;
  let eventIndex = 0;
  const evidence = new Map<AssembledTurnEvents, ThreadSettingsEvidence>();
  const turnOffsets = turns
    .map((turn, index) => ({ turn, index, offset: turn.events[0]?.event.byteStart ?? 0 }))
    .toSorted((left, right) => left.offset - right.offset || left.index - right.index);
  for (const { turn, offset } of turnOffsets) {
    while (eventIndex < events.length && events[eventIndex]!.byteStart <= offset) {
      const event = events[eventIndex]!;
      eventIndex += 1;
      if (event.type !== "event_msg" || event.payloadType !== "thread_settings_applied") {
        continue;
      }
      const settings = objectValue(payloadObject(event)?.["thread_settings"]);
      model = stringValue(settings?.["model"]) ?? model;
      effort = stringValue(settings?.["reasoning_effort"]) ?? effort;
    }
    evidence.set(turn, { model, effort });
  }
  return evidence;
}

function turnModelEvidence(
  turn: AssembledTurnEvents,
  fallback: ThreadSettingsEvidence,
): { models: string[]; efforts: string[] } {
  const models: string[] = [];
  const efforts: string[] = [];
  for (const { event } of turn.events) {
    if (event.type !== "turn_context") {
      continue;
    }
    const payload = payloadObject(event);
    const model = stringValue(payload?.["model"]);
    const effort = stringValue(payload?.["effort"]);
    if (model !== null) {
      models.push(model);
    }
    if (effort !== null) {
      efforts.push(effort);
    }
  }
  if (models.length === 0 || efforts.length === 0) {
    if (models.length === 0 && fallback.model !== null) {
      models.push(fallback.model);
    }
    if (efforts.length === 0 && fallback.effort !== null) {
      efforts.push(fallback.effort);
    }
  }
  return { models: unique(models), efforts: unique(efforts) };
}

function turnMetrics(turn: AssembledTurnEvents): {
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
} {
  let startedAt: string | null = null;
  let completedAt: string | null = null;
  let durationMs: number | null = null;
  let timeToFirstTokenMs: number | null = null;
  for (const { event } of turn.events) {
    if (event.type !== "event_msg") {
      continue;
    }
    const payload = payloadObject(event);
    if (payload === null) {
      continue;
    }
    if (event.payloadType === "task_started") {
      startedAt = timestampValue(payload["started_at"]) ?? event.timestamp ?? startedAt;
    }
    if (event.payloadType === "task_complete" || event.payloadType === "turn_aborted") {
      startedAt = timestampValue(payload["started_at"]) ?? startedAt;
      completedAt = timestampValue(payload["completed_at"]) ?? event.timestamp ?? completedAt;
      durationMs = numberValue(payload["duration_ms"]) ?? durationMs;
      timeToFirstTokenMs = numberValue(payload["time_to_first_token_ms"]) ?? timeToFirstTokenMs;
    }
  }
  return { startedAt, completedAt, durationMs, timeToFirstTokenMs };
}

function sessionTimestamps(
  events: readonly CodexEvent[],
  metaTimestamp: string | null,
): { createdAt: string; updatedAt: string } {
  let earliest: string | null = null;
  let earliestTime = Number.POSITIVE_INFINITY;
  let latest: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const { timestamp } of events) {
    if (timestamp === null) {
      continue;
    }
    const time = Date.parse(timestamp);
    if (time < earliestTime) {
      earliest = timestamp;
      earliestTime = time;
    }
    if (time >= latestTime) {
      latest = timestamp;
      latestTime = time;
    }
  }
  return {
    createdAt: metaTimestamp ?? earliest ?? epochTimestamp,
    updatedAt: latest ?? metaTimestamp ?? epochTimestamp,
  };
}

export function normalizeSession(input: NormalizeSessionInput): NormalizeSessionResult {
  const diagnostics: ViewerDiagnostic[] = [];
  const events: CodexEvent[] = [];
  for (const record of input.records) {
    const parsed = parseCodexEvent(record);
    if (parsed.success) {
      events.push(parsed.event);
    } else {
      diagnostics.push(invalidEnvelopeDiagnostic(input.sourcePath, parsed.lineNumber));
    }
  }
  const meta = sessionMeta(events);
  const timestamps = sessionTimestamps(events, meta.timestamp);
  const sessionId = meta.id ?? filenameSessionId(input.sourcePath);
  if (sessionId === null) {
    diagnostics.push(missingSessionIdDiagnostic(input.sourcePath));
    return { session: null, diagnostics };
  }

  const assembly = assembleTurnEvents(events, sessionId);
  const unscopedUnknownEvents = assembly.unscopedEvents.filter((event) =>
    isUnknownCodexEvent(event),
  );
  if (unscopedUnknownEvents.length > 0) {
    const target = assembly.turns.at(-1) ?? {
      id: `${sessionId}:turn-0`,
      sourceTurnId: null,
      index: 0,
      events: [],
    };
    if (assembly.turns.length === 0) {
      assembly.turns.push(target);
    }
    target.events.push(...unscopedUnknownEvents.map((event) => ({ event, turnId: target.id })));
  }
  const eventOffsets = new Map(events.map((event) => [event.id, event.byteStart]));
  const pairedTools = pairToolCalls(assembly.turns.flatMap(({ events: turnEvents }) => turnEvents));
  const consumedToolEventIds = new Set(pairedTools.consumedEventIds);
  const seenActivities = new Map<string, ConversationActivity>();
  const settingsByTurn = settingsEvidenceByTurn(events, assembly.turns);
  const fallbackTimestamp = timestamps.createdAt;
  const turns: ConversationTurn[] = [];
  let previousTokens: TokenUsage | null = null;
  for (const assembled of assembly.turns) {
    const messages = normalizeMessages(assembled, fallbackTimestamp);
    const activities = normalizeActivities(
      assembled,
      messages.media,
      eventOffsets,
      pairedTools.activities,
      consumedToolEventIds,
    ).flatMap((activity) => {
      const reconciled = reconcileActivity(activity, seenActivities, eventOffsets);
      return reconciled === null ? [] : [reconciled];
    });
    const evidence = turnModelEvidence(
      assembled,
      settingsByTurn.get(assembled) ?? {
        model: null,
        effort: null,
      },
    );
    const metrics = turnMetrics(assembled);
    const cumulativeTokens = tokenSnapshot(assembled);
    const delta = tokenDelta(cumulativeTokens, previousTokens);
    if (cumulativeTokens !== null) {
      previousTokens = cumulativeTokens;
    }
    const toolCounts: Record<string, number> = {};
    for (const activity of activities) {
      if (activity.kind !== "tool") {
        continue;
      }
      const name =
        activity.namespace === null ? activity.name : `${activity.namespace}.${activity.name}`;
      toolCounts[name] = (toolCounts[name] ?? 0) + 1;
    }
    turns.push({
      id: assembled.id,
      sourceTurnId: assembled.sourceTurnId,
      sessionId,
      index: assembled.index,
      userMessage: messages.userMessage,
      steeringMessages: messages.steeringMessages,
      assistantMessages: messages.assistantMessages,
      activities,
      entryOrder: turnEntryOrder(
        [
          ...(messages.userMessage === null ? [] : [messages.userMessage]),
          ...messages.steeringMessages,
          ...messages.assistantMessages,
        ],
        activities,
        eventOffsets,
      ),
      finalAssistantMessageId: messages.assistantMessages.at(-1)?.id ?? null,
      ...metrics,
      tokenDelta: delta,
      models: evidence.models,
      reasoningEfforts: evidence.efforts,
      toolCounts,
      diagnosticIds: [],
    });
  }
  turns.forEach((turn, index) => {
    turns[index] = conversationTurnSchema.parse(turn);
  });

  const preview =
    turns.find(({ userMessage }) => userMessage !== null)?.userMessage?.sourceMarkdown ?? "";
  const rolloutModels = unique(turns.flatMap(({ models }) => models));
  const rolloutReasoningEfforts = unique(turns.flatMap(({ reasoningEfforts }) => reasoningEfforts));
  const metadata = mergeSessionMetadata({
    sessionId,
    sourcePath: input.sourcePath,
    scope: input.scope,
    firstUserPreview: preview,
    rolloutModels,
    rolloutReasoningEfforts,
    rolloutCwd: meta.cwd,
    rolloutGitBranch: meta.gitBranch,
    rolloutGitSha: meta.gitSha,
    rolloutGitOriginUrl: meta.gitOriginUrl,
    rolloutParentThreadId: meta.parentThreadId,
    sessionIndexEntries: input.sessionIndexEntries,
    stateSnapshot: input.stateSnapshot,
  });
  const toolCounts: Record<string, number> = {};
  for (const turn of turns) {
    for (const [name, count] of Object.entries(turn.toolCounts)) {
      toolCounts[name] = (toolCounts[name] ?? 0) + count;
    }
  }
  const summary = conversationSummarySchema.parse({
    id: sessionId,
    title: metadata.title,
    scope: metadata.scope,
    sourcePath: metadata.sourcePath,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
    cwd: metadata.cwd,
    gitBranch: metadata.gitBranch,
    gitSha: metadata.gitSha,
    gitOriginUrl: metadata.gitOriginUrl,
    models: metadata.models,
    reasoningEfforts: metadata.reasoningEfforts,
    turnCount: turns.length,
    assistantMessageCount: turns.reduce((count, turn) => count + turn.assistantMessages.length, 0),
    toolCallCount: Object.values(toolCounts).reduce((sum, count) => sum + count, 0),
    toolCounts,
    preview: preview.slice(0, 240),
    pinned: metadata.pinned,
    sectionName: metadata.sectionName,
    parentThreadId: metadata.parentThreadId,
    childThreadIds: metadata.childThreadIds,
    hasMedia: turns.some(({ activities }) => activities.some(({ kind }) => kind === "media")),
    diagnosticCount: diagnostics.length,
    revision:
      input.revision ?? `parser-${NORMALIZATION_PARSER_VERSION}:${events.at(-1)?.byteEnd ?? 0}`,
  });
  const turnIds = new Map<string, string>();
  for (const turn of assembly.turns) {
    for (const { event } of turn.events) {
      turnIds.set(event.id, turn.id);
    }
  }
  const rawEvents = events.map((event): NormalizedRawEvent => ({
    id: event.id,
    turnId: turnIds.get(event.id) ?? null,
    type: codexEventType(event),
    timestamp: event.timestamp,
    payload: sanitizeUnknownPayload(event.raw),
  }));

  return { session: { summary, turns, rawEvents }, diagnostics };
}
