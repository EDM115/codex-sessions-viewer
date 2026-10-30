import { createHash } from "node:crypto";

import * as z from "zod";

import { readStableBytes } from "#server/ingestion/stableRead.ts";
import { createViewerDiagnostic, type ViewerDiagnostic } from "#shared/types/diagnostics.ts";

const id = z.string().min(1);
const strings = z.array(id);
const assignment = z.object({ projectKind: id, projectId: id });
const project = z.object({
  id,
  name: id,
  rootPaths: z.array(z.string()),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});
const appearance = z.object({
  color: z.string().optional(),
  marker: z
    .union([
      z.string(),
      z.object({ kind: id, icon: z.string().optional(), emoji: z.string().optional() }),
    ])
    .optional(),
});
const preferences = z.object({
  chatSortMode: z.enum(["manual", "updated_at"]).optional(),
  projectSortMode: z.enum(["manual", "updated_at"]).optional(),
  mode: z.enum(["project", "connection", "list"]).optional(),
  initialized: z.boolean().optional(),
  showProjectChatsInRecents: z.boolean().optional(),
  sortOrder: z.enum(["manual", "updated_at"]).optional(),
});
const workspace = z.object({
  revision: z.union([z.number(), z.string()]).optional(),
  project: assignment.nullable().optional(),
  applied: z
    .object({
      cwd: z.string().nullable().optional(),
      runtimeWorkspaceRoots: z.array(z.string()).optional(),
      projectSources: z
        .array(
          z.string().or(
            z.object({
              projectKind: id.optional(),
              projectId: id.optional(),
              path: z.string().optional(),
              rootPath: z.string().optional(),
              hostId: id.optional(),
            }),
          ),
        )
        .optional(),
    })
    .optional(),
});
const section = z.object({
  id,
  name: z.string(),
  itemKeys: strings.optional(),
  items: strings.optional(),
  appearance: appearance.optional(),
  position: z.number().optional(),
  hostSectionIds: z.record(z.string(), id).optional(),
  pendingDeletionHostIdsByItemKey: z.record(z.string(), strings).optional(),
});
const sectionState = z.object({
  sections: z.array(section).optional(),
  collapsedSectionIds: strings.optional(),
  sectionOrder: strings.optional(),
  appServerLegacySectionIds: strings.optional(),
  appServerMigratedHostIds: strings.optional(),
  threadHostIds: z.record(z.string(), id).optional(),
});
const pinnedItem = z.union([
  id,
  z.object({
    kind: id.optional(),
    type: id.optional(),
    id: id.optional(),
    key: id.optional(),
    threadId: id.optional(),
    projectId: id.optional(),
    hostId: id.optional(),
  }),
]);
export type GlobalProjectMetadata = z.output<typeof project>;
export interface GlobalStateMetadata {
  projects: GlobalProjectMetadata[];
  pinnedThreadIds: string[];
  threadProjectAssignments?: Record<string, z.output<typeof assignment>>;
  projectlessThreadIds?: string[];
  threadProjectMembershipHostIds?: Record<string, string>;
  projectIdByLegacyIdByHost?: Record<string, Record<string, string>>;
  projectThreadOrders?: Record<string, string[]>;
  projectOrder?: string[];
  projectAppearances?: Record<string, z.output<typeof appearance>>;
  sidebarPreferences?: z.output<typeof preferences>;
  unifiedProjectOrder?: string[];
  unifiedPinnedOrder?: z.output<typeof pinnedItem>[];
  sectionsByIdentity?: Record<string, z.output<typeof sectionState>>;
  collapsedSections?: Record<string, boolean>;
  threadDescriptions?: Record<string, string>;
  workspaceStates?: Record<string, z.output<typeof workspace>>;
  turnBookmarksByIdentity?: Record<string, Record<string, { turnId: string }[]>>;
  threadUserActivityTimes?: Record<string, number>;
  unreadByIdentity?: Record<string, Record<string, string[]>>;
}
export interface GlobalStateResult {
  metadata: GlobalStateMetadata;
  diagnostics: ViewerDiagnostic[];
  generation?: string;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
// Account-scoped containers retain equality without exposing account identifiers
function scopeIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export async function readGlobalState(path: string): Promise<GlobalStateResult> {
  const metadata: GlobalStateMetadata = { projects: [], pinnedThreadIds: [] };
  const diagnostics: ViewerDiagnostic[] = [];
  function invalid(field?: string) {
    diagnostics.push(
      createViewerDiagnostic({
        code: "metadata.snapshot_invalid",
        severity: "warning",
        area: "metadata",
        message: "An unsupported Codex metadata field was ignored.",
        path,
        ...(field ? { details: { field } } : {}),
      }),
    );
  }
  const stable = await readStableBytes(path);
  if (stable.read.status !== "stable") {
    invalid();
    return { metadata, diagnostics };
  }
  let decoded: Record<string, unknown> | null;
  try {
    decoded = object(JSON.parse(stable.bytes.toString("utf8")));
  } catch {
    decoded = null;
  }
  if (!decoded) {
    invalid();
    return { metadata, diagnostics };
  }
  function parse<T>(value: unknown, schema: z.ZodType<T>, field: string): T | undefined {
    const result = schema.safeParse(value);
    if (result.success) {
      return result.data;
    }
    const shapeSchema = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
    const sourceObject = object(value);
    if (shapeSchema instanceof z.ZodObject && sourceObject) {
      const repaired: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(shapeSchema.shape)) {
        if (!(key in sourceObject)) {
          continue;
        }
        const parsed =
          child instanceof z.ZodType ? parse(sourceObject[key], child, field) : undefined;
        if (parsed !== undefined) {
          repaired[key] = parsed;
        }
      }
      const recovered = schema.safeParse(repaired);
      if (recovered.success) {
        return recovered.data;
      }
    }
    if (
      shapeSchema instanceof z.ZodArray &&
      Array.isArray(value) &&
      shapeSchema.element instanceof z.ZodType
    ) {
      const recovered = schema.safeParse(list(value, shapeSchema.element, field));
      if (recovered.success) {
        return recovered.data;
      }
    }
    if (
      shapeSchema instanceof z.ZodRecord &&
      sourceObject &&
      shapeSchema.valueType instanceof z.ZodType
    ) {
      const recovered = schema.safeParse(map(sourceObject, shapeSchema.valueType, field));
      if (recovered.success) {
        return recovered.data;
      }
    }
    invalid(field);
    return undefined;
  }
  function list<T>(value: unknown, schema: z.ZodType<T>, field: string): T[] {
    if (!Array.isArray(value)) {
      invalid(field);
      return [];
    }
    return value.flatMap((entry) => {
      const parsed = parse(entry, schema, field);
      return parsed === undefined ? [] : [parsed];
    });
  }
  function map<T>(value: unknown, schema: z.ZodType<T>, field: string): Record<string, T> {
    const entries = object(value);
    if (!entries) {
      invalid(field);
      return {};
    }
    return Object.fromEntries(
      Object.entries(entries).flatMap(([key, entry]) => {
        const parsed = parse(entry, schema, field);
        return parsed === undefined ? [] : [[key, parsed]];
      }),
    );
  }
  function nested<T>(
    value: unknown,
    schema: z.ZodType<T>,
    field: string,
    hashIdentity = false,
  ): Record<string, Record<string, T>> {
    const entries = object(value);
    if (!entries) {
      invalid(field);
      return {};
    }
    return Object.fromEntries(
      Object.entries(entries).map(([key, entry]) => [
        hashIdentity ? scopeIdentity(key) : key,
        map(entry, schema, field),
      ]),
    );
  }
  const source = decoded;
  if ("local-projects" in source) {
    metadata.projects = Object.values(
      map(source["local-projects"], project, "local-projects"),
    ).toSorted((a, b) => a.id.localeCompare(b.id));
  }
  if ("pinned-thread-ids" in source) {
    metadata.pinnedThreadIds = [
      ...new Set(list(source["pinned-thread-ids"], id, "pinned-thread-ids")),
    ];
  }
  if ("thread-project-assignments" in source) {
    metadata.threadProjectAssignments = map(
      source["thread-project-assignments"],
      assignment,
      "thread-project-assignments",
    );
  }
  if ("projectless-thread-ids" in source) {
    metadata.projectlessThreadIds = list(
      source["projectless-thread-ids"],
      id,
      "projectless-thread-ids",
    );
  }
  if ("thread-project-membership-host-ids" in source) {
    metadata.threadProjectMembershipHostIds = map(
      source["thread-project-membership-host-ids"],
      id,
      "thread-project-membership-host-ids",
    );
  }
  if ("app-server-project-id-by-legacy-project-id-by-host" in source) {
    metadata.projectIdByLegacyIdByHost = nested(
      source["app-server-project-id-by-legacy-project-id-by-host"],
      id,
      "app-server-project-id-by-legacy-project-id-by-host",
    );
  }
  if ("sidebar-project-thread-orders" in source) {
    metadata.projectThreadOrders = Object.fromEntries(
      Object.entries(
        map(
          source["sidebar-project-thread-orders"],
          z.object({ threadIds: strings }),
          "sidebar-project-thread-orders",
        ),
      ).map(([key, value]) => [key, value.threadIds]),
    );
  }
  if ("project-order" in source) {
    metadata.projectOrder = list(source["project-order"], id, "project-order");
  }
  if ("project-appearances" in source) {
    metadata.projectAppearances = map(
      source["project-appearances"],
      appearance,
      "project-appearances",
    );
  }
  const atoms = object(source["electron-persisted-atom-state"]) ?? {};
  if ("flat-project-sidebar-preferences-v1" in atoms) {
    metadata.sidebarPreferences = parse(
      atoms["flat-project-sidebar-preferences-v1"],
      preferences,
      "flat-project-sidebar-preferences-v1",
    );
  }
  if ("unified-sidebar-project-order-v1" in atoms) {
    metadata.unifiedProjectOrder = list(
      atoms["unified-sidebar-project-order-v1"],
      id,
      "unified-sidebar-project-order-v1",
    );
  }
  if ("unified-sidebar-pinned-order-v1" in atoms) {
    metadata.unifiedPinnedOrder = list(
      atoms["unified-sidebar-pinned-order-v1"],
      pinnedItem,
      "unified-sidebar-pinned-order-v1",
    );
  }
  if ("sidebar-custom-sections-v3" in atoms) {
    metadata.sectionsByIdentity = Object.fromEntries(
      Object.entries(
        map(atoms["sidebar-custom-sections-v3"], sectionState, "sidebar-custom-sections-v3"),
      ).map(([key, value]) => [scopeIdentity(key), value]),
    );
  }
  if ("sidebar-collapsed-sections-v1" in atoms) {
    metadata.collapsedSections = map(
      atoms["sidebar-collapsed-sections-v1"],
      z.boolean(),
      "sidebar-collapsed-sections-v1",
    );
  }
  if ("thread-descriptions-v1" in atoms) {
    metadata.threadDescriptions = map(
      atoms["thread-descriptions-v1"],
      z.string(),
      "thread-descriptions-v1",
    );
  }
  const workspaces = Object.entries(atoms).filter(([key]) =>
    key.startsWith("thread-workspace-state-v1:"),
  );
  if (workspaces.length) {
    metadata.workspaceStates = Object.fromEntries(
      workspaces.flatMap(([key, value]) => {
        const parsed = parse(value, workspace, "thread-workspace-state-v1");
        return parsed === undefined
          ? []
          : [[key.slice("thread-workspace-state-v1:".length), parsed]];
      }),
    );
  }
  if ("pinned-conversation-turns-v1" in atoms) {
    metadata.turnBookmarksByIdentity = nested(
      atoms["pinned-conversation-turns-v1"],
      z.array(z.object({ turnId: id })),
      "pinned-conversation-turns-v1",
      true,
    );
  }
  if ("thread-user-activity-times-v1" in atoms) {
    metadata.threadUserActivityTimes = map(
      atoms["thread-user-activity-times-v1"],
      z.number().finite(),
      "thread-user-activity-times-v1",
    );
  }
  const reads = object(source["electron-thread-read-state-v1"]);
  if (reads && "unreadByIdentity" in reads) {
    metadata.unreadByIdentity = nested(
      reads["unreadByIdentity"],
      strings,
      "electron-thread-read-state-v1",
      true,
    );
  }
  return {
    metadata,
    diagnostics,
    generation: createHash("sha256").update(stable.bytes).digest("hex"),
  };
}
