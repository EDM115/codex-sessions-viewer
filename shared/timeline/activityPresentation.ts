import { jsonValueSchema } from "../types/conversation.ts";
import type {
  ActivityPresentation,
  ActivityStatus,
  ConversationActivity,
  JsonObject,
  JsonValue,
  ToolActivity,
} from "../types/conversation.ts";
import type { HistoryItem } from "../types/history.ts";
import { recordedToolInventory } from "./codeMode.ts";
import { fileChangeLineCounts } from "./fileChanges.ts";
import { decodeToolOutcome } from "./toolOutcome.ts";
import { presentTool } from "./toolSemantics.ts";

export function activityObject(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
const text = (value: JsonValue | undefined) => (typeof value === "string" ? value : null);
const timestamp = (value: number | null) => (value === null ? null : new Date(value).toISOString());

function decoded(value: JsonValue): JsonValue {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return jsonValueSchema.parse(JSON.parse(value));
  } catch {
    return value;
  }
}

/** Legacy source evidence is only read from the adapter's explicit original source envelope */
export function historyActivity(
  item: HistoryItem,
  context: { turnId: string; sessionId: string; rawEventIds: string[] },
): ConversationActivity | null {
  const source = activityObject(activityObject(item.evidence)?.["source"]);
  const payload = activityObject(source?.["payload"]);
  if (
    source?.["type"] !== "response_item" ||
    !payload ||
    ![
      "function_call",
      "custom_tool_call",
      "function_call_output",
      "custom_tool_call_output",
    ].includes(text(payload["type"]) ?? "")
  ) {
    return nativeActivity(item, context);
  }
  const outputRecord = (text(payload["type"]) ?? "").endsWith("_output");
  const output = outputRecord ? decoded(payload["output"] ?? null) : null;
  const name =
    text(payload["name"]) ??
    (item.type === "functionCallOutput"
      ? item.name
      : item.type === "dynamicToolCall"
        ? item.tool
        : "unknown_tool");
  const namespace = text(payload["namespace"]) ?? ("namespace" in item ? item.namespace : null);
  const outcome = decodeToolOutcome(outputRecord ? (payload["output"] ?? null) : null, {
    name,
    namespace,
    explicitStatus: payload["status"],
  });
  const status = outcome.status;
  const recordedTimestamp = text(source["timestamp"]);
  const createdAt =
    recordedTimestamp !== null && Number.isFinite(Date.parse(recordedTimestamp))
      ? recordedTimestamp
      : null;
  const codeMode = recordedToolInventory(
    payload,
    item.id,
    (() => {
      const identity = activityObject(activityObject(item.evidence)?.["rawIdentity"]);
      return identity
        ? JSON.stringify([identity["codexHomeId"], identity["physicalRolloutId"]])
        : null;
    })(),
  );
  return {
    id: item.id,
    turnId: context.turnId,
    createdAt,
    rawEventIds: context.rawEventIds,
    kind: "tool",
    name,
    namespace,
    callId: text(payload["call_id"]),
    status,
    startedAt: outputRecord ? null : createdAt,
    completedAt: outputRecord && status !== "running" ? createdAt : null,
    durationMs: null,
    input: outputRecord ? null : decoded(payload["arguments"] ?? payload["input"] ?? null),
    output,
    error: outcome.error,
    presentation: {
      category: "other",
      label: outputRecord ? "Tool result" : "Tool invocation",
      subject: "Recorded direct tool evidence",
      status,
      evidenceKind: "direct",
      itemId: null,
      callId: text(payload["call_id"]),
      cellId: codeMode?.cellId ?? null,
      childIds: [],
      details: { sourceItemId: item.id, outputRecord, source: source },
    },
    ...(codeMode ? { codeMode } : {}),
  };
}
function lifecycle(status: string | null): ActivityStatus {
  return status === "inProgress"
    ? "running"
    : status === "failed"
      ? "failed"
      : status === "declined" || status === "interrupted"
        ? "cancelled"
        : status === "completed"
          ? "succeeded"
          : "unknown";
}

