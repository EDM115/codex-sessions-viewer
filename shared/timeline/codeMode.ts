import type {
  CodeModeEvidence,
  ConversationActivity,
  JsonObject,
  JsonValue,
  ToolActivity,
  FileChangeActivity,
  SubagentActivity,
} from "../types/conversation.ts";
import { presentTool } from "./toolSemantics.ts";
function activityObject(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** Pinned Responses metadata path, never search user text, scripts or printed results for metadata */
export function recordedToolInventory(
  payload: JsonObject,
  sourceEventId: string,
  scopeId: string | null = null,
): CodeModeEvidence | undefined {
  if (
    !["function_call_output", "custom_tool_call_output"].includes(
      typeof payload["type"] === "string" ? payload["type"] : "",
    )
  ) {
    return undefined;
  }
  const metadata = activityObject(payload["internal_chat_message_metadata_passthrough"]);
  if (!metadata) {
    return undefined;
  }
  const cellId =
    typeof metadata["cell_id"] === "string" && metadata["cell_id"] !== ""
      ? metadata["cell_id"]
      : null;
  const rawCalls = metadata["executed_tool_calls"];
  const calls =
    Array.isArray(rawCalls) &&
    rawCalls.every((call): call is JsonObject => {
      const record = activityObject(call);
      return (
        record !== null &&
        typeof record["name"] === "string" &&
        record["name"] !== "" &&
        Object.hasOwn(record, "arguments")
      );
    })
      ? rawCalls
      : null;
  const complete =
    typeof metadata["tool_calls_complete"] === "boolean" ? metadata["tool_calls_complete"] : null;
  if (cellId === null && rawCalls === undefined && complete === null) {
    return undefined;
  }
  return {
    cellId,
    scopeId,
    completeness: calls === null ? "absent" : complete === true ? "complete" : "partial",
    loadedCoverage: "unknown",
    deltas: [{ sourceEventId, calls, complete }],
    outerActivityIds: [],
  };
}

/** Each metadata output contains a delta, equal arguments are distinct attempted invocations */
export function expandRecordedCells(
  activities: readonly (ToolActivity | FileChangeActivity | SubagentActivity)[],
): Array<ToolActivity | FileChangeActivity | SubagentActivity>;
export function expandRecordedCells(
  activities: readonly ConversationActivity[],
): ConversationActivity[];
export function expandRecordedCells(
  activities: readonly ConversationActivity[],
): ConversationActivity[] {
  const cells = new Map<string, { owner: ToolActivity; evidence: CodeModeEvidence }>();
  const result = activities.map((activity) => {
    if (activity.kind !== "tool" || !activity.codeMode) {
      return activity;
    }
    const copy = {
      ...activity,
      codeMode: {
        ...activity.codeMode,
        deltas: [
          ...new Map(
            activity.codeMode.deltas.map((delta) => [delta.sourceEventId, delta]),
          ).values(),
        ],
        outerActivityIds: [activity.id],
      },
    };
    copy.codeMode.completeness = copy.codeMode.deltas.some(
      (delta) => delta.calls !== null && delta.complete === true,
    )
      ? "complete"
      : copy.codeMode.deltas.some((delta) => delta.calls !== null)
        ? "partial"
        : "absent";
    const key = JSON.stringify([
      activity.codeMode.scopeId,
      activity.turnId,
      activity.codeMode.cellId ?? activity.id,
    ]);
    const previous = cells.get(key);
    if (!previous) {
      cells.set(key, { owner: copy, evidence: copy.codeMode });
    } else {
      const ids = new Set(previous.evidence.deltas.map((delta) => delta.sourceEventId));
      for (const delta of copy.codeMode.deltas) {
        if (!ids.has(delta.sourceEventId)) {
          previous.evidence.deltas.push(delta);
          ids.add(delta.sourceEventId);
        }
      }
      previous.evidence.outerActivityIds.push(activity.id);
      previous.evidence.completeness = previous.evidence.deltas.some(
        (delta) => delta.calls !== null && delta.complete === true,
      )
        ? "complete"
        : previous.evidence.deltas.some((delta) => delta.calls !== null)
          ? "partial"
          : "absent";
    }
    return copy;
  });
  for (const { owner, evidence } of cells.values()) {
    // Direct output inventories describe the already displayed direct call
    if (evidence.cellId === null) {
      continue;
    }
    for (const delta of evidence.deltas) {
      for (const [index, call] of (delta.calls ?? []).entries()) {
        const name = typeof call["name"] === "string" ? call["name"] : "unknown_tool";
        const input: JsonValue = call["arguments"] ?? null;
        result.push({
          id: `code-mode:${delta.sourceEventId}:attempt:${index}`,
          turnId: owner.turnId,
          createdAt: null,
          rawEventIds: [delta.sourceEventId],
          kind: "tool",
          namespace: null,
          name,
          callId: null,
          status: "unknown",
          startedAt: null,
          completedAt: null,
          durationMs: null,
          input,
          output: null,
          error: null,
          presentation: {
            category: "other",
            label: name.replaceAll("_", " "),
            subject: "Host-recorded attempted invocation",
            status: "unknown",
            evidenceKind: "host-attempt",
            itemId: null,
            callId: null,
            cellId: evidence.cellId,
            childIds: [],
            details: {
              parentActivityId: owner.id,
              sourceEventId: delta.sourceEventId,
              inventoryIndex: index,
              recorded: call,
            },
          },
        });
      }
    }
  }
  return result.map((activity) => (activity.kind === "tool" ? presentTool(activity) : activity));
}
