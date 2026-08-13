import * as z from "zod";

export type ConversationScope = "active" | "archived";
export type MessageRole = "user" | "assistant";
export type DisclosureDefault = "collapsed" | "expanded";
export type ViewerTheme =
  "midnight-glass" | "quiet-precision" | "editorial-archive";
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface RichTextNode {
  type: string;
  text?: string | undefined;
  attributes?: JsonObject | undefined;
  children?: RichTextNode[] | undefined;
}

export interface RichTextDocument {
  type: "document";
  children: RichTextNode[];
}

export interface SourceFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  parsedBytes: number;
  parserVersion: number;
}

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
  createdAt: string;
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
  "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";

interface ConversationActivityBase {
  id: string;
  turnId: string;
  createdAt: string | null;
  rawEventIds: string[];
}

export interface ReasoningActivity extends ConversationActivityBase {
  kind: "reasoning";
  summary: string;
  body: RichTextDocument | null;
  encrypted: boolean;
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

export interface MediaActivity extends ConversationActivityBase {
  kind: "media";
  assetId: string;
  mediaType: "image" | "audio" | "video" | "file";
  sourcePath: string | null;
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
  | PlanActivity
  | SubagentActivity
  | StatusActivity
  | CompactionActivity
  | MediaActivity
  | UnknownActivity;

export interface ConversationTurn {
  id: string;
  sessionId: string;
  index: number;
  userMessage: ConversationMessage | null;
  assistantMessages: ConversationMessage[];
  activities: ConversationActivity[];
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
export const viewerThemeSchema = z.enum([
  "midnight-glass",
  "quiet-precision",
  "editorial-archive",
]);
export const isoTimestampSchema = z.iso.datetime({ offset: true });
export const sha256Schema = z.string().regex(/^[a-f\d]{64}$/i);

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

export const richTextNodeSchema: z.ZodType<RichTextNode> = z.lazy(() =>
  z.strictObject({
    type: z.string().min(1),
    text: z.string().optional(),
    attributes: z.record(z.string(), jsonValueSchema).optional(),
    children: z.array(richTextNodeSchema).optional(),
  }),
);

export const richTextDocumentSchema = z.strictObject({
  type: z.literal("document"),
  children: z.array(richTextNodeSchema),
});

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
  createdAt: isoTimestampSchema,
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
};

export const conversationActivitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...activityBaseShape,
    kind: z.literal("reasoning"),
    summary: z.string(),
    body: richTextDocumentSchema.nullable(),
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
    sourcePath: z.string().nullable(),
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
  sessionId: z.string().min(1),
  index: countSchema,
  userMessage: conversationMessageSchema.nullable(),
  assistantMessages: z.array(conversationMessageSchema),
  activities: z.array(conversationActivitySchema),
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
  proseLengthBucket: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
  ]),
  createdAt: nullableTimestampSchema,
});
