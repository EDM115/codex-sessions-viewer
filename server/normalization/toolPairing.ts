import {
  jsonValueSchema,
  type ActivityStatus,
  type FileChangeActivity,
  type JsonObject,
  type JsonValue,
  type ToolActivity,
} from "../../shared/types/conversation.ts";
import { payloadObject, type CodexEvent, type TurnScopedEvent } from "./eventSchema.ts";
import { deriveNestedExecActivities } from "./nestedExec.ts";

interface ToolPairingResult {
  activities: Array<ToolActivity | FileChangeActivity>;
  consumedEventIds: string[];
}

interface MutableToolPair {
  key: string;
  callId: string | null;
  turnId: string;
  namespace: string | null;
  name: string;
  input: JsonValue;
  output: JsonValue;
  status: ActivityStatus;
  error: string | null;
  callEvent: CodexEvent | null;
  outputEvent: CodexEvent | null;
  explicitDurationMs: number | null;
  rawEventIds: string[];
  sortOffset: number;
}

function objectValue(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function decodedValue(value: JsonValue | undefined): JsonValue {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return value;
  }
  try {
    const decoded: unknown = JSON.parse(value);
    const parsed = jsonValueSchema.safeParse(decoded);
    return parsed.success ? parsed.data : value;
  } catch {
    return value;
  }
}

function mappedStatus(value: JsonValue | undefined): ActivityStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  switch (value.toLowerCase()) {
    case "completed":
    case "complete":
    case "ok":
    case "success":
    case "succeeded":
      return "succeeded";
    case "cancelled":
    case "canceled":
    case "aborted":
      return "cancelled";
    case "failed":
    case "error":
      return "failed";
    case "in_progress":
    case "running":
      return "running";
    case "pending":
      return "pending";
    default:
      return null;
  }
}

