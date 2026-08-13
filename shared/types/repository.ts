import * as z from "zod";

import {
  conversationScopeSchema,
  conversationSummarySchema,
  conversationTurnSchema,
  isoTimestampSchema,
  jsonValueSchema,
  sha256Schema,
  tokenUsageSchema,
  turnNavigatorItemSchema,
  type ConversationSummary,
  type ConversationTurn,
  type JsonValue,
  type TokenUsage,
  type TurnNavigatorItem,
} from "./conversation.ts";

export type RepositoryMode = "live" | "static";

export interface RepositoryCapabilities {
  liveUpdates: boolean;
  serverSettings: boolean;
  backgroundFaviconFetch: boolean;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export interface SessionListQuery {
  scope: "active" | "archived";
  cursor?: string;
  limit?: number;
  query?: string;
  model?: string;
  cwd?: string;
  tool?: string;
  hasMedia?: boolean;
}

export interface SearchQuery extends SessionListQuery {
  query: string;
}

export interface SearchHit {
  sessionId: string;
  turnId: string;
  messageId: string | null;
  scope: "active" | "archived";
  title: string;
  excerpt: string;
  score: number;
}

export interface TurnChunkQuery {
  cursor?: string;
  direction?: "before" | "after";
  limit?: number;
  targetTurnId?: string;
}

export interface TurnChunk {
  sessionId: string;
  turns: ConversationTurn[];
  previousCursor: string | null;
  nextCursor: string | null;
  revision: string;
}

export type InspectorTarget =
  | { type: "message"; id: string }
  | { type: "turn"; id: string }
  | { type: "activity"; id: string };

export interface InspectorRecord {
  sessionId: string;
  target: InspectorTarget;
  models: string[];
  reasoningEfforts: string[];
  phase: string | null;
  createdAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  tokenDelta: TokenUsage | null;
  toolCounts: Record<string, number>;
  activityIds: string[];
  eventIds: string[];
  diagnosticIds: string[];
  rawRecords: JsonValue[];
}

export interface ResolvedAsset {
  id: string;
  url: string | null;
  mimeType: string | null;
  byteSize: number | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  status: "available" | "missing" | "error";
  originalPath: string | null;
}

export type ViewerInvalidationType =
  | "library.updated"
  | "session.updated"
  | "settings.updated"
  | "diagnostic.updated";

export interface ViewerInvalidation {
  type: ViewerInvalidationType;
  ids: string[];
  revision: string;
}

export interface ConversationRepository {
  capabilities(): RepositoryCapabilities;
  listSessions(query: SessionListQuery): Promise<CursorPage<ConversationSummary>>;
  search(query: SearchQuery): Promise<CursorPage<SearchHit>>;
  getSession(id: string): Promise<ConversationSummary>;
  getTurnNavigator(id: string): Promise<TurnNavigatorItem[]>;
  getTurns(id: string, query: TurnChunkQuery): Promise<TurnChunk>;
  getInspector(id: string, target: InspectorTarget): Promise<InspectorRecord>;
  resolveAsset(assetId: string): Promise<ResolvedAsset>;
  subscribe(listener: (event: ViewerInvalidation) => void): () => void;
}

export const repositoryCapabilitiesSchema = z.strictObject({
  liveUpdates: z.boolean(),
  serverSettings: z.boolean(),
  backgroundFaviconFetch: z.boolean(),
});

export function repositoryCapabilitiesForMode(mode: RepositoryMode): RepositoryCapabilities {
  const enabled = mode === "live";
  return {
    liveUpdates: enabled,
    serverSettings: enabled,
    backgroundFaviconFetch: enabled,
  };
}

const cursorSchema = z.string().min(1);
const pageLimitSchema = z.int().min(1).max(200);

export function cursorPageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.strictObject({
    items: z.array(itemSchema),
    nextCursor: cursorSchema.nullable(),
    total: z.int().nonnegative(),
  });
}

export const sessionListQuerySchema = z.strictObject({
  scope: conversationScopeSchema,
  cursor: cursorSchema.optional(),
  limit: pageLimitSchema.optional(),
  query: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  tool: z.string().optional(),
  hasMedia: z.boolean().optional(),
});

export const searchQuerySchema = sessionListQuerySchema.extend({
  query: z.string().min(1),
});

export const searchHitSchema = z.strictObject({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  messageId: z.string().nullable(),
  scope: conversationScopeSchema,
  title: z.string(),
  excerpt: z.string(),
  score: z.number().nonnegative(),
});

export const sessionListResponseSchema = cursorPageSchema(conversationSummarySchema);
export const searchResponseSchema = cursorPageSchema(searchHitSchema);
export const turnNavigatorResponseSchema = z.array(turnNavigatorItemSchema);

export const turnChunkQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  direction: z.enum(["before", "after"]).optional(),
  limit: pageLimitSchema.optional(),
  targetTurnId: z.string().min(1).optional(),
});

export const turnChunkSchema = z.strictObject({
  sessionId: z.string().min(1),
  turns: z.array(conversationTurnSchema),
  previousCursor: cursorSchema.nullable(),
  nextCursor: cursorSchema.nullable(),
  revision: z.string().min(1),
});

export const inspectorTargetSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("message"), id: z.string().min(1) }),
  z.strictObject({ type: z.literal("turn"), id: z.string().min(1) }),
  z.strictObject({ type: z.literal("activity"), id: z.string().min(1) }),
]);

export const inspectorRecordSchema = z.strictObject({
  sessionId: z.string().min(1),
  target: inspectorTargetSchema,
  models: z.array(z.string()),
  reasoningEfforts: z.array(z.string()),
  phase: z.string().nullable(),
  createdAt: isoTimestampSchema.nullable(),
  completedAt: isoTimestampSchema.nullable(),
  durationMs: z.number().nonnegative().nullable(),
  timeToFirstTokenMs: z.number().nonnegative().nullable(),
  tokenDelta: tokenUsageSchema.nullable(),
  toolCounts: z.record(z.string(), z.int().nonnegative()),
  activityIds: z.array(z.string()),
  eventIds: z.array(z.string()),
  diagnosticIds: z.array(z.string()),
  rawRecords: z.array(jsonValueSchema),
});

export const resolvedAssetSchema = z.strictObject({
  id: z.string().min(1),
  url: z.string().nullable(),
  mimeType: z.string().nullable(),
  byteSize: z.int().nonnegative().nullable(),
  sha256: sha256Schema.nullable(),
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
  status: z.enum(["available", "missing", "error"]),
  originalPath: z.string().nullable(),
});

export const viewerInvalidationSchema = z.strictObject({
  type: z.enum(["library.updated", "session.updated", "settings.updated", "diagnostic.updated"]),
  ids: z.array(z.string()),
  revision: z.string().min(1),
});
