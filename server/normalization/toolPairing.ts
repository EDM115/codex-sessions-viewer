import { adaptCoreTurnItem, adaptCommandEvent } from "#server/history/nativeItemAdapter.ts";
import {
  payloadObject,
  eventOrder,
  type CodexEvent,
  type TurnScopedEvent,
} from "#server/normalization/eventSchema.ts";
import { deriveNestedExecActivities } from "#server/normalization/nestedExec.ts";
import { nativeActivity } from "#shared/timeline/activityPresentation.ts";
import { recordedToolInventory, expandRecordedCells } from "#shared/timeline/codeMode.ts";
import { decodeToolOutcome, recordedActivityStatus } from "#shared/timeline/toolOutcome.ts";
import {
  jsonValueSchema,
  type ActivityStatus,
  type CodeModeEvidence,
  type FileChangeActivity,
  type SubagentActivity,
  type JsonObject,
  type JsonValue,
  type ToolActivity,
} from "#shared/types/conversation.ts";

interface ToolPairingResult {
  activities: Array<ToolActivity | FileChangeActivity | SubagentActivity>;
  consumedEventIds: string[];
}

export interface ToolPairingMemo {
  decoded: WeakMap<CodexEvent, JsonValue>;
  pairs: Map<
    string,
    {
      call: CodexEvent | null;
      output: CodexEvent | null;
      turnId: string;
      eventCount: number;
      activities: ToolPairingResult["activities"];
    }
  >;
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
  inventory?: CodeModeEvidence;
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
    sortOffset: eventOrder(scoped.event),
  };
}

