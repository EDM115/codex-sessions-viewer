import * as z from "zod";

import {
  conversationScopeSchema,
  conversationSummarySchema,
  isoTimestampSchema,
  jsonValueSchema,
  type ConversationSummary,
} from "#shared/types/conversation.ts";

export type MaterializationState = "cold" | "queued" | "loading" | "ready" | "failed";

// Catalog metadata never asserts transcript statistics or source availability
export const catalogSessionMetadataSchema = z.object({
  ...conversationSummarySchema.omit({
    models: true,
    reasoningEfforts: true,
    turnCount: true,
    assistantMessageCount: true,
    toolCallCount: true,
    toolCounts: true,
    preview: true,
    hasMedia: true,
    diagnosticCount: true,
  }).shape,
  sourcePath: z.string().nullable(),
  createdAt: isoTimestampSchema.nullable(),
  updatedAt: isoTimestampSchema.nullable(),
  recencyAt: isoTimestampSchema.nullable().optional(),
  metadataRevision: z.string().min(1).optional(),
  fieldSources: z
    .strictObject({
      title: z.string(),
      createdAt: z.string().nullable(),
      updatedAt: z.string().nullable(),
      recencyAt: z.string().nullable(),
    })
    .optional(),
  metadataConflicts: z.array(z.enum(["title", "updatedAt"])).optional(),
});
export type CatalogSessionMetadata = z.infer<typeof catalogSessionMetadataSchema>;

export const libraryEntrySchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  scope: conversationScopeSchema,
  projectId: z.string().nullable(),
  orderKey: z.string(),
  kind: z.enum(["root", "subagent"]),
  parentThreadId: z.string().nullable(),
  childCount: z.number().int().nonnegative(),
  agent: z
    .strictObject({
      name: z.string().nullable(),
      path: z.string().nullable(),
      role: z.string().nullable(),
    })
    .optional(),
});
export type LibraryEntry = z.infer<typeof libraryEntrySchema>;

export function libraryEntryFromSummary(
  item: ConversationListItem,
  projectId: string | null = item.projectId,
): LibraryEntry {
  const name = item.classification?.agentNickname ?? item.agentNickname;
  const path = item.classification?.agentPath ?? item.agentPath;
  const role = item.classification?.agentRole ?? null;
  return libraryEntrySchema.parse({
    id: item.summary.id,
    title: item.summary.title,
    scope: item.summary.scope,
    projectId,
    orderKey: item.summary.updatedAt,
    kind: item.kind,
    parentThreadId: item.parentThreadId,
    childCount: item.childCount,
    ...(item.kind === "subagent" && (name || path || role) ? { agent: { name, path, role } } : {}),
  });
}

export const threadClassificationSchema = z.strictObject({
  visibility: z.enum(["user-root", "delegated-child", "internal", "unresolved"]),
  transportSource: z.string().nullable(),
  threadSource: z.string().nullable(),
  ephemeral: z.boolean().nullable(),
  historyMode: z.string().nullable(),
  relationship: z.enum(["none", "spawn", "attached", "fork"]),
  parentThreadId: z.string().nullable(),
  attachedParentThreadId: z.string().nullable(),
  agentPath: z.string().nullable(),
  agentNickname: z.string().nullable(),
  agentRole: z.string().nullable(),
  agentDepth: z.number().int().nonnegative().nullable(),
  reasons: z.array(z.string()),
  declarations: z
    .array(
      z.strictObject({
        origin: z.enum(["metadata", "raw", "native", "spawn-edge"]),
        source: jsonValueSchema.optional(),
        threadSource: z.string().nullable(),
        parentThreadIds: z.array(z.string()),
        spawn: z.boolean(),
        internal: z.boolean(),
        ephemeral: z.boolean().nullable(),
        status: z.enum(["valid", "missing", "invalid"]),
        issues: z.array(z.string()),
      }),
    )
    .optional(),
});
export type ThreadClassification = z.infer<typeof threadClassificationSchema>;

export const catalogProjectSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  rootPaths: z.array(z.string()),
  hostId: z.string().nullable(),
  source: z.enum(["native", "legacy"]),
  position: z.number().nullable(),
  recencyAt: z.number().nullable(),
});
export type CatalogProject = z.infer<typeof catalogProjectSchema>;
export interface ResolvedThreadMembership {
  projectId: string | null;
  hostId: string | null;
  source:
    | "explicit-projectless"
    | "native"
    | "legacy-assignment"
    | "legacy-root"
    | "none"
    | "unresolved";
  diagnostics: string[];
}
export const catalogSidebarThreadSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  scope: conversationScopeSchema,
  projectId: z.string().nullable(),
  hostId: z.string().nullable(),
  sectionId: z.string().nullable(),
  sectionPosition: z.number().nullable(),
  membershipFreshness: z.enum(["fresh", "retained-unvalidated"]).optional(),
  sectionFreshness: z.enum(["fresh", "retained-unvalidated"]).optional(),
  pinned: z.boolean(),
  recencyAt: z.number().nullable(),
  classification: threadClassificationSchema,
});
export type CatalogSidebarThread = z.infer<typeof catalogSidebarThreadSchema>;
export const sidebarSectionSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  threadIds: z.array(z.string()),
  projectIds: z.array(z.string()),
  position: z.number().nullable(),
});
export type SidebarSection = z.infer<typeof sidebarSectionSchema>;
export const sidebarPreferencesSchema = z.strictObject({
  scope: conversationScopeSchema,
  chatSortMode: z.enum(["manual", "updated_at"]),
  projectSortMode: z.enum(["manual", "updated_at"]),
  projectOrder: z.array(z.string()),
  pinnedOrder: z.array(z.string()),
  pinnedProjectOrder: z.array(z.string()).optional(),
  projectThreadOrders: z.record(z.string(), z.array(z.string())),
});
export type SidebarPreferences = z.infer<typeof sidebarPreferencesSchema>;
export const catalogLibrarySchema = z.strictObject({
  projects: z.array(catalogProjectSchema),
  threads: z.array(catalogSidebarThreadSchema),
  sections: z.array(sidebarSectionSchema),
  preferences: sidebarPreferencesSchema,
  diagnostics: z.array(z.string()),
});
export type CatalogLibrary = z.infer<typeof catalogLibrarySchema>;
export interface SidebarGroup {
  id: string;
  name: string;
  kind: "project" | "recents" | "section";
  projectId: string | null;
  sectionId: string | null;
  threadIds: string[];
  projectIds: string[];
}

