import { createHash } from "node:crypto";

import * as z from "zod";

import type {
  GuardianApprovalEvidence,
  JsonValue,
  ToolActivity,
  RolloutRef,
} from "../../shared/types/conversation.ts";
import type { JsonlRecord } from "../ingestion/jsonlStream.ts";
import { qualifyRawRecord, rawRecordIdentity } from "../ingestion/rolloutIdentity.ts";
import { classifyCatalogThread, rawThreadMetadata } from "../metadata/threadClassification.ts";
import type { NormalizedSession } from "./normalizeSession.ts";

const guardianResultSchema = z.strictObject({
  risk_level: z.string().min(1),
  user_authorization: z.string().min(1).optional(),
  outcome: z.enum(["allow", "deny"]),
  rationale: z.string().min(1),
});

export interface GuardianReview extends GuardianApprovalEvidence {
  guardianSessionId: string | null;
  parentThreadId: string | null;
  rawEventIds: string[];
  toolName?: string | null;
  toolNamespace?: string | null;
  requestedAt?: string | null;
}

const nativeApprovalReviewSchema = z.object({
  reviewId: z.string().min(1),
  targetItemId: z.string().min(1).nullable().optional(),
  targetTurnId: z.string().min(1).nullable().optional(),
  parentThreadId: z.string().min(1).nullable().optional(),
  status: z.string().min(1),
  outcome: z.enum(["allow", "deny"]).nullable().optional(),
  reviewedAt: z.iso.datetime().nullable().optional(),
  requestedAt: z.iso.datetime().nullable().optional(),
  riskLevel: z.string().min(1).optional(),
  userAuthorization: z.string().min(1).nullable().optional(),
  rationale: z.string().min(1).optional(),
  rawEventIds: z.array(z.string()).optional(),
});

/** Task 6/9 supply these canonical native identities, no native item discovery occurs here */
export function parseNativeApprovalReview(value: unknown): GuardianReview | null {
  const parsed = nativeApprovalReviewSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const review = parsed.data;
  return {
    ...review,
    reviewedAction: null,
    guardianSessionId: null,
    parentThreadId: review.parentThreadId ?? null,
    reviewedAt: review.reviewedAt ?? null,
    outcome: review.outcome ?? null,
    riskLevel: review.riskLevel ?? "unknown",
    userAuthorization: review.userAuthorization ?? null,
    rationale: review.rationale ?? "Native approval review metadata",
    rawEventIds: review.rawEventIds ?? [],
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return Array.isArray(value)
    ? value
        .flatMap((item) => {
          const text = objectValue(item)?.["text"];
          return typeof text === "string" ? [text] : [];
        })
        .join("\n")
    : "";
}

function jsonObjects(text: string): JsonValue[] {
  const values: JsonValue[] = [];
  let start = -1;
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quote = false;
      }
      continue;
    }
    if (character === '"') {
      quote = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          values.push(JSON.parse(text.slice(start, index + 1)) as JsonValue);
        } catch {
          // A malformed candidate remains available in the raw inspector evidence.
        }
        start = -1;
      }
    }
  }
  return values;
}

function recordPayload(record: JsonlRecord): Record<string, unknown> | null {
  return objectValue(objectValue(record.value)?.["payload"]);
}

function recordType(record: JsonlRecord): string | null {
  const value = objectValue(record.value);
  return typeof value?.["type"] === "string" ? value["type"] : null;
}

function recordTimestamp(record: JsonlRecord): string | null {
  const value = objectValue(record.value);
  return typeof value?.["timestamp"] === "string" ? value["timestamp"] : null;
}

function rawRecordId(record: JsonlRecord): string {
  return rawRecordIdentity(record);
}

function parentFromMeta(payload: Record<string, unknown>): string | null {
  const raw = rawThreadMetadata(payload);
  return raw.status === "valid" ? classifyCatalogThread(raw.metadata!).parentThreadId : null;
}