function elapsedMilliseconds(start: string | null, end: string | null): number | null {
  if (start === null || end === null) {
    return null;
  }
  const elapsed = Date.parse(end) - Date.parse(start);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

export function pairToolCalls(
  events: readonly TurnScopedEvent[],
  memo?: ToolPairingMemo,
  sessionId = "",
): ToolPairingResult {
  const pairs = new Map<string, MutableToolPair>();
  const sourceCalls = new Map<string, TurnScopedEvent[]>();
  for (const scoped of events) {
    const payload = payloadObject(scoped.event);
    const callId = stringValue(payload?.["call_id"]);
    if (
      !callId ||
      scoped.event.type !== "response_item" ||
      !["function_call", "custom_tool_call", "tool_search_call"].includes(
        scoped.event.payloadType ?? "",
      )
    ) {
      continue;
    }
    const key = JSON.stringify([scoped.event.identity?.physicalRolloutId ?? null, callId]);
    const calls = sourceCalls.get(key) ?? [];
    if (!calls.some(({ event }) => event.id === scoped.event.id)) {
      calls.push(scoped);
    }
    sourceCalls.set(key, calls);
  }
  const consumedEventIds: string[] = [];
  const native = new Map<
    string,
    { activity: ToolActivity | FileChangeActivity | SubagentActivity; canonical: boolean }
  >();
  for (const { event, turnId } of events) {
    if (event.type !== "event_msg") {
      continue;
    }
    const payload = payloadObject(event);
    if (!payload) {
      continue;
    }
    const canonical = event.payloadType === "item_completed";
    const item = canonical
      ? adaptCoreTurnItem(payload["item"], payload)
      : adaptCommandEvent(payload);
    if (!item) {
      continue;
    }
    const activity = nativeActivity(item, { turnId, sessionId, rawEventIds: [event.id] });
    if (
      !activity ||
      (activity.kind !== "tool" && activity.kind !== "file_change" && activity.kind !== "subagent")
    ) {
      continue;
    }
    const key = JSON.stringify([
      event.identity?.physicalRolloutId ?? null,
      turnId,
      item.type,
      item.id,
    ]);
    const previous = native.get(key);
    consumedEventIds.push(event.id);
    if (previous?.canonical && !canonical) {
      previous.activity.rawEventIds.push(event.id);
      continue;
    }
    if (previous) {
      activity.rawEventIds = [...new Set([...previous.activity.rawEventIds, event.id])];
    }
    native.set(key, { activity, canonical });
  }
  const decode = (event: CodexEvent, value: JsonValue | undefined): JsonValue => {
    if (memo?.decoded.has(event)) {
      return memo.decoded.get(event)!;
    }
    const decoded = decodedValue(value);
    memo?.decoded.set(event, decoded);
    return decoded;
  };

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
    const candidates =
      sourceCalls.get(JSON.stringify([event.identity?.physicalRolloutId ?? null, callId])) ?? [];
    const sameTurn = candidates.filter((candidate) => candidate.turnId === scoped.turnId);
    const origin = isCall
      ? scoped
      : candidates.length === 1
        ? candidates[0]
        : sameTurn.length === 1
          ? sameTurn[0]
          : undefined;
    const key = JSON.stringify([
      event.identity?.physicalRolloutId ?? null,
      origin?.turnId ?? scoped.turnId,
      callId ?? event.id,
      candidates.length > 1 ? (origin?.event.id ?? event.id) : null,
    ]);
    const pair = pairs.get(key) ?? createPair(key, scoped, callId);
    pairs.set(key, pair);
    if (!pair.rawEventIds.includes(event.id)) {
      pair.rawEventIds.push(event.id);
    }
    pair.sortOffset = Math.min(pair.sortOffset, eventOrder(event));
    consumedEventIds.push(event.id);

    if (isCall) {
      pair.callEvent = event;
      pair.turnId = scoped.turnId;
      pair.namespace =
        stringValue(payload["namespace"]) ??
        (type === "tool_search_call" ? "codex" : pair.namespace);
      pair.name =
        type === "tool_search_call" ? "tool_search" : (stringValue(payload["name"]) ?? pair.name);
      pair.input = decode(
        event,
        type === "function_call"
          ? payload["arguments"]
          : type === "custom_tool_call"
            ? payload["input"]
            : payload["arguments"],
      );
      pair.status = recordedActivityStatus(payload["status"]) ?? pair.status;
      continue;
    }

    if (isOutput) {
      const inventory = recordedToolInventory(
        payload,
        event.id,
        event.identity
          ? JSON.stringify([event.identity.codexHomeId, event.identity.physicalRolloutId])
          : null,
      );
      if (inventory) {
        if (pair.inventory && pair.inventory.cellId === inventory.cellId) {
          pair.inventory.deltas.push(...inventory.deltas);
          pair.inventory.completeness = inventory.completeness;
        } else {
          pair.inventory = inventory;
        }
      }
      pair.outputEvent = event;
      if (type === "tool_search_output") {
        pair.namespace = pair.namespace ?? "codex";
        pair.name = pair.name === "unknown_tool" ? "tool_search" : pair.name;
        pair.output = payload["tools"] ?? null;
      } else {
        pair.output = decode(event, payload["output"]);
      }
      const originPayload = origin ? payloadObject(origin.event) : null;
      const details = decodeToolOutcome(
        type === "tool_search_output" ? null : (payload["output"] ?? null),
        {
          name: stringValue(originPayload?.["name"]) ?? pair.name,
          namespace: stringValue(originPayload?.["namespace"]) ?? pair.namespace,
          explicitStatus: payload["status"],
        },
      );
      pair.status = details.status;
      pair.error = details.error;
      continue;
    }

    const invocation = objectValue(payload["invocation"]);
    pair.outputEvent = event;
    pair.namespace = stringValue(invocation?.["server"]) ?? pair.namespace;
    pair.name = stringValue(invocation?.["tool"]) ?? pair.name;
    pair.input = invocation?.["arguments"] ?? pair.input;
    pair.explicitDurationMs = durationMilliseconds(payload["duration"]);
    const rawResult = payload["result"] ?? null;
    const details = decodeToolOutcome(rawResult, { name: pair.name, namespace: pair.namespace });
    const envelope = objectValue(rawResult);
    pair.output =
      envelope && Object.keys(envelope).length === 1
        ? Object.hasOwn(envelope, "Ok")
          ? (envelope["Ok"] ?? null)
          : Object.hasOwn(envelope, "Err")
            ? (envelope["Err"] ?? null)
            : rawResult
        : rawResult;
    pair.status = details.status;
    pair.error = details.error;
  }

  const nextPairs: ToolPairingMemo["pairs"] = new Map();
  const activities = [...pairs.values()]
    .toSorted((left, right) => left.sortOffset - right.sortOffset)
    .flatMap((pair): ToolPairingResult["activities"] => {
      const cached = memo?.pairs.get(pair.key);
      if (
        cached !== undefined &&
        cached.call === pair.callEvent &&
        cached.output === pair.outputEvent &&
        cached.turnId === pair.turnId &&
        cached.eventCount === pair.rawEventIds.length
      ) {
        nextPairs.set(pair.key, cached);
        return cached.activities;
      }
      const startedAt = pair.callEvent?.timestamp ?? null;
      const completedAt = pair.status === "running" ? null : (pair.outputEvent?.timestamp ?? null);
      const activity: ToolActivity = {
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
        ...(pair.inventory ? { codeMode: pair.inventory } : {}),
      };
      const derived = deriveNestedExecActivities(activity);
      nextPairs.set(pair.key, {
        call: pair.callEvent,
        output: pair.outputEvent,
        turnId: pair.turnId,
        eventCount: pair.rawEventIds.length,
        activities: derived,
      });
      return derived;
    });
  if (memo !== undefined) {
    memo.pairs = nextPairs;
  }

  return {
    activities: expandRecordedCells([
      ...activities,
      ...[...native.values()].map(({ activity }) => activity),
    ]),
    consumedEventIds,
  };
}
