import * as z from "zod";

import { jsonValueSchema, type JsonValue } from "../../shared/types/conversation.ts";
import type { CatalogThreadMetadata } from "./threadClassification.ts";

const optionalText = z.string().nullable().optional();
const parent = z
  .string()
  .refine((value) => value.trim() !== "")
  .nullable()
  .optional();
const spawn = z
  .object({ parent_thread_id: parent, parentThreadId: parent })
  .catchall(jsonValueSchema);
const subagent = z.union([
  z.string(),
  z
    .object({
      thread_spawn: spawn.optional(),
      threadSpawn: spawn.optional(),
      parent_thread_id: parent,
      parentThreadId: parent,
      other: optionalText,
    })
    .catchall(jsonValueSchema),
]);
const sourceShape = z
  .union([
    z.string(),
    z
      .object({ subagent: subagent.optional(), subAgent: subagent.optional() })
      .catchall(jsonValueSchema),
  ])
  .nullable();

export function decodeThreadSource(source: JsonValue | undefined): JsonValue | null {
  if (typeof source !== "string") {
    return source ?? null;
  }
  try {
    const parsed = jsonValueSchema.safeParse(JSON.parse(source));
    return parsed.success ? parsed.data : source;
  } catch {
    return source;
  }
}

export const rawThreadStructureSchema = z.object({
  id: z.string().min(1).optional(),
  source: jsonValueSchema.optional().superRefine((value, context) => {
    if (!sourceShape.safeParse(decodeThreadSource(value)).success) {
      context.addIssue({ code: "custom", message: "Invalid structural source representation" });
    }
  }),
  thread_source: optionalText,
  threadSource: optionalText,
  ephemeral: z.boolean().nullable().optional(),
  history_mode: optionalText,
  historyMode: optionalText,
  parent_thread_id: parent,
  parentThreadId: parent,
  attached_parent_thread_id: parent,
  attachedParentThreadId: parent,
  attached_thread: jsonValueSchema.optional(),
  attachedThread: jsonValueSchema.optional(),
  forked_from_id: parent,
  forkedFromId: parent,
  agent_path: optionalText,
  agentPath: optionalText,
  agent_nickname: optionalText,
  agentNickname: optionalText,
  agent_role: optionalText,
  agentRole: optionalText,
});

export interface RawThreadMetadataResult {
  status: "valid" | "missing" | "invalid";
  metadata: CatalogThreadMetadata | null;
  issues: string[];
}

export function rawThreadMetadata(value: unknown): RawThreadMetadataResult {
  if (value === null || value === undefined) {
    return { status: "missing", metadata: null, issues: [] };
  }
  const result = rawThreadStructureSchema.safeParse(value);
  if (!result.success) {
    return {
      status: "invalid",
      metadata: null,
      issues: result.error.issues.map((issue) => issue.path.join(".")),
    };
  }
  const payload = result.data;
  return {
    status: "valid",
    issues: [],
    metadata: {
      source: payload.source,
      threadSource: payload.thread_source ?? payload.threadSource ?? null,
      ephemeral: payload.ephemeral ?? null,
      historyMode: payload.history_mode ?? payload.historyMode ?? null,
      parentThreadId: payload.parent_thread_id ?? payload.parentThreadId ?? null,
      attachedParentThreadId:
        payload.attached_parent_thread_id ?? payload.attachedParentThreadId ?? null,
      attachedThread: payload.attached_thread ?? payload.attachedThread,
      forkedFromId: payload.forked_from_id ?? payload.forkedFromId ?? null,
      agentPath: payload.agent_path ?? payload.agentPath ?? null,
      agentNickname: payload.agent_nickname ?? payload.agentNickname ?? null,
      agentRole: payload.agent_role ?? payload.agentRole ?? null,
    },
  };
}