export function parseGuardianTurn(
  records: readonly JsonlRecord[],
  ref?: RolloutRef,
): GuardianReview | null {
  let guardianSessionId: string | null = null;
  let parentThreadId: string | null = null;
  let plannedAction: JsonValue | null = null;
  let result: z.infer<typeof guardianResultSchema> | null = null;
  let reviewedAt: string | null = null;
  let targetTurnId: string | null = null;
  let targetItemId: string | null = null;
  let reviewId: string | null = null;
  let requestedAt: string | null = null;
  const rawEventIds: string[] = [];
  for (const original of records) {
    const record = ref === undefined ? original : qualifyRawRecord(original, ref);
    const payload = recordPayload(record);
    if (payload === null) {
      continue;
    }
    if (recordType(record) === "session_meta") {
      guardianSessionId =
        typeof payload["id"] === "string"
          ? payload["id"]
          : typeof payload["session_id"] === "string"
            ? payload["session_id"]
            : null;
      parentThreadId = parentFromMeta(payload);
      targetTurnId = nullableString(payload["target_turn_id"] ?? payload["targetTurnId"]);
      targetItemId = nullableString(payload["target_item_id"] ?? payload["targetItemId"]);
      reviewId = nullableString(payload["review_id"] ?? payload["reviewId"]);
      continue;
    }
    const payloadType = typeof payload["type"] === "string" ? payload["type"] : null;
    const isUser =
      (recordType(record) === "event_msg" && payloadType === "user_message") ||
      (recordType(record) === "response_item" &&
        payloadType === "message" &&
        payload["role"] === "user");
    const isAssistant =
      (recordType(record) === "event_msg" && payloadType === "agent_message") ||
      (recordType(record) === "response_item" &&
        payloadType === "message" &&
        payload["role"] === "assistant");
    if (isUser) {
      targetTurnId =
        nullableString(payload["target_turn_id"] ?? payload["targetTurnId"]) ?? targetTurnId;
      targetItemId =
        nullableString(payload["target_item_id"] ?? payload["targetItemId"]) ?? targetItemId;
      reviewId = nullableString(payload["review_id"] ?? payload["reviewId"]) ?? reviewId;
      requestedAt = recordTimestamp(record);
      const text =
        typeof payload["message"] === "string"
          ? payload["message"]
          : contentText(payload["content"]);
      const marker = text.toLowerCase().indexOf("planned action json");
      const candidates = jsonObjects(marker < 0 ? text : text.slice(marker));
      if (candidates[0] !== undefined) {
        plannedAction = candidates[0];
        rawEventIds.push(rawRecordId(record));
      }
    } else if (isAssistant) {
      const text =
        typeof payload["message"] === "string"
          ? payload["message"]
          : contentText(payload["content"]);
      for (const candidate of jsonObjects(text).toReversed()) {
        const parsed = guardianResultSchema.safeParse(candidate);
        if (parsed.success) {
          result = parsed.data;
          reviewedAt = recordTimestamp(record);
          rawEventIds.push(rawRecordId(record));
          break;
        }
      }
    }
  }
  if (plannedAction === null) {
    return null;
  }
  return {
    reviewedAction: plannedAction,
    outcome: result?.outcome ?? null,
    riskLevel: result?.risk_level ?? "unknown",
    userAuthorization: result?.user_authorization ?? null,
    rationale: result?.rationale ?? "Review result not observed",
    reviewedAt,
    guardianSessionId,
    parentThreadId,
    rawEventIds: [...new Set(rawEventIds)],
    targetTurnId,
    targetItemId,
    reviewId,
    requestedAt,
    toolName: nullableString(
      objectValue(plannedAction)?.["name"] ?? objectValue(plannedAction)?.["tool"],
    ),
    toolNamespace: nullableString(objectValue(plannedAction)?.["namespace"]),
    status: result === null ? "pending" : result.outcome === "allow" ? "approved" : "denied",
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function parseGuardianTurns(
  records: readonly JsonlRecord[],
  ref?: RolloutRef,
): GuardianReview[] {
  const reviews: GuardianReview[] = [];
  let metadata: JsonlRecord[] = [];
  let attempt: JsonlRecord[] = [];
  let prompt: string | null = null;
  const userEnvelopes = new Set<string | null>();
  const flush = () => {
    const review = parseGuardianTurn([...metadata, ...attempt], ref);
    if (review !== null) {
      reviews.push(review);
    }
    attempt = [];
    prompt = null;
    userEnvelopes.clear();
  };
  for (const record of records) {
    if (recordType(record) === "session_meta") {
      metadata = [record];
      continue;
    }
    const payload = recordPayload(record);
    const user =
      payload?.["type"] === "user_message" ||
      (payload?.["type"] === "message" && payload["role"] === "user");
    const nextPrompt = user
      ? JSON.stringify([
          payload?.["message"] ?? contentText(payload?.["content"]),
          payload?.["review_id"] ?? payload?.["reviewId"],
          payload?.["target_turn_id"] ?? payload?.["targetTurnId"],
          payload?.["target_item_id"] ?? payload?.["targetItemId"],
        ])
      : null;
    if (
      user &&
      (userEnvelopes.has(recordType(record)) ||
        (prompt !== null && nextPrompt !== prompt) ||
        attempt.some((item) => {
          const previous = recordPayload(item);
          return previous?.["type"] === "agent_message" || previous?.["role"] === "assistant";
        }))
    ) {
      flush();
    }
    if (user) {
      prompt = nextPrompt;
      userEnvelopes.add(recordType(record));
    }
    attempt.push(record);
  }
  flush();
  return reviews;
}

export function parseGuardianConversation(conversation: NormalizedSession): GuardianReview | null {
  return parseGuardianConversations(conversation).at(-1) ?? null;
}
export function parseGuardianConversations(conversation: NormalizedSession): GuardianReview[] {
  return parseGuardianTurns(
    conversation.rawEvents.map((event, index) => ({
      rawEventId: event.id,
      lineNumber: index + 1,
      byteStart: index,
      byteEnd: index + 1,
      raw: JSON.stringify(event.payload),
      value: event.payload,
    })),
  );
}

function normalizedJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(normalizedJson);
  }
  const object = objectValue(value);
  if (object === null) {
    return typeof value === "string" ? value.replaceAll("\r\n", "\n") : value;
  }
  return Object.fromEntries(
    Object.entries(object)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizedJson(child as JsonValue)]),
  );
}