function durationMilliseconds(value: JsonValue | undefined): number | null {
  const duration = objectValue(value);
  if (duration === null) {
    return null;
  }
  const seconds = typeof duration["secs"] === "number" ? duration["secs"] : 0;
  const nanoseconds = typeof duration["nanos"] === "number" ? duration["nanos"] : 0;
  const milliseconds = seconds * 1000 + nanoseconds / 1_000_000;
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

function resultDetails(result: JsonValue | undefined): {
  output: JsonValue;
  status: ActivityStatus;
  error: string | null;
} {
  const resultObject = objectValue(result);
  if (resultObject === null) {
    return { output: result ?? null, status: "unknown", error: null };
  }
  if (Object.hasOwn(resultObject, "Err")) {
    const output = resultObject["Err"] ?? null;
    const errorObject = objectValue(output);
    const error =
      stringValue(errorObject?.["message"]) ?? (typeof output === "string" ? output : null);
    return { output, status: "failed", error };
  }
  if (Object.hasOwn(resultObject, "Ok")) {
    const output = resultObject["Ok"] ?? null;
    const outputObject = objectValue(output);
    const isError = outputObject?.["isError"] === true;
    const error = isError
      ? (stringValue(outputObject?.["error"]) ?? "Tool returned an error")
      : null;
    return { output, status: isError ? "failed" : "succeeded", error };
  }
  const isError = resultObject["isError"] === true;
  const error = isError
    ? (stringValue(resultObject["error"]) ??
      stringValue(resultObject["message"]) ??
      "Tool returned an error")
    : null;
  return { output: resultObject, status: isError ? "failed" : "succeeded", error };
}

function createPair(key: string, scoped: TurnScopedEvent, callId: string | null): MutableToolPair {
  return {
    key,
    callId,
    turnId: scoped.turnId,
    namespace: null,
    name: "unknown_tool",
    input: null,
    output: null,
    status: "unknown",
    error: null,
    callEvent: null,
    outputEvent: null,
    explicitDurationMs: null,
    rawEventIds: [],
    sortOffset: scoped.event.byteStart,
  };
}

function elapsedMilliseconds(start: string | null, end: string | null): number | null {
  if (start === null || end === null) {
    return null;
  }
  const elapsed = Date.parse(end) - Date.parse(start);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

export function pairToolCalls(events: readonly TurnScopedEvent[]): ToolPairingResult {
  const pairs = new Map<string, MutableToolPair>();
  const consumedEventIds: string[] = [];

  for (const scoped of events) {
    const { event } = scoped;
    const payload = payloadObject(event);
    if (payload === null) {
      continue;
    }
    const type = event.payloadType;
    const isCall =
      event.type === "response_item" &&
      (type === "function_call" || type === "custom_tool_call" || type === "tool_search_call");
    const isOutput =
      event.type === "response_item" &&
      (type === "function_call_output" ||
        type === "custom_tool_call_output" ||
        type === "tool_search_output");
    const isMcpCompletion = event.type === "event_msg" && type === "mcp_tool_call_end";
    if (!isCall && !isOutput && !isMcpCompletion) {
      continue;
    }

    const callId = stringValue(payload["call_id"]);
    const key = callId ?? event.id;
    const pair = pairs.get(key) ?? createPair(key, scoped, callId);
    pairs.set(key, pair);
    pair.rawEventIds.push(event.id);
    pair.sortOffset = Math.min(pair.sortOffset, event.byteStart);
    consumedEventIds.push(event.id);

    if (isCall) {
      pair.callEvent = event;
      pair.turnId = scoped.turnId;
      pair.namespace =
        stringValue(payload["namespace"]) ??
        (type === "tool_search_call" ? "codex" : pair.namespace);
      pair.name =
        type === "tool_search_call" ? "tool_search" : (stringValue(payload["name"]) ?? pair.name);
      pair.input = decodedValue(
        type === "function_call"
          ? payload["arguments"]
          : type === "custom_tool_call"
            ? payload["input"]
            : payload["arguments"],
      );
      pair.status = mappedStatus(payload["status"]) ?? pair.status;
      continue;
    }

    if (isOutput) {
      pair.outputEvent = event;
      if (type === "tool_search_output") {
        pair.namespace = pair.namespace ?? "codex";
        pair.name = pair.name === "unknown_tool" ? "tool_search" : pair.name;
        pair.output = payload["tools"] ?? null;
      } else {
        pair.output = decodedValue(payload["output"]);
      }
      const details = resultDetails(pair.output);
      pair.status =
        mappedStatus(payload["status"]) ??
        (details.status === "unknown" ? "succeeded" : details.status);
      pair.error = details.error;
      continue;
    }

    const invocation = objectValue(payload["invocation"]);
    pair.outputEvent = event;
    pair.namespace = stringValue(invocation?.["server"]) ?? pair.namespace;
    pair.name = stringValue(invocation?.["tool"]) ?? pair.name;
    pair.input = invocation?.["arguments"] ?? pair.input;
    pair.explicitDurationMs = durationMilliseconds(payload["duration"]);
    const details = resultDetails(payload["result"]);
    pair.output = details.output;
    pair.status = details.status;
    pair.error = details.error;
  }

  const activities = [...pairs.values()]
    .toSorted((left, right) => left.sortOffset - right.sortOffset)
    .map((pair): ToolActivity => {
      const startedAt = pair.callEvent?.timestamp ?? null;
      const completedAt = pair.outputEvent?.timestamp ?? null;
      return {
        id: `tool-${pair.callId ?? pair.key}`,
        turnId: pair.turnId,
        createdAt: startedAt ?? completedAt,
        rawEventIds: pair.rawEventIds,
        kind: "tool",
        namespace: pair.namespace,
        name: pair.name,
        callId: pair.callId,
        status: pair.status,
        startedAt,
        completedAt,
        durationMs: pair.explicitDurationMs ?? elapsedMilliseconds(startedAt, completedAt),
        input: pair.input,
        output: pair.output,
        error: pair.error,
      };
    })
    .flatMap(deriveNestedExecActivities);

  return { activities, consumedEventIds };
}
