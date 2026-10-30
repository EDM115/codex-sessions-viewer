import * as z from "zod";

import type { GuardianReview } from "#shared/types/approvals.ts";
import { jsonValueSchema, type JsonValue } from "#shared/types/conversation.ts";
import { historyItemSchema, type HistoryItem } from "#shared/types/history.ts";

export const NATIVE_ITEM_ADAPTER_VERSION = 5;
const citationEntriesSchema = z.array(
  z.object({
    path: z.string(),
    lineStart: z.int().min(0).max(0xffff_ffff),
    lineEnd: z.int().min(0).max(0xffff_ffff),
    note: z.string(),
  }),
);
const coreCitationSchema = z.object({
  entries: citationEntriesSchema,
  rolloutIds: z.array(z.string()),
});
const nativeCitationSchema = z.object({
  entries: citationEntriesSchema,
  threadIds: z.array(z.string()),
});
const object = z.record(z.string(), jsonValueSchema);
const envelope = z.looseObject({ id: z.string().min(1), type: z.string().min(1) });
const strings = z.array(z.string());
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function millis(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function record(value: unknown): Record<string, JsonValue> | null {
  const result = object.safeParse(value);
  return result.success ? result.data : null;
}
function camel(value: string): string {
  return value.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}
function duration(value: unknown): number | null {
  const parsed = z
    .object({ secs: z.int().nonnegative(), nanos: z.int().min(0).max(999_999_999) })
    .safeParse(value);
  return parsed.success
    ? millis(parsed.data.secs * 1000 + Math.floor(parsed.data.nanos / 1_000_000))
    : null;
}
function finish(value: unknown): HistoryItem | null {
  const parsed = historyItemSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
const textElement = z.object({
  byteRange: z.object({ start: z.int().nonnegative(), end: z.int().nonnegative() }),
  placeholder: z.string().nullable().default(null),
});
const userInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    text_elements: z.array(textElement).default([]),
  }),
  z
    .object({
      type: z.literal("image"),
      url: z.string().optional(),
      fileId: z.string().optional(),
      detail: z.string().nullable().default(null),
    })
    .refine((input) => (input.url === undefined) !== (input.fileId === undefined)),
  z.object({
    type: z.literal("localImage"),
    path: z.string(),
    detail: z.string().nullable().default(null),
  }),
  z.object({ type: z.literal("audio"), url: z.string() }),
  z.object({ type: z.literal("localAudio"), path: z.string() }),
  z.object({ type: z.literal("skill"), name: z.string(), path: z.string() }),
  z.object({ type: z.literal("mention"), name: z.string(), path: z.string() }),
]);
function userContent(value: unknown, core: boolean): JsonValue[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const mapped = value.map((part: unknown) => {
    const input = record(part);
    if (!input || !core) {
      return input;
    }
    switch (input["type"]) {
      case "text":
        return {
          ...input,
          text_elements: Array.isArray(input["text_elements"])
            ? input["text_elements"].map((span) => {
                const entry = record(span);
                return {
                  byteRange: entry?.["byte_range"],
                  placeholder: entry?.["placeholder"] ?? null,
                };
              })
            : [],
        };
      case "image":
        return {
          type: "image",
          ...(input["file_id"] == null
            ? { url: input["image_url"] }
            : { fileId: input["file_id"] }),
          detail: input["detail"] ?? null,
        };
      case "audio":
        return { type: "audio", url: input["audio_url"] };
      case "local_image":
        return { ...input, type: "localImage" };
      case "local_audio":
        return { ...input, type: "localAudio" };
      default:
        return input;
    }
  });
  const parsed = z.array(userInputSchema).safeParse(mapped);
  return parsed.success ? parsed.data : null;
}
function base(
  value: Record<string, JsonValue>,
  lifecycle: Record<string, JsonValue>,
  core: boolean,
) {
  const completed = millis(lifecycle[core ? "completed_at_ms" : "completedAtMs"]);
  return {
    id: value["id"],
    startedAtMs: millis(lifecycle[core ? "started_at_ms" : "startedAtMs"]),
    completedAtMs: completed === 0 ? null : completed,
    evidence: value,
  };
}

/** Core TurnItem and app-server ThreadItem are distinct wire families at upstream 6fe77fc */
export function adaptCoreTurnItem(value: unknown, lifecycle: unknown = {}): HistoryItem | null {
  return adapt(value, lifecycle, true);
}
export function adaptNativeThreadItem(value: unknown): HistoryItem | null {
  return adapt(value, value, false);
}

