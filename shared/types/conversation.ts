import * as z from "zod";

import { richTextDocumentSchema, type RichTextDocument } from "./richText.ts";

export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
export const MAX_MEDIA_REFERENCE_PREVIEW_LENGTH = 160;
export const MAX_DATA_REFERENCE_PAYLOAD_LENGTH = MAX_MEDIA_BYTES * 3;

export type ConversationScope = "active" | "archived";
export type MessageRole = "user" | "assistant";
export type DisclosureDefault = "collapsed" | "expanded";
export type ViewerTheme = "midnight-glass" | "quiet-precision" | "editorial-archive";
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface SourceFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  parsedBytes: number;
  parserVersion: number;
}

export const rolloutHistoryBaseSchema = z.strictObject({
  physicalRolloutId: z.string().min(1),
  endOrdinalExclusive: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  endByteOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type RolloutHistoryBase = z.infer<typeof rolloutHistoryBaseSchema>;
export const rolloutRefSchema = z.strictObject({
  codexHomeId: z.string().min(1),
  stableThreadId: z.string().min(1),
  physicalRolloutId: z.string().nullable(),
  rootSessionId: z.string().nullable(),
  sourcePath: z.string().min(1),
  representation: z.enum(["plain-jsonl", "zstd-jsonl", "unsupported"]),
  historyBase: rolloutHistoryBaseSchema.nullable(),
  subagentHistoryStartOrdinal: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  forkedFromId: z.string().nullable().optional(),
  forkedFromOrdinalExclusive: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
  parentThreadId: z.string().nullable().optional(),
  attachedThread: z
    .lazy(() => jsonValueSchema)
    .nullable()
    .optional(),
  historyMode: z.string().nullable().optional(),
});
export type RolloutRef = z.infer<typeof rolloutRefSchema>;

const generationSha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const verifiedDecodedRangeSchema = z
  .strictObject({
    start: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    endExclusive: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: generationSha256Schema,
  })
  .refine((range) => range.endExclusive >= range.start);
export const sourceGenerationSchema = z.strictObject({
  codexHomeId: z.string().min(1),
  physicalRolloutId: z.string().min(1),
  sourcePath: z.string().min(1),
  representation: z.enum(["plain-jsonl", "zstd-jsonl", "unsupported"]),
  observation: z.strictObject({
    device: z.string(),
    inode: z.string(),
    encodedSize: z.number().int().nonnegative(),
    mtimeNs: z.string(),
    ctimeNs: z.string(),
  }),
  encodedSha256: generationSha256Schema.nullable(),
  decodedSha256: generationSha256Schema.nullable(),
  decodedSize: z.number().int().nonnegative().nullable(),
  validationScope: z.enum(["selected-range", "full-stream"]),
  verifiedDecodedRanges: z.array(verifiedDecodedRangeSchema),
  parserVersion: z.number().int().positive(),
  decoderVersion: z.string().min(1),
  token: z.string().min(1),
  semanticEpoch: z.string().nullable().optional(),
  dependencies: z
    .array(z.strictObject({ ref: rolloutRefSchema, encodedSha256: generationSha256Schema }))
    .optional(),
});
export type SourceGeneration = z.infer<typeof sourceGenerationSchema>;
export const rawEventIdentitySchema = z.strictObject({
  codexHomeId: z.string().min(1),
  physicalRolloutId: z.string().min(1),
  ordinal: z.number().int().nonnegative().nullable(),
  decodedByteStart: z.number().int().nonnegative(),
  decodedByteEnd: z.number().int().nonnegative(),
  rangeSha256: generationSha256Schema,
  correlationKeys: z.array(z.string()),
});
export type RawEventIdentity = z.infer<typeof rawEventIdentitySchema>;

export interface ConversationSummary {
  id: string;
  title: string;
  scope: ConversationScope;
  sourcePath: string;
  createdAt: string;
  updatedAt: string;
  cwd: string | null;
  gitBranch: string | null;
  gitSha: string | null;
  gitOriginUrl: string | null;
  models: string[];
  reasoningEfforts: string[];
  turnCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  toolCounts: Record<string, number>;
  preview: string;
  pinned: boolean;
  sectionName: string | null;
  parentThreadId: string | null;
  childThreadIds: string[];
  hasMedia: boolean;
  diagnosticCount: number;
  revision: string;
}

export interface ConversationMessage {
  id: string;
  turnId: string;
  role: MessageRole;
  phase: string | null;
  createdAt: string | null;
  sourceMarkdown: string;
  body: RichTextDocument;
  attachmentIds: string[];
  rawEventIds: string[];
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export type ActivityStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

interface ConversationActivityBase {
  id: string;
  turnId: string;
  createdAt: string | null;
  rawEventIds: string[];
  presentation?: ActivityPresentation;
}

export interface ActivityPresentation {
  category: "shell" | "read" | "search" | "edit" | "web" | "app" | "agent" | "other";
  label: string;
  subject: string;
  status: ActivityStatus;
  evidenceKind: "native" | "direct" | "host-attempt" | "inference";
  itemId: string | null;
  callId: string | null;
  cellId: string | null;
  childIds: string[];
  details: JsonValue;
}

export interface ReasoningActivity extends ConversationActivityBase {
  kind: "reasoning";
  summary: string;
  body: RichTextDocument | null;
  bodyFromSummary?: boolean;
  encrypted: boolean;
}

export interface GuardianApprovalEvidence {
  reviewedAction: JsonValue;
  outcome: "allow" | "deny" | null;
  riskLevel: string;
  userAuthorization: string | null;
  rationale: string;
  reviewedAt: string | null;
  reviewId?: string | null;
  targetItemId?: string | null;
  targetTurnId?: string | null;
  status?: string | null;
  rawEventIds?: string[];
}

export interface ToolActivity extends ConversationActivityBase {
  kind: "tool";
  namespace: string | null;
  name: string;
  callId: string | null;
  status: ActivityStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  input: JsonValue;
  output: JsonValue;
  error: string | null;
  approval?: GuardianApprovalEvidence | null;
  approvalAttempts?: GuardianApprovalEvidence[];
  nativeItemId?: string | null;
  approvalReviewId?: string | null;
  codeMode?: CodeModeEvidence;
}

export interface CodeModeEvidence {
  cellId: string | null;
  scopeId: string | null;
  /** The host's inventory claim, not proof that the viewer loaded every cell output */
  completeness: "absent" | "partial" | "complete";
  loadedCoverage: "unknown" | "partial";
  deltas: Array<{ sourceEventId: string; calls: JsonObject[] | null; complete: boolean | null }>;
  outerActivityIds: string[];
}

export interface WebSearchActivity extends ConversationActivityBase {
  kind: "web_search";
  query: string;
  status: ActivityStatus;
  resultCount: number | null;
}

export interface PatchActivity extends ConversationActivityBase {
  kind: "patch";
  status: ActivityStatus;
  patch: string;
  affectedPaths: string[];
}

export interface FileChange {
  path: string;
  change: "add" | "update" | "delete" | "move";
  previousPath: string | null;
  diff: string | null;
  content: string | null;
  addedLines: number | null;
  removedLines: number | null;
}

export interface FileChangeActivity extends ConversationActivityBase {
  kind: "file_change";
  status: ActivityStatus;
  files: FileChange[];
}

export interface PlanActivity extends ConversationActivityBase {
  kind: "plan";
  status: ActivityStatus;
  title: string | null;
  items: Array<{
    step: string;
    status: "pending" | "in_progress" | "completed";
  }>;
}

export interface SubagentActivity extends ConversationActivityBase {
  kind: "subagent";
  status: ActivityStatus;
  agentId: string | null;
  parentThreadId: string | null;
  childThreadId: string | null;
  description: string;
}

export interface StatusActivity extends ConversationActivityBase {
  kind: "status";
  status: ActivityStatus;
  message: string;
}

export interface CompactionActivity extends ConversationActivityBase {
  kind: "compaction";
  summary: string | null;
}

export type MediaReferenceProvenance = "user-message" | "response-input" | "generated";
export type InvalidMediaReferenceReason =
  | "empty"
  | "extraction-failed"
  | "malformed-data"
  | "malformed-path"
  | "missing"
  | "oversized-data"
  | "relative-path"
  | "unsupported-media-type"
  | "unsupported-scheme";

export type MediaReference =
  | {
      kind: "local-file";
      path: string;
      provenance: MediaReferenceProvenance;
    }
  | {
      kind: "data";
      mimeType: string;
      encoding: "base64" | "percent";
      payload: string;
      sourceHash: string;
    }
  | {
      kind: "remote";
      url: string;
    }
  | {
      kind: "asset";
      mimeType: string;
      byteSize: number;
      sha256: string;
    }
  | {
      kind: "invalid";
      reason: InvalidMediaReferenceReason;
      preview: string;
      sourceHash: string | null;
    };

export interface MediaActivity extends ConversationActivityBase {
  kind: "media";
  assetId: string;
  mediaType: "image" | "audio" | "video" | "file";
  reference: MediaReference;
}

export interface UnknownActivity extends ConversationActivityBase {
  kind: "unknown";
  eventType: string;
  payload: JsonValue;
}

export type ConversationActivity =
  | ReasoningActivity
  | ToolActivity
  | WebSearchActivity
  | PatchActivity
  | FileChangeActivity
  | PlanActivity
  | SubagentActivity
  | StatusActivity
  | CompactionActivity
  | MediaActivity
  | UnknownActivity;

export interface TurnEntryReference {
  kind: "message" | "activity";
  id: string;
}

export interface ConversationTurn {
  id: string;
  sourceTurnId: string | null;
  sessionId: string;
  index: number;
  userMessage: ConversationMessage | null;
  steeringMessages?: ConversationMessage[];
  assistantMessages: ConversationMessage[];
  activities: ConversationActivity[];
  entryOrder?: TurnEntryReference[];
  finalAssistantMessageId?: string | null;
  status?: "inProgress" | "completed" | "failed" | "interrupted" | "unknown";
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  tokenDelta: TokenUsage | null;
  models: string[];
  reasoningEfforts: string[];
  toolCounts: Record<string, number>;
  diagnosticIds: string[];
}

export interface TurnNavigatorItem {
  turnId: string;
  index: number;
  userMessageId: string | null;
  promptPreview: string;
  assistantPreview: string;
  proseLengthBucket: 1 | 2 | 3 | 4;
  createdAt: string | null;
}

export const conversationScopeSchema = z.enum(["active", "archived"]);
export const messageRoleSchema = z.enum(["user", "assistant"]);
export const disclosureDefaultSchema = z.enum(["collapsed", "expanded"]);
export const viewerThemeSchema = z.enum(["midnight-glass", "quiet-precision", "editorial-archive"]);
export const isoTimestampSchema = z.iso.datetime({ offset: true });
export const sha256Schema = z.string().regex(/^[a-f\d]{64}$/i);
export const mediaReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("local-file"),
    path: z.string().min(1).max(4_096),
    provenance: z.enum(["user-message", "response-input", "generated"]),
  }),
  z.strictObject({
    kind: z.literal("data"),
    mimeType: z.string().min(1).max(255),
    encoding: z.enum(["base64", "percent"]),
    payload: z.string().max(MAX_DATA_REFERENCE_PAYLOAD_LENGTH),
    sourceHash: sha256Schema,
  }),
  z.strictObject({
    kind: z.literal("remote"),
    url: z.url().max(2_048),
  }),
  z.strictObject({
    kind: z.literal("asset"),
    mimeType: z.string().min(1).max(255),
    byteSize: z.int().nonnegative(),
    sha256: sha256Schema,
  }),
  z.strictObject({
    kind: z.literal("invalid"),
    reason: z.enum([
      "empty",
      "extraction-failed",
      "malformed-data",
      "malformed-path",
      "missing",
      "oversized-data",
      "relative-path",
      "unsupported-media-type",
      "unsupported-scheme",
    ]),
    preview: z.string().max(MAX_MEDIA_REFERENCE_PREVIEW_LENGTH),
    sourceHash: sha256Schema.nullable(),
  }),
]);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.number(),
    z.string(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const countSchema = z.int().nonnegative();
const nullableTimestampSchema = isoTimestampSchema.nullable();
const toolCountsSchema = z.record(z.string(), countSchema);

export const sourceFingerprintSchema = z
  .strictObject({
    path: z.string().min(1),
    size: countSchema,
    mtimeMs: z.number().nonnegative(),
    sha256: sha256Schema,
    parsedBytes: countSchema,
    parserVersion: z.int().positive(),
  })
  .refine((value) => value.parsedBytes <= value.size, {
    error: "parsedBytes cannot exceed source size",
    path: ["parsedBytes"],
  });

export const conversationSummarySchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  scope: conversationScopeSchema,
  sourcePath: z.string().min(1),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  cwd: z.string().nullable(),
  gitBranch: z.string().nullable(),
  gitSha: z.string().nullable(),
  gitOriginUrl: z.string().nullable(),
  models: z.array(z.string()),
  reasoningEfforts: z.array(z.string()),
  turnCount: countSchema,
  assistantMessageCount: countSchema,
  toolCallCount: countSchema,
  toolCounts: toolCountsSchema,
  preview: z.string(),
  pinned: z.boolean(),
  sectionName: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  childThreadIds: z.array(z.string()),
  hasMedia: z.boolean(),
  diagnosticCount: countSchema,
  revision: z.string().min(1),
});

