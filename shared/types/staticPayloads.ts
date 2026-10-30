import * as z from "zod";

import {
  conversationSummarySchema,
  jsonValueSchema,
  turnNavigatorItemSchema,
} from "#shared/types/conversation.ts";
import {
  catalogLibrarySchema,
  catalogSessionMetadataSchema,
  conversationProjectSchema,
  threadClassificationSchema,
} from "#shared/types/library.ts";
import { inspectorRecordSchema, type InspectorRecord } from "#shared/types/repository.ts";

export const compactInspectorRecordSchema = inspectorRecordSchema.omit({ rawRecords: true });

export const staticSessionIndexSchema = z.discriminatedUnion("version", [
  z.strictObject({ version: z.literal(1), sessions: z.array(conversationSummarySchema) }),
  z.strictObject({ version: z.literal(2), sessions: z.array(catalogSessionMetadataSchema) }),
]);

export const legacyStaticLibraryPayloadSchema = z.strictObject({
  version: z.literal(1),
  projects: z.array(conversationProjectSchema),
  entries: z.record(
    z.string(),
    z.strictObject({
      kind: z.enum(["root", "subagent"]),
      classification: threadClassificationSchema.optional(),
      projectId: z.string().min(1),
      parentThreadId: z.string().min(1).nullable(),
      agentPath: z.string().min(1).nullable(),
      agentNickname: z.string().min(1).nullable(),
      agentDepth: z.int().nonnegative().nullable(),
      childCount: z.int().nonnegative(),
    }),
  ),
});

export const staticCatalogPayloadSchema = z.strictObject({
  version: z.literal(2),
  catalog: catalogLibrarySchema,
});
export const staticLibraryPayloadSchema = z.discriminatedUnion("version", [
  legacyStaticLibraryPayloadSchema,
  staticCatalogPayloadSchema,
]);
export type LegacyStaticLibraryPayload = z.infer<typeof legacyStaticLibraryPayloadSchema>;

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