/** The pinned item_builders.rs maps command lifecycle call_id to CommandExecution.id */
export function adaptCommandEvent(value: unknown): HistoryItem | null {
  const event = record(value);
  if (
    !event ||
    !["exec_command_begin", "exec_command_end", "patch_apply_begin", "patch_apply_end"].includes(
      text(event["type"]) ?? "",
    )
  ) {
    return null;
  }
  const patch = event["type"] === "patch_apply_begin" || event["type"] === "patch_apply_end";
  const begin = event["type"] === "exec_command_begin" || event["type"] === "patch_apply_begin";
  const item = adaptCoreTurnItem({
    ...event,
    id: event["call_id"],
    type: patch ? "FileChange" : "CommandExecution",
    status: begin ? "in_progress" : event["status"],
  });
  return item === null ? null : { ...item, evidence: event };
}

function adapt(value: unknown, lifecycle: unknown, core: boolean): HistoryItem | null {
  const item = record(value);
  if (item === null || !envelope.safeParse(item).success) {
    return null;
  }
  const rawType = typeof item["type"] === "string" ? item["type"] : "";
  const type = core ? rawType[0]!.toLowerCase() + rawType.slice(1) : rawType;
  if (core && rawType === type) {
    return null;
  }
  const common = { ...base(item, record(lifecycle) ?? {}, core), type };
  const field = (native: string, canonical: string = native) =>
    item[core ? canonical : native] ?? null;
  const state = field("status");
  const status = typeof state === "string" ? camel(state) : state;
  const durationMs = core ? duration(item["duration"]) : millis(item["durationMs"]);
  switch (type) {
    case "agentMessage": {
      const parts = z
        .array(z.object({ type: z.literal("Text"), text: z.string() }))
        .safeParse(item["content"]);
      if (core && !parts.success) {
        return null;
      }
      const citationValue = field("memoryCitation", "memory_citation");
      const citation =
        citationValue === null
          ? null
          : (core ? coreCitationSchema : nativeCitationSchema).safeParse(citationValue);
      if (citation !== null && !citation.success) {
        return null;
      }
      const memoryCitation =
        citation === null
          ? null
          : {
              entries: citation.data.entries,
              threadIds:
                "rolloutIds" in citation.data ? citation.data.rolloutIds : citation.data.threadIds,
            };
      return finish({
        ...common,
        text: core ? parts.data!.map((part) => part.text).join("") : item["text"],
        phase: field("phase"),
        memoryCitation,
        delivery: field("delivery"),
        questions: field("questions"),
      });
    }
    case "userMessage": {
      const content = userContent(item["content"], core);
      if (content === null) {
        return null;
      }
      return finish({
        ...common,
        content,
        text: content
          .flatMap((part) => {
            const input = record(part);
            return input?.["type"] === "text" ? [text(input["text"]) ?? ""] : [];
          })
          .join("\n"),
        clientId: field("clientId", "client_id"),
      });
    }
    case "imageGeneration":
      return finish({
        ...common,
        result: field("result"),
        savedPath: field("savedPath", "saved_path"),
        fileId: field("fileId", "file_id"),
      });
    case "reasoning":
      return finish({
        ...common,
        summary: field("summary", "summary_text") ?? [],
        content: field("content", "raw_content") ?? [],
      });
    case "commandExecution": {
      if (core && !strings.safeParse(item["command"]).success) {
        return null;
      }
      return finish({
        ...common,
        command: core ? null : item["command"],
        commandArgs: core ? item["command"] : null,
        cwd: item["cwd"],
        commandActions: field("commandActions", "parsed_cmd") ?? [],
        processId: field("processId", "process_id"),
        source: field("source"),
        status,
        output: field("aggregatedOutput", "aggregated_output"),
        exitCode: field("exitCode", "exit_code"),
        durationMs,
      });
    }
    case "fileChange": {
      const entries = core ? record(item["changes"]) : null;
      if (core && entries === null) {
        return null;
      }
      const native = core
        ? Object.entries(entries!).map(([path, change]) => Object.assign({ path }, record(change)))
        : item["changes"];
      if (!Array.isArray(native)) {
        return null;
      }
      const changes = native.map((change) => {
        const row = record(change) ?? {};
        const kindValue = core ? row["type"] : row["kind"];
        const kind = typeof kindValue === "string" ? kindValue : record(kindValue)?.["type"];
        const movePath = core
          ? (row["move_path"] ?? null)
          : (record(kindValue)?.["movePath"] ?? null);
        const diff = core
          ? kind === "add" || kind === "delete"
            ? row["content"]
            : typeof row["unified_diff"] === "string"
              ? row["unified_diff"] +
                (typeof movePath === "string" ? `\n\nMoved to: ${movePath}` : "")
              : null
          : row["diff"];
        return {
          path: row["path"],
          kind,
          movePath,
          diff: kind === "update" ? (diff ?? null) : null,
          content: kind === "add" || kind === "delete" ? (diff ?? null) : null,
        };
      });
      return finish({ ...common, status, changes });
    }
    case "mcpToolCall":
      return finish({
        ...common,
        server: item["server"],
        tool: item["tool"],
        arguments: item["arguments"],
        status,
        result: field("result"),
        error: field("error"),
        durationMs,
        appContext: core
          ? item["connectorId"] == null
            ? null
            : {
                connectorId: item["connectorId"],
                linkId: item["linkId"] ?? null,
                resourceUri: item["mcpAppResourceUri"] ?? null,
                appName: item["appName"] ?? null,
                actionName: item["actionName"] ?? null,
              }
          : field("appContext"),
      });
    case "dynamicToolCall":
      return finish({
        ...common,
        namespace: field("namespace"),
        tool: item["tool"],
        arguments: item["arguments"],
        status,
        contentItems: field("contentItems", "content_items"),
        success: field("success"),
        error: core ? field("error") : null,
        durationMs,
      });
    case "collabAgentToolCall": {
      const states = record(field("agentsStates", "agents_states"));
      if (states === null) {
        return null;
      }
      const agentsStates = core
        ? Object.fromEntries(
            Object.entries(states).map(([id, agentState]) => {
              const pair =
                typeof agentState === "string"
                  ? [agentState, null]
                  : Object.entries(record(agentState) ?? {})[0];
              return [
                id,
                pair ? { status: camel(String(pair[0])), message: pair[1] ?? null } : null,
              ];
            }),
          )
        : states;
      return finish({
        ...common,
        tool: typeof item["tool"] === "string" ? camel(item["tool"]) : null,
        status,
        senderThreadId: field("senderThreadId", "sender_thread_id"),
        receiverThreadIds: field("receiverThreadIds", "receiver_thread_ids") ?? [],
        prompt: field("prompt"),
        model: field("model"),
        reasoningEffort: field("reasoningEffort", "reasoning_effort"),
        agentsStates,
      });
    }
    case "subAgentActivity":
      return finish({
        ...common,
        kind: item["kind"],
        agentThreadId: field("agentThreadId", "agent_thread_id"),
        agentPath: field("agentPath", "agent_path"),
        model: field("model"),
        reasoningEffort: field("reasoningEffort", "reasoning_effort"),
      });
    case "contextCompaction":
      return finish(common);
    case "plan":
      return finish({ ...common, text: item["text"] });
    case "functionCallOutput":
      return finish({
        ...common,
        name: item["name"],
        namespace: field("namespace"),
        output: item["output"],
      });
    default:
      return null;
  }
}

