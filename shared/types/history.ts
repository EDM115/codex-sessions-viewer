import * as z from "zod";

import { jsonValueSchema, rawEventIdentitySchema } from "#shared/types/conversation.ts";
import { richTextDocumentSchema } from "#shared/types/richText.ts";

const id = z.string().min(1);
const ordinal = z.int().nonnegative();
const nullableText = z.string().nullable();
const time = z.int().nonnegative().nullable();
export const logicalVisibilitySchema = z.enum(["visible", "context-only", "unresolved"]);
export type LogicalVisibility = z.infer<typeof logicalVisibilitySchema>;
export const reviewSourceRecordSchema = z.strictObject({
  envelope: jsonValueSchema,
  identity: rawEventIdentitySchema,
  logicalVisibility: logicalVisibilitySchema.default("unresolved"),
});
export type ReviewSourceRecord = z.infer<typeof reviewSourceRecordSchema>;
export const historyReviewEvidenceSchema = z.strictObject({
  availability: z.enum(["complete", "partial", "unresolved"]),
  records: z.array(reviewSourceRecordSchema),
});
const base = {
  id,
  startedAtMs: time,
  completedAtMs: time,
  evidence: jsonValueSchema,
};
const status = z.enum(["inProgress", "completed", "failed", "declined", "interrupted"]);
export const historyItemSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("imageGeneration"),
    result: nullableText,
    savedPath: nullableText,
    fileId: nullableText,
  }),
  z.object({
    ...base,
    type: z.literal("userMessage"),
    content: z.array(jsonValueSchema),
    text: z.string(),
    clientId: nullableText,
  }),
  z.object({
    ...base,
    type: z.literal("agentMessage"),
    text: z.string(),
    phase: nullableText,
    memoryCitation: jsonValueSchema,
    delivery: nullableText,
    questions: jsonValueSchema,
  }),
  z.object({
    ...base,
    type: z.literal("reasoning"),
    summary: z.array(z.string()),
    content: z.array(z.string()),
  }),
  z.object({
    ...base,
    type: z.literal("commandExecution"),
    command: nullableText,
    commandArgs: z.array(z.string()).nullable(),
    cwd: z.string(),
    commandActions: z.array(jsonValueSchema),
    processId: nullableText,
    source: nullableText,
    status,
    output: nullableText,
    exitCode: z.int().nullable(),
    durationMs: time,
  }),
  z.object({
    ...base,
    type: z.literal("fileChange"),
    status: status.nullable(),
    changes: z.array(
      z.object({
        path: z.string(),
        kind: z.enum(["add", "delete", "update"]),
        movePath: nullableText,
        diff: nullableText,
        content: nullableText,
      }),
    ),
  }),
  z.object({
    ...base,
    type: z.literal("mcpToolCall"),
    server: z.string(),
    tool: z.string(),
    arguments: jsonValueSchema,
    status,
    result: jsonValueSchema,
    error: jsonValueSchema,
    durationMs: time,
    appContext: jsonValueSchema,
  }),
  z.object({
    ...base,
    type: z.literal("dynamicToolCall"),
    namespace: nullableText,
    tool: z.string(),
    arguments: jsonValueSchema,
    status,
    contentItems: jsonValueSchema,
    success: z.boolean().nullable(),
    error: nullableText.default(null),
    durationMs: time,
  }),
  z.object({
    ...base,
    type: z.literal("collabAgentToolCall"),
    tool: z.string(),
    status,
    senderThreadId: id,
    receiverThreadIds: z.array(id),
    prompt: nullableText,
    model: nullableText,
    reasoningEffort: nullableText,
    agentsStates: z.record(z.string(), z.object({ status: z.string(), message: nullableText })),
  }),
  z.object({
    ...base,
    type: z.literal("subAgentActivity"),
    kind: z.string(),
    agentThreadId: id,
    agentPath: z.string(),
    model: nullableText,
    reasoningEffort: nullableText,
  }),
  z.object({ ...base, type: z.literal("contextCompaction") }),
  z.object({ ...base, type: z.literal("plan"), text: z.string() }),
  z.object({
    ...base,
    type: z.literal("functionCallOutput"),
    name: z.string(),
    namespace: nullableText,
    output: jsonValueSchema,
  }),
]);
export type HistoryItem = z.infer<typeof historyItemSchema>;