export const conversationMessageSchema = z.strictObject({
  id: z.string().min(1),
  turnId: z.string().min(1),
  role: messageRoleSchema,
  phase: z.string().nullable(),
  createdAt: isoTimestampSchema.nullable(),
  sourceMarkdown: z.string(),
  body: richTextDocumentSchema,
  attachmentIds: z.array(z.string()),
  rawEventIds: z.array(z.string()),
});

export const tokenUsageSchema = z.strictObject({
  inputTokens: countSchema,
  cachedInputTokens: countSchema,
  outputTokens: countSchema,
  reasoningOutputTokens: countSchema,
  totalTokens: countSchema,
});

const activityStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
const activityBaseShape = {
  id: z.string().min(1),
  turnId: z.string().min(1),
  createdAt: nullableTimestampSchema,
  rawEventIds: z.array(z.string()),
  presentation: z
    .strictObject({
      category: z.enum(["shell", "read", "search", "edit", "web", "app", "agent", "other"]),
      label: z.string(),
      subject: z.string(),
      status: activityStatusSchema,
      evidenceKind: z.enum(["native", "direct", "host-attempt", "inference"]),
      itemId: z.string().nullable(),
      callId: z.string().nullable(),
      cellId: z.string().nullable(),
      childIds: z.array(z.string()),
      details: jsonValueSchema,
    })
    .optional(),
};