export interface ConversationListItem {
  classification?: ThreadClassification;
  summary: ConversationSummary;
  kind: "root" | "subagent";
  materialization: MaterializationState;
  projectId: string;
  parentThreadId: string | null;
  agentPath: string | null;
  agentNickname: string | null;
  agentDepth: number | null;
  childCount: number;
}

export interface ConversationProject {
  id: string;
  name: string;
  source: "codex" | "git" | "cwd" | "none";
  hint: string | null;
  activeCount: number;
  archivedCount: number;
  sidebar?: {
    order?: { active: number; archived: number };
    kind: "project" | "recents" | "section";
    sectionId: string | null;
    sectionName: string | null;
  };
}

export interface PreparationResult {
  id: string;
  state: MaterializationState;
  error: string | null;
}

export type DeepSearchState = "queued" | "running" | "completed" | "cancelled" | "failed";

export interface DeepSearchJob {
  id: string;
  scope: "active" | "archived";
  query: string;
  state: DeepSearchState;
  total: number;
  completed: number;
  failed: number;
  resultCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export const materializationStateSchema = z.enum(["cold", "queued", "loading", "ready", "failed"]);

export const conversationListItemSchema = z.strictObject({
  classification: threadClassificationSchema.optional(),
  summary: conversationSummarySchema,
  kind: z.enum(["root", "subagent"]),
  materialization: materializationStateSchema,
  projectId: z.string().min(1),
  parentThreadId: z.string().min(1).nullable(),
  agentPath: z.string().min(1).nullable(),
  agentNickname: z.string().min(1).nullable(),
  agentDepth: z.int().nonnegative().nullable(),
  childCount: z.int().nonnegative(),
});

export const conversationProjectSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  source: z.enum(["codex", "git", "cwd", "none"]),
  hint: z.string().min(1).nullable(),
  activeCount: z.int().nonnegative(),
  archivedCount: z.int().nonnegative(),
  sidebar: z
    .strictObject({
      order: z.strictObject({ active: z.number().int(), archived: z.number().int() }).optional(),
      kind: z.enum(["project", "recents", "section"]),
      sectionId: z.string().nullable(),
      sectionName: z.string().nullable(),
    })
    .optional(),
});

export const conversationProjectsSchema = z.array(conversationProjectSchema);

export const catalogProjectGroupSchema = catalogProjectSchema.extend({
  groupId: z.string().min(1),
  activeCount: z.int().nonnegative(),
  archivedCount: z.int().nonnegative(),
  sidebar: conversationProjectSchema.shape.sidebar,
  diagnostics: z.array(z.string()).optional(),
});
export type CatalogProjectGroup = z.infer<typeof catalogProjectGroupSchema>;
export const catalogProjectGroupsSchema = z.array(catalogProjectGroupSchema);

export function sidebarGroupKey(group: Pick<SidebarGroup, "id" | "kind">): string {
  return `${group.kind}:${encodeURIComponent(group.id)}`;
}

export function catalogProjectGroupFromLegacy(project: ConversationProject): CatalogProjectGroup {
  return {
    groupId: sidebarGroupKey({
      id: project.id,
      kind: project.sidebar?.kind ?? (project.source === "none" ? "recents" : "project"),
    }),
    id: project.id,
    name: project.name,
    rootPaths: project.hint ? [project.hint] : [],
    hostId: null,
    source: "legacy",
    position: null,
    recencyAt: null,
    activeCount: project.activeCount,
    archivedCount: project.archivedCount,
    sidebar: project.sidebar ?? {
      kind: project.source === "none" ? "recents" : "project",
      sectionId: null,
      sectionName: null,
    },
  };
}

export const preparationResultSchema = z.strictObject({
  id: z.string().min(1),
  state: materializationStateSchema,
  error: z.string().nullable(),
});

export const preparationResultsSchema = z.array(preparationResultSchema);

export const deepSearchJobSchema = z.strictObject({
  id: z.string().min(1),
  scope: conversationScopeSchema,
  query: z.string().min(1),
  state: z.enum(["queued", "running", "completed", "cancelled", "failed"]),
  total: z.int().nonnegative(),
  completed: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  resultCount: z.int().nonnegative(),
  error: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
