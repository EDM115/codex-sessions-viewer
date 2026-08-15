import * as z from "zod";

import { jsonValueSchema } from "./conversation.ts";
import { inspectorRecordSchema, type InspectorRecord } from "./repository.ts";

export const compactInspectorRecordSchema = inspectorRecordSchema.omit({ rawRecords: true });

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
