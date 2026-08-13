import * as z from "zod";

import {
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "../../shared/types/conversation.ts";
import type { JsonlRecord } from "../ingestion/jsonlStream.ts";

const knownTopLevelTypes = new Set([
  "compacted",
  "event_msg",
  "inter_agent_communication_metadata",
  "response_item",
  "session_meta",
  "turn_context",
  "world_state",
]);

const knownEventMessageTypes = new Set([
  "agent_message",
  "agent_reasoning",
  "context_compacted",
  "image_generation_end",
  "item_completed",
  "mcp_tool_call_end",
  "patch_apply_end",
  "sub_agent_activity",
  "task_complete",
  "task_started",
  "thread_goal_updated",
  "thread_rolled_back",
  "thread_settings_applied",
  "token_count",
  "turn_aborted",
  "user_message",
  "web_search_end",
]);

const knownResponseItemTypes = new Set([
  "agent_message",
  "custom_tool_call",
  "custom_tool_call_output",
  "function_call",
  "function_call_output",
  "image_generation_call",
  "message",
  "reasoning",
  "tool_search_call",
  "tool_search_output",
  "web_search_call",
]);

const eventEnvelopeSchema = z.object({
  timestamp: z.string().optional(),
  type: z.string().trim().min(1),
  payload: jsonValueSchema,
});

export const sessionMetaPayloadSchema = z
  .object({
    id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    parent_thread_id: z.string().min(1).optional(),
    forked_from_id: z.string().min(1).optional(),
    timestamp: z.string().optional(),
    cwd: z.string().optional(),
    model_provider: z.string().optional(),
    git: z
      .object({
        branch: z.string().optional(),
        commit_hash: z.string().optional(),
        repository_url: z.string().optional(),
      })
      .optional(),
  })
  .refine((payload) => payload.id !== undefined || payload.session_id !== undefined, {
    message: "Session metadata requires id or session_id.",
  });

export interface CodexEvent {
  id: string;
  lineNumber: number;
  byteStart: number;
  byteEnd: number;
  timestamp: string | null;
  type: string;
  payloadType: string | null;
  payload: JsonValue;
  raw: JsonObject;
}

export interface TurnScopedEvent {
  event: CodexEvent;
  turnId: string;
}

export type CodexEventParseResult =
  | { success: true; event: CodexEvent }
  | { success: false; reason: "invalid-event-envelope"; lineNumber: number };

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function payloadObject(event: CodexEvent): JsonObject | null {
  return isJsonObject(event.payload) ? event.payload : null;
}

export function parseCodexEvent(record: JsonlRecord): CodexEventParseResult {
  const parsed = eventEnvelopeSchema.safeParse(record.value);
  if (!parsed.success || !isJsonObject(record.value)) {
    return {
      success: false,
      reason: "invalid-event-envelope",
      lineNumber: record.lineNumber,
    };
  }

  const payload = parsed.data.payload;
  const payloadType =
    isJsonObject(payload) && typeof payload["type"] === "string" && payload["type"] !== ""
      ? payload["type"]
      : null;
  const timestamp =
    parsed.data.timestamp !== undefined && !Number.isNaN(Date.parse(parsed.data.timestamp))
      ? parsed.data.timestamp
      : null;

  return {
    success: true,
    event: {
      id: `raw-${record.byteStart}`,
      lineNumber: record.lineNumber,
      byteStart: record.byteStart,
      byteEnd: record.byteEnd,
      timestamp,
      type: parsed.data.type,
      payloadType,
      payload,
      raw: record.value,
    },
  };
}

export function isUnknownCodexEvent(event: CodexEvent): boolean {
  if (!knownTopLevelTypes.has(event.type)) {
    return true;
  }
  if (event.type === "event_msg") {
    return event.payloadType === null || !knownEventMessageTypes.has(event.payloadType);
  }
  if (event.type === "response_item") {
    return event.payloadType === null || !knownResponseItemTypes.has(event.payloadType);
  }
  return false;
}

export function codexEventType(event: CodexEvent): string {
  return event.payloadType === null ? event.type : `${event.type}:${event.payloadType}`;
}