/** One semantic adapter for canonical native items in both loaded windows and static normalization */
export function nativeActivity(
  item: HistoryItem,
  context: { turnId: string; sessionId: string; rawEventIds: string[] },
): ConversationActivity | null {
  const base = {
    id: item.id,
    turnId: context.turnId,
    createdAt: timestamp(item.startedAtMs),
    rawEventIds: context.rawEventIds,
  };
  const evidence = activityObject(item.evidence);
  const original = activityObject(evidence?.["original"]) ?? evidence;
  const directLifecycle = [
    "exec_command_begin",
    "exec_command_end",
    "patch_apply_begin",
    "patch_apply_end",
  ].includes(text(original?.["type"]) ?? "");
  const callId = directLifecycle ? text(original?.["call_id"]) : null;
  let status: ActivityStatus = "status" in item ? lifecycle(item.status) : "unknown";
  const presentation: ActivityPresentation = {
    category: "other",
    label: item.type,
    subject: "",
    status,
    evidenceKind: directLifecycle ? "direct" : "native",
    itemId: directLifecycle ? null : item.id,
    callId,
    cellId: null,
    childIds: [],
    details: item.evidence,
  };
  const tool = (
    name: string,
    namespace: string | null,
    input: JsonValue,
    output: JsonValue,
    durationMs: number | null,
    error: string | null = null,
  ): ToolActivity =>
    presentTool({
      ...base,
      kind: "tool",
      name,
      namespace,
      callId,
      nativeItemId: directLifecycle ? null : item.id,
      status,
      startedAt: timestamp(item.startedAtMs),
      completedAt: timestamp(item.completedAtMs),
      durationMs,
      input,
      output,
      error,
      presentation: { ...presentation, status },
    });
  switch (item.type) {
    case "commandExecution": {
      // A completed lifecycle alone does not supply a missing process exit outcome
      if (item.status === "completed") {
        status = item.exitCode === null ? "unknown" : item.exitCode === 0 ? "succeeded" : "failed";
      }
      presentation.category = "shell";
      presentation.label = status === "succeeded" ? "Ran command" : "Run command";
      presentation.subject =
        item.command ??
        (item.commandArgs === null ? "Command unavailable" : JSON.stringify(item.commandArgs));
      const action =
        item.commandActions.length === 1 ? activityObject(item.commandActions[0]) : null;
      if (
        action?.["type"] === "read" ||
        action?.["type"] === "search" ||
        action?.["type"] === "listFiles" ||
        action?.["type"] === "list_files"
      ) {
        presentation.category = action["type"] === "search" ? "search" : "read";
        presentation.label =
          action["type"] === "read"
            ? "Read file"
            : action["type"] === "search"
              ? "Search files"
              : "List files";
        presentation.subject =
          text(action["path"]) ??
          text(action["query"]) ??
          text(action["name"]) ??
          presentation.subject;
      }
      return tool(
        "exec_command",
        null,
        {
          cmd: item.command,
          commandArgs: item.commandArgs,
          cwd: item.cwd,
          commandActions: item.commandActions,
          processId: item.processId,
          source: item.source,
        },
        item.output,
        item.durationMs,
        item.exitCode !== null && item.exitCode !== 0
          ? `Command exited with code ${item.exitCode}`
          : null,
      );
    }
    case "mcpToolCall":
      if (item.status === "completed" && item.result === null && item.error === null) {
        status = "unknown";
      }
      if (item.error !== null || activityObject(item.result)?.["isError"] === true) {
        status = "failed";
      }
      presentation.category = "app";
      presentation.label = `${item.server} · ${item.tool.replaceAll("_", " ")}`;
      presentation.subject = text(activityObject(item.arguments)?.["query"]) ?? item.tool;
      return tool(
        item.tool,
        item.server,
        item.arguments,
        item.result,
        item.durationMs,
        item.error === null ? null : JSON.stringify(item.error),
      );
    case "dynamicToolCall":
      if (item.success === false || item.error !== null) {
        status = "failed";
      } else if (item.status === "completed") {
        status = item.success === true ? "succeeded" : "unknown";
      }
      presentation.label = item.tool.replaceAll("_", " ");
      presentation.subject =
        text(activityObject(item.arguments)?.["path"]) ?? "Recorded tool operation";
      // Name-based classification belongs to the shared renderer for ordinary direct tools
      return tool(
        item.tool,
        item.namespace,
        item.arguments,
        item.contentItems,
        item.durationMs,
        item.error,
      );
    case "fileChange":
      presentation.category = "edit";
      presentation.label = "File changes";
      presentation.subject = item.changes
        .map((change) => change.movePath ?? change.path)
        .join(", ");
      return {
        ...base,
        kind: "file_change",
        status,
        presentation,
        files: item.changes.map((change) => ({
          path: change.movePath ?? change.path,
          previousPath: change.movePath === null ? null : change.path,
          change: change.movePath === null ? change.kind : "move",
          diff: change.diff,
          content: change.content,
          ...fileChangeLineCounts(change),
        })),
      };
    case "collabAgentToolCall":
      presentation.category = "agent";
      presentation.label = item.tool.replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`);
      presentation.childIds = item.receiverThreadIds;
      presentation.subject = item.receiverThreadIds.join(", ") || "Agent operation";
      return tool(
        item.tool,
        "collaboration",
        {
          senderThreadId: item.senderThreadId,
          receiverThreadIds: item.receiverThreadIds,
          prompt: item.prompt,
          model: item.model,
          reasoningEffort: item.reasoningEffort,
        },
        item.agentsStates,
        null,
      );
    case "subAgentActivity":
      presentation.category = "agent";
      presentation.label = item.kind;
      presentation.subject = item.agentPath;
      presentation.childIds = [item.agentThreadId];
      return {
        ...base,
        kind: "subagent",
        status: "unknown",
        agentId: item.agentThreadId,
        parentThreadId: context.sessionId || null,
        childThreadId: item.agentThreadId,
        description: `${item.agentPath} · ${item.kind}`,
        presentation,
      };
    case "functionCallOutput":
      presentation.label = "Tool result";
      presentation.subject = item.name;
      return tool(item.name, item.namespace, null, item.output, null);
    default:
      return null;
  }
}