function reviewedInput(value: JsonValue): JsonValue {
  const object = objectValue(value);
  const argumentsValue = object?.["arguments"] ?? object?.["input"];
  return argumentsValue === undefined ? value : (argumentsValue as JsonValue);
}

export function guardianActionHash(value: JsonValue, identity?: string): string {
  return createHash("sha256")
    .update(JSON.stringify([identity ?? null, normalizedJson(reviewedInput(value))]))
    .digest("hex");
}

function approval(review: GuardianReview): GuardianApprovalEvidence {
  return {
    reviewedAction: review.reviewedAction,
    outcome: review.outcome,
    riskLevel: review.riskLevel,
    userAuthorization: review.userAuthorization,
    rationale: review.rationale,
    reviewedAt: review.reviewedAt,
    reviewId: review.reviewId ?? null,
    targetItemId: review.targetItemId ?? null,
    targetTurnId: review.targetTurnId ?? null,
    status: review.status ?? null,
    rawEventIds: review.rawEventIds,
  };
}

export interface ApprovalAssociationContext {
  sessionId: string;
}
export interface ApprovalAssociations {
  matches: Map<string, GuardianReview[]>;
  unattached: {
    review: GuardianReview;
    reason:
      | "missing-scope"
      | "missing-tool-or-turn"
      | "missing-target"
      | "conflicting-targets"
      | "ambiguous-target";
  }[];
}
export interface ApprovalEvidenceResult {
  sessionId: string;
  matched: { activityId: string; attempts: GuardianReview[] }[];
  unattached: ApprovalAssociations["unattached"];
}
export function approvalEvidenceResult(
  sessionId: string,
  associations: ApprovalAssociations,
): ApprovalEvidenceResult {
  return {
    sessionId,
    matched: [...associations.matches].map(([activityId, attempts]) => ({ activityId, attempts })),
    unattached: associations.unattached,
  };
}
function toolIdentity(name: string, namespace: string | null | undefined): string {
  return namespace ? `${namespace}.${name}` : name;
}
function withinTiming(tool: ToolActivity, review: GuardianReview): boolean {
  const start = tool.startedAt ?? tool.createdAt;
  const end = tool.completedAt;
  const reviewed = review.reviewedAt ?? review.requestedAt;
  if (reviewed === null || reviewed === undefined) {
    return true;
  }
  const time = Date.parse(reviewed);
  if (!Number.isFinite(time)) {
    return false;
  }
  return (start === null || time >= Date.parse(start)) && (end === null || time <= Date.parse(end));
}
export function associateApprovalReviews(
  tools: readonly ToolActivity[],
  reviews: readonly GuardianReview[],
  context?: ApprovalAssociationContext,
): ApprovalAssociations {
  const result: ApprovalAssociations = { matches: new Map(), unattached: [] };
  for (const review of reviews) {
    if (
      context === undefined ||
      (review.parentThreadId !== null && review.parentThreadId !== context.sessionId)
    ) {
      result.unattached.push({ review, reason: "missing-scope" });
      continue;
    }
    const exact = review.targetItemId != null || review.reviewId != null;
    if (
      !exact &&
      (review.parentThreadId === null || review.targetTurnId == null || review.toolName == null)
    ) {
      result.unattached.push({ review, reason: "missing-tool-or-turn" });
      continue;
    }
    const candidates = tools.filter((tool) => {
      if (review.targetTurnId != null && tool.turnId !== review.targetTurnId) {
        return false;
      }
      if (review.targetItemId != null) {
        return tool.id === review.targetItemId || tool.nativeItemId === review.targetItemId;
      }
      if (review.reviewId != null) {
        return tool.approvalReviewId === review.reviewId;
      }
      const identity = toolIdentity(tool.name, tool.namespace);
      return (
        identity === toolIdentity(review.toolName!, review.toolNamespace) &&
        guardianActionHash(tool.input, identity) ===
          guardianActionHash(review.reviewedAction, identity) &&
        withinTiming(tool, review)
      );
    });
    if (candidates.length !== 1) {
      result.unattached.push({
        review,
        reason: candidates.length === 0 ? "missing-target" : "ambiguous-target",
      });
      continue;
    }
    if (
      review.targetItemId != null &&
      review.reviewId != null &&
      tools.some(
        (tool) => tool.approvalReviewId === review.reviewId && tool.id !== candidates[0]!.id,
      )
    ) {
      result.unattached.push({ review, reason: "conflicting-targets" });
      continue;
    }
    const id = candidates[0]!.id;
    result.matches.set(id, [...(result.matches.get(id) ?? []), review]);
  }
  return result;
}

export function matchGuardianEvidence(
  tools: readonly ToolActivity[],
  reviews: readonly GuardianReview[],
  context?: ApprovalAssociationContext,
): Map<string, GuardianApprovalEvidence> {
  return new Map(
    [...associateApprovalReviews(tools, reviews, context).matches].map(([id, attempts]) => [
      id,
      approval(attempts.at(-1)!),
    ]),
  );
}

export function attachGuardianEvidence(
  tools: readonly ToolActivity[],
  reviews: readonly GuardianReview[],
  context?: ApprovalAssociationContext,
): number {
  const { matches } = associateApprovalReviews(tools, reviews, context);
  for (const tool of tools) {
    tool.approvalAttempts = (matches.get(tool.id) ?? []).map(approval);
    tool.approval = tool.approvalAttempts.findLast((attempt) => attempt.outcome !== null) ?? null;
  }
  return matches.size;
}