export const guardianApprovalEvidenceSchema = z.strictObject({
  reviewedAction: jsonValueSchema,
  outcome: z.enum(["allow", "deny"]).nullable(),
  riskLevel: z.string().min(1),
  userAuthorization: z.string().min(1).nullable(),
  rationale: z.string(),
  reviewedAt: nullableTimestampSchema,
  reviewId: z.string().nullable().optional(),
  targetItemId: z.string().nullable().optional(),
  targetTurnId: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  rawEventIds: z.array(z.string()).optional(),
});

export const conversationActivitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...activityBaseShape,
    kind: z.literal("reasoning"),
    summary: z.string(),
    body: richTextDocumentSchema.nullable(),
    bodyFromSummary: z.boolean().optional(),
    encrypted: z.boolean(),
  }),
  z.strictObject({
    ...activityBaseShape,
    kind: z.literal("tool"),
    namespace: z.string().nullable(),
    name: z.string().min(1),
    callId: z.string().nullable(),
    status: activityStatusSchema,
    startedAt: nullableTimestampSchema,
    completedAt: nullableTimestampSchema,
    durationMs: z.number().nonnegative().nullable(),
    input: jsonValueSchema,
    output: jsonValueSchema,
    error: z.string().nullable(),
    approval: guardianApprovalEvidenceSchema.nullable().optional(),
    approvalAttempts: z.array(guardianApprovalEvidenceSchema).optional(),
    nativeItemId: z.string().nullable().optional(),
    approvalReviewId: z.string().nullable().optional(),
    codeMode: z
      .strictObject({
        cellId: z.string().nullable(),
        scopeId: z.string().nullable(),
        completeness: z.enum(["absent", "partial", "complete"]),
        loadedCoverage: z.enum(["unknown", "partial"]),
        deltas: z.array(
          z.strictObject({
            sourceEventId: z.string(),
            calls: z.array(z.record(z.string(), jsonValueSchema)).nullable(),
            complete: z.boolean().nullable(),
          }),
        ),
        outerActivityIds: z.array(z.string()),
      })
      .optional(),
  }),
  z.strictObject({
    ...activityBaseShape,
    kind: z.literal("web_search"),
    query: z.string(),
    status: activityStatusSchema,
    resultCount: countSchema.nullable(),
  }),
  z.strictObject({
    ...activityBaseShape,
    kind: z.literal("patch"),
    status: activityStatusSchema,
    patch: z.string(),
    affectedPaths: z.array(z.string()),
  }),
  z.strictObject({
    ...activityBaseShape,
    kind: z.literal("file_change"),
    status: activityStatusSchema,
    files: z.array(
      z.strictObject({
        path: z.string().min(1),
        change: z.enum(["add", "update", "delete", "move"]),
        previousPath: z.string().min(1).nullable(),
        diff: z.string().nullable(),
        content: z.string().nullable(),
        addedLines: countSchema.nullable(),
        removedLines: countSchema.nullable(),
      }),
    ),
  }),
  z.strictObject({
    ...activityBaseShape,
    kind: z.literal("plan"),
    status: activityStatusSchema,
    title: z.string().nullable(),
    items: z.array(
      z.strictObject({
        step: z.string(),
        status: z.enum(["pending", "in_progress", "completed"]),
      }),
    ),
  }),
  z.strictObject({
    ...activityBaseShape,
    kind: z.literal("subagent"),
    status: activityStatusSchema,
    agentId: z.string().nullable(),
    parentThreadId: z.string().nullable(),
    childThreadId: z.string().nullable(),
    description: z.string(),
  }),
  z.strictObject({
    ...activityBaseShape,
    kind: z.literal("status"),
    status: activityStatusSchema,
    message: z.string(),
  }),
  z.strictObject({
    ...activityBaseShape,
    kind: z.literal("compaction"),
    summary: z.string().nullable(),
  }),
  z.strictObject({
    ...activityBaseShape,
    kind: z.literal("media"),
    assetId: z.string().min(1),
    mediaType: z.enum(["image", "audio", "video", "file"]),
    reference: mediaReferenceSchema,
  }),
  z.strictObject({
    ...activityBaseShape,
    kind: z.literal("unknown"),
    eventType: z.string().min(1),
    payload: jsonValueSchema,
  }),
]);

