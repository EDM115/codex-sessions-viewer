import * as z from "zod";

import { jsonValueSchema, turnNavigatorItemSchema } from "./conversation.ts";
import { conversationProjectSchema } from "./library.ts";
import { inspectorRecordSchema, type InspectorRecord } from "./repository.ts";

export const compactInspectorRecordSchema = inspectorRecordSchema.omit({ rawRecords: true });

export const staticLibraryPayloadSchema = z.strictObject({
  version: z.literal(1),
  projects: z.array(conversationProjectSchema),
  entries: z.record(
    z.string(),
    z.strictObject({
      kind: z.enum(["root", "subagent"]),
      projectId: z.string().min(1),
      parentThreadId: z.string().min(1).nullable(),
      agentPath: z.string().min(1).nullable(),
      agentNickname: z.string().min(1).nullable(),
      agentDepth: z.int().nonnegative().nullable(),
      childCount: z.int().nonnegative(),
    }),
  ),
});

export type StaticLibraryPayload = z.infer<typeof staticLibraryPayloadSchema>;

export const staticNavigatorPayloadSchema = z.strictObject({
  version: z.literal(2),
  sessionId: z.string().min(1),
  revision: z.string().min(1),
  chunkSize: z.int().min(1).max(200),
  chunkCount: z.int().nonnegative(),
  items: z.array(turnNavigatorItemSchema),
  turnChunks: z.record(z.string(), z.int().nonnegative()),
  inspectorChunks: z.record(z.string(), z.int().nonnegative()),
});

export type StaticNavigatorPayload = z.infer<typeof staticNavigatorPayloadSchema>;

export const staticInspectorChunkSchema = z.strictObject({
  version: z.literal(2),
  sessionId: z.string().min(1),
  revision: z.string().min(1),
  records: z.array(compactInspectorRecordSchema),
  rawRecords: z.record(z.string(), jsonValueSchema),
});

export type StaticInspectorChunk = z.infer<typeof staticInspectorChunkSchema>;
export type CompactInspectorRecord = z.infer<typeof compactInspectorRecordSchema>;

export function hydrateStaticInspectorRecord(
  chunk: StaticInspectorChunk,
  record: CompactInspectorRecord,
): InspectorRecord {
  return inspectorRecordSchema.parse({
    ...record,
    rawRecords: record.eventIds.flatMap((id) => {
      const raw = chunk.rawRecords[id];
      return raw === undefined ? [] : [raw];
    }),
  });
}

export function hydrateStaticInspectorRecords(chunk: StaticInspectorChunk): InspectorRecord[] {
  return chunk.records.map((record) => hydrateStaticInspectorRecord(chunk, record));
}