export const historyLoadedRangeSchema = z.strictObject({
  physicalRolloutId: id,
  startOrdinal: ordinal.nullable(),
  endOrdinalExclusive: ordinal.nullable(),
  startDecodedByte: ordinal.optional(),
  endDecodedByteExclusive: ordinal.optional(),
  sha256: z.string().optional(),
});
export const historyCoverageSchema = z.strictObject({
  status: z.enum(["complete", "partial", "unresolved", "unsupported"]),
  segments: z.array(
    z.strictObject({
      physicalRolloutId: id,
      endOrdinalExclusive: ordinal.nullable(),
      endDecodedByteExclusive: ordinal.nullable(),
      coveredRanges: z.array(historyLoadedRangeSchema),
      projectionWatermark: z
        .strictObject({ nextOrdinal: ordinal, nextByteOffset: ordinal })
        .nullable(),
      sourceWatermark: z.strictObject({ nextOrdinal: ordinal, nextByteOffset: ordinal }).nullable(),
    }),
  ),
  gaps: z.array(
    z.strictObject({
      physicalRolloutId: id,
      turnId: id.nullable(),
      reason: z.string(),
      beforeOrdinal: ordinal.nullable(),
      afterOrdinal: ordinal.nullable(),
    }),
  ),
  total: ordinal.optional(),
});
export type HistoryCoverage = z.infer<typeof historyCoverageSchema>;
export const historyTurnWindowSchema = z.strictObject({
  reviewEvidence: historyReviewEvidenceSchema.optional(),
  turnId: id,
  physicalRolloutId: id,
  order: ordinal,
  segmentOrder: ordinal.optional(),
  decodedByteOrder: ordinal.optional(),
  orderKind: z.enum(["ordinal", "decodedByte"]).optional(),
  boundary: z
    .strictObject({
      status: z.enum(["verified", "unresolved"]),
      sourceTurnId: id.nullable(),
      decodedByteStart: ordinal.nullable(),
      identityAliases: z.array(id),
    })
    .optional(),
  context: z
    .strictObject({
      model: nullableText,
      effort: nullableText,
      cwd: nullableText,
      complete: z.boolean(),
      source: z
        .strictObject({
          physicalRolloutId: id,
          decodedByteStart: ordinal,
          ordinal: ordinal.nullable(),
          turnId: id.nullable().optional(),
        })
        .optional(),
    })
    .optional(),
  status: z.enum(["inProgress", "completed", "failed", "interrupted", "unknown"]),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  durationMs: time,
  opening: z.strictObject({
    itemId: id.nullable(),
    availability: z.enum(["notLoaded", "available", "absent", "unsupported", "unresolved"]),
    item: historyItemSchema.nullable(),
  }),
  items: z.array(
    z.strictObject({
      physicalRolloutId: id,
      ordinal: ordinal.nullable(),
      decodedByteStart: ordinal.optional(),
      decodedByteEnd: ordinal.optional(),
      updatedAtOrdinal: ordinal.nullable(),
      updatedAtDecodedByte: ordinal.optional(),
      detail: z.enum(["full", "unsupported", "unresolved"]),
      itemId: id,
      item: historyItemSchema.nullable(),
    }),
  ),
  itemsView: z.enum(["notLoaded", "summary", "full"]),
  preparation: z
    .strictObject({ kind: z.enum(["opening", "legacyBoundary", "updates"]), cursor: id.nullable() })
    .optional(),
  beforeCursor: id.nullable(),
  afterCursor: id.nullable(),
  loadedRanges: z.array(historyLoadedRangeSchema),
  itemIslands: z.array(z.array(id)).optional(),
  coverage: historyCoverageSchema,
  finalAnswerItemId: id.nullable(),
  historyEpoch: id,
  contentRevision: id,
});
export type HistoryTurnWindow = z.infer<typeof historyTurnWindowSchema>;
export const historyPageSchema = z.strictObject({
  reviewEvidence: historyReviewEvidenceSchema.optional(),
  stale: z.boolean().optional(),
  threadId: id,
  metadataRevision: id.nullable(),
  contentRevision: id,
  historyEpoch: id,
  turns: z.array(historyTurnWindowSchema),
  beforeCursor: id.nullable(),
  afterCursor: id.nullable(),
  coverage: historyCoverageSchema,
  preparation: z.enum(["ready", "partial", "unavailable"]),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;
export const historyAttachmentSchema = z.strictObject({
  mediaType: z.enum(["image", "audio", "video", "file"]),
  source: z.string().max(5 * 1024 * 1024),
});
export type HistoryAttachment = z.infer<typeof historyAttachmentSchema>;
export const historyPresentationRequestSchema = z.strictObject({
  threadId: id,
  historyEpoch: id,
  contentRevision: id,
  physicalRolloutId: id,
  turnId: id,
  itemId: id,
  markdown: z.string().max(5 * 1024 * 1024),
  attachments: z.array(historyAttachmentSchema).max(100).optional(),
});
export type HistoryPresentationRequest = z.infer<typeof historyPresentationRequestSchema>;
export const historyPresentationSchema = historyPresentationRequestSchema.extend({
  body: richTextDocumentSchema,
});
export type HistoryPresentation = z.infer<typeof historyPresentationSchema>;
export const historyNavigatorPageSchema = historyPageSchema.omit({ turns: true }).extend({
  turns: z.array(
    historyTurnWindowSchema
      .pick({
        turnId: true,
        physicalRolloutId: true,
        order: true,
        orderKind: true,
        status: true,
        boundary: true,
      })
      .extend({ promptPreview: z.string().nullable() }),
  ),
});
export type HistoryNavigatorPage = z.infer<typeof historyNavigatorPageSchema>;
export function historyNavigatorPage(page: HistoryPage): HistoryNavigatorPage {
  return {
    ...page,
    turns: page.turns.map((turn) => ({
      turnId: turn.turnId,
      physicalRolloutId: turn.physicalRolloutId,
      order: turn.order,
      orderKind: turn.orderKind,
      status: turn.status,
      boundary: turn.boundary,
      promptPreview:
        turn.opening.item?.type === "userMessage" ? turn.opening.item.text.slice(0, 240) : null,
    })),
  };
}