export const conversationTurnSchema = z.strictObject({
  id: z.string().min(1),
  sourceTurnId: z.string().min(1).nullable(),
  sessionId: z.string().min(1),
  index: countSchema,
  userMessage: conversationMessageSchema.nullable(),
  steeringMessages: z.array(conversationMessageSchema).optional(),
  assistantMessages: z.array(conversationMessageSchema),
  activities: z.array(conversationActivitySchema),
  entryOrder: z
    .array(
      z.strictObject({
        kind: z.enum(["message", "activity"]),
        id: z.string().min(1),
      }),
    )
    .optional(),
  finalAssistantMessageId: z.string().min(1).nullable().optional(),
  status: z.enum(["inProgress", "completed", "failed", "interrupted", "unknown"]).optional(),
  startedAt: nullableTimestampSchema,
  completedAt: nullableTimestampSchema,
  durationMs: z.number().nonnegative().nullable(),
  timeToFirstTokenMs: z.number().nonnegative().nullable(),
  tokenDelta: tokenUsageSchema.nullable(),
  models: z.array(z.string()),
  reasoningEfforts: z.array(z.string()),
  toolCounts: toolCountsSchema,
  diagnosticIds: z.array(z.string()),
});

export const turnNavigatorItemSchema = z.strictObject({
  turnId: z.string().min(1),
  index: countSchema,
  userMessageId: z.string().nullable(),
  promptPreview: z.string(),
  assistantPreview: z.string(),
  proseLengthBucket: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  createdAt: nullableTimestampSchema,
});