const approvalEnvelope = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  reviewId: z.string().min(1),
  targetItemId: z.string().nullable(),
  startedAtMs: z.int().nonnegative(),
  completedAtMs: z.int().nonnegative().optional(),
  review: z.object({
    status: z.enum(["inProgress", "approved", "denied", "timedOut", "aborted"]),
    riskLevel: z.string().nullable().optional(),
    userAuthorization: z.string().nullable().optional(),
    rationale: z.string().nullable().optional(),
  }),
  action: jsonValueSchema,
});
/** Separate notification evidence, never synthesized into a thread_items row */
export function adaptGuardianReviewEnvelope(value: unknown): GuardianReview | null {
  const parsed = approvalEnvelope.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const { data } = parsed;
  const iso = (ms: number | undefined) =>
    ms == null || !Number.isFinite(new Date(ms).valueOf()) ? null : new Date(ms).toISOString();
  return {
    reviewId: data.reviewId,
    targetItemId: data.targetItemId,
    targetTurnId: data.turnId,
    parentThreadId: data.threadId,
    guardianSessionId: null,
    reviewedAction: data.action,
    outcome:
      data.review.status === "approved" ? "allow" : data.review.status === "denied" ? "deny" : null,
    status: data.review.status,
    riskLevel: data.review.riskLevel ?? "unknown",
    userAuthorization: data.review.userAuthorization ?? null,
    rationale: data.review.rationale ?? "",
    requestedAt: iso(data.startedAtMs),
    reviewedAt: iso(data.completedAtMs),
    rawEventIds: [],
  };
}
