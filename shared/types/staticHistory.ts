import * as z from "zod";

import { sourceGenerationSchema } from "#shared/types/conversation.ts";
import {
  historyPageSchema,
  historyPresentationSchema,
  historyTurnWindowSchema,
} from "#shared/types/history.ts";

export const STATIC_HISTORY_ITEM_CHUNK = 100;
export const staticHistoryManifestSchema = historyPageSchema
  .omit({ turns: true, beforeCursor: true, afterCursor: true })
  .extend({
    version: z.literal(1),
    sourceGenerations: z.array(sourceGenerationSchema).optional(),
    turns: z.array(
      z.strictObject({
        turnId: z.string().min(1),
        physicalRolloutId: z.string().min(1),
        chunks: z.int().positive(),
        itemCount: z.int().nonnegative(),
        itemChunks: z.record(z.string(), z.int().nonnegative()),
      }),
    ),
  });
export type StaticHistoryManifest = z.infer<typeof staticHistoryManifestSchema>;
export const staticHistoryChunkSchema = z.strictObject({
  version: z.literal(1),
  threadId: z.string().min(1),
  window: historyTurnWindowSchema,
  presentations: z.array(historyPresentationSchema),
});
export const staticHistoryCursorSchema = z.strictObject({
  threadId: z.string(),
  historyEpoch: z.string(),
  contentRevision: z.string(),
  kind: z.enum(["turn", "item"]),
  index: z.int().nonnegative(),
  turnId: z.string().nullable(),
});
export function staticHistoryCursor(
  manifest: Pick<StaticHistoryManifest, "threadId" | "historyEpoch" | "contentRevision">,
  kind: "turn" | "item",
  index: number,
  turnId: string | null = null,
): string {
  return `static-v1:${encodeURIComponent(JSON.stringify({ threadId: manifest.threadId, historyEpoch: manifest.historyEpoch, contentRevision: manifest.contentRevision, kind, index, turnId }))}`;
}
export function readStaticHistoryCursor(
  value: string,
  manifest: StaticHistoryManifest,
  kind: "turn" | "item",
  turnId: string | null = null,
): number {
  if (!value.startsWith("static-v1:")) {
    throw new Error("history.invalid_static_cursor");
  }
  const cursor = staticHistoryCursorSchema.parse(JSON.parse(decodeURIComponent(value.slice(10))));
  if (
    cursor.threadId !== manifest.threadId ||
    cursor.historyEpoch !== manifest.historyEpoch ||
    cursor.contentRevision !== manifest.contentRevision ||
    cursor.kind !== kind ||
    cursor.turnId !== turnId
  ) {
    throw new Error("history.static_cursor_owner_mismatch");
  }
  return cursor.index;
}
