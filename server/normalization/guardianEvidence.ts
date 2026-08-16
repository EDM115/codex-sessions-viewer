import { createHash } from "node:crypto";

import * as z from "zod";

import type {
  GuardianApprovalEvidence,
  JsonValue,
  ToolActivity,
} from "../../shared/types/conversation.ts";
import type { JsonlRecord } from "../ingestion/jsonlStream.ts";
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
  return `raw-${record.byteStart}`;
}

function parentFromMeta(payload: Record<string, unknown>): string | null {
  if (typeof payload["parent_thread_id"] === "string") {
    return payload["parent_thread_id"];
  }
  const source = objectValue(payload["source"]);
  const subagent = objectValue(source?.["subagent"]);
  return typeof subagent?.["parent_thread_id"] === "string" ? subagent["parent_thread_id"] : null;
}

export function parseGuardianTurn(records: readonly JsonlRecord[]): GuardianReview | null {
  let guardianSessionId: string | null = null;
  let parentThreadId: string | null = null;
  let plannedAction: JsonValue | null = null;
  let result: z.infer<typeof guardianResultSchema> | null = null;
  let reviewedAt: string | null = null;
  const rawEventIds: string[] = [];
  for (const record of records) {
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
  if (plannedAction === null || result === null) {
    return null;
  }
  return {
    reviewedAction: plannedAction,
    outcome: result.outcome,
    riskLevel: result.risk_level,
    userAuthorization: result.user_authorization ?? null,
    rationale: result.rationale,
    reviewedAt,
    guardianSessionId,
    parentThreadId,
    rawEventIds: [...new Set(rawEventIds)],
  };
}

export function parseGuardianConversation(conversation: NormalizedSession): GuardianReview | null {
  return parseGuardianTurn(
    conversation.rawEvents.map((event, index) => ({
      lineNumber: index + 1,
      byteStart: Number(/^raw-(\d+)$/u.exec(event.id)?.[1] ?? index),
      byteEnd: Number(/^raw-(\d+)$/u.exec(event.id)?.[1] ?? index) + 1,
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

function actionHash(value: JsonValue): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizedJson(reviewedInput(value))))
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
  };
}

export function matchGuardianEvidence(
  tools: readonly ToolActivity[],
  reviews: readonly GuardianReview[],
): Map<string, GuardianApprovalEvidence> {
  const toolsByHash = new Map<string, ToolActivity[]>();
  for (const tool of tools) {
    const hash = actionHash(tool.input);
    toolsByHash.set(hash, [...(toolsByHash.get(hash) ?? []), tool]);
  }
  const matches = new Map<string, GuardianApprovalEvidence>();
  for (const review of reviews) {
    const candidates = toolsByHash.get(actionHash(review.reviewedAction)) ?? [];
    if (candidates.length === 1 && !matches.has(candidates[0]!.id)) {
      matches.set(candidates[0]!.id, approval(review));
    }
  }
  return matches;
}

export function attachGuardianEvidence(
  tools: readonly ToolActivity[],
  reviews: readonly GuardianReview[],
): number {
  const matches = matchGuardianEvidence(tools, reviews);
  for (const tool of tools) {
    tool.approval = matches.get(tool.id) ?? null;
  }
  return matches.size;
}
