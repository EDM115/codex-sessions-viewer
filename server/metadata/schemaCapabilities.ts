import type { DatabaseSync } from "node:sqlite";

import * as z from "zod";

export interface SchemaCapabilities {
  tables: Record<string, string[]>;
  diagnostics: { table: string; field?: string; reason: "invalid-field" | "unsupported-table" }[];
}

const flag = z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1);
const text = z.string();
const nullableText = text.nullable();
const timestamp = z.number().int().finite();
const baseThread = z.object({
  id: text.min(1),
  rolloutPath: text,
  createdAt: timestamp,
  updatedAt: timestamp,
  source: text,
  modelProvider: text,
  cwd: text,
  title: text,
  tokensUsed: timestamp,
  archived: flag,
  archivedAt: timestamp.nullable(),
  gitSha: nullableText,
  gitBranch: nullableText,
  gitOriginUrl: nullableText,
  firstUserMessage: text,
  model: nullableText,
  reasoningEffort: nullableText,
  name: nullableText,
  pinned: flag,
  sectionId: nullableText,
});
const optionalThread = z.object({
  createdAtMs: timestamp.nullable().optional(),
  updatedAtMs: timestamp.nullable().optional(),
  recencyAt: timestamp.nullable().optional(),
  recencyAtMs: timestamp.nullable().optional(),
  threadSource: nullableText.optional(),
  historyMode: nullableText.optional(),
  projectId: nullableText.optional(),
  originator: nullableText.optional(),
  preview: nullableText.optional(),
  agentNickname: nullableText.optional(),
  agentRole: nullableText.optional(),
  agentPath: nullableText.optional(),
  sectionPosition: timestamp.nullable().optional(),
  sectionEnteredAtMs: timestamp.nullable().optional(),
  ephemeral: flag.nullable().optional(),
  hasUserEvent: flag.nullable().optional(),
  parentThreadId: nullableText.optional(),
  attachedParentThreadId: nullableText.optional(),
  cliVersion: nullableText.optional(),
});
export type StateThreadMetadata = z.output<typeof baseThread> & z.output<typeof optionalThread>;
export interface MetadataAppearance {
  color?: string;
  marker?: string;
}
export interface StateSectionMetadata {
  id: string;
  name: string;
  appearance?: MetadataAppearance;
}
export interface StateSpawnEdgeMetadata {
  parentThreadId: string;
  childThreadId: string;
  status: string;
}
export interface StateProjectMetadata {
  id: string;
  name: string;
  roots: { position: number; path: string }[];
  position?: number;
  createdAtMs?: number;
  updatedAtMs?: number;
  appearance?: MetadataAppearance;
}
export interface StateAttachmentMetadata {
  id: string;
  threadId: string;
  type: string;
  identityKey: string;
  createdAt?: number;
  reference?: {
    url?: string;
    threadId?: string;
    parentThreadId?: string;
    root?: string | null;
    path?: string;
    baseBranch?: string;
    headBranch?: string | null;
    number?: number;
    owner?: string;
    repository?: string;
    hostname?: string;
  };
}
export interface StateReadReceiptMetadata {
  threadId: string;
  revision: string;
  firstUnreadTurn: string | null;
  lastPublishedTurn: string | null;
}
export interface StateMetadataSnapshot {
  threads: StateThreadMetadata[];
  sections: StateSectionMetadata[];
  spawnEdges: StateSpawnEdgeMetadata[];
  projects?: StateProjectMetadata[];
  attachments?: StateAttachmentMetadata[];
  readReceipts?: StateReadReceiptMetadata[];
  capabilities?: SchemaCapabilities;
}

const baseFields: Record<keyof z.output<typeof baseThread>, string> = {
  id: "id",
  rolloutPath: "rollout_path",
  createdAt: "created_at",
  updatedAt: "updated_at",
  source: "source",
  modelProvider: "model_provider",
  cwd: "cwd",
  title: "title",
  tokensUsed: "tokens_used",
  archived: "archived",
  archivedAt: "archived_at",
  gitSha: "git_sha",
  gitBranch: "git_branch",
  gitOriginUrl: "git_origin_url",
  firstUserMessage: "first_user_message",
  model: "model",
  reasoningEffort: "reasoning_effort",
  name: "name",
  pinned: "is_pinned",
  sectionId: "thread_section_id",
};
const optionalFields: Record<keyof z.output<typeof optionalThread>, string> = {
  createdAtMs: "created_at_ms",
  updatedAtMs: "updated_at_ms",
  recencyAt: "recency_at",
  recencyAtMs: "recency_at_ms",
  threadSource: "thread_source",
  historyMode: "history_mode",
  projectId: "project_id",
  originator: "originator",
  preview: "preview",
  agentNickname: "agent_nickname",
  agentRole: "agent_role",
  agentPath: "agent_path",
  sectionPosition: "section_position",
  sectionEnteredAtMs: "section_entered_at_ms",
  ephemeral: "ephemeral",
  hasUserEvent: "has_user_event",
  parentThreadId: "parent_thread_id",
  attachedParentThreadId: "attached_parent_thread_id",
  cliVersion: "cli_version",
};
const tables = [
  "threads",
  "thread_sections",
  "thread_spawn_edges",
  "projects",
  "project_roots",
  "thread_attachments",
  "thread_read_receipts",
] as const;

export function detectSchemaCapabilities(database: DatabaseSync): SchemaCapabilities {
  const result: SchemaCapabilities = { tables: {}, diagnostics: [] };
  const existing = new Set(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((row) => row["name"]),
  );
  for (const table of tables) {
    if (existing.has(table)) {
      result.tables[table] = database
        .prepare(`PRAGMA table_xinfo("${table}")`)
        .all()
        .map((row) => String(row["name"]));
    }
  }
  return result;
}

function jsonObject(value: unknown): Record<string, unknown> {
  try {
    const decoded: unknown = typeof value === "string" ? JSON.parse(value) : value;
    return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
      ? Object.fromEntries(Object.entries(decoded))
      : {};
  } catch {
    return {};
  }
}

function appearance(
  value: unknown,
  table: string,
  capabilities: SchemaCapabilities,
): MetadataAppearance | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const object = jsonObject(value);
  let validObject = false;
  try {
    validObject = z
      .record(z.string(), z.unknown())
      .safeParse(typeof value === "string" ? JSON.parse(value) : value).success;
  } catch {
    /* Invalid JSON is diagnosed without copying source values */
  }
  if (!validObject) {
    capabilities.diagnostics.push({ table, field: "appearance", reason: "invalid-field" });
  }
  const color = object["appearance.color"] ?? object["color"];
  const marker = object["appearance.marker"] ?? object["marker"];
  for (const [field, supplied] of [
    ["color", color],
    ["marker", marker],
  ] as const) {
    if (supplied !== undefined && typeof supplied !== "string") {
      capabilities.diagnostics.push({
        table,
        field: `appearance.${field}`,
        reason: "invalid-field",
      });
    }
  }
  const result = {
    ...(typeof color === "string" ? { color } : {}),
    ...(typeof marker === "string" ? { marker } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

export function readStateMetadata(database: DatabaseSync): StateMetadataSnapshot {
  const capabilities = detectSchemaCapabilities(database);
  function selectedRows(
    table: string,
    columns: Record<string, string>,
    required: string[] = [],
  ): Record<string, unknown>[] {
    const supported = capabilities.tables[table];
    if (!supported) {
      return [];
    }
    if (required.some((column) => !supported.includes(column))) {
      capabilities.diagnostics.push({ table, reason: "unsupported-table" });
      return [];
    }
    const selected = Object.entries(columns).filter(([, column]) => supported.includes(column));
    return selected.length
      ? database
          .prepare(
            `SELECT ${selected.map(([key, column]) => `"${column}" AS "${key}"`).join(", ")} FROM "${table}"`,
          )
          .all()
      : [];
  }
  function optionalValues<T extends Record<string, z.ZodType>>(
    row: Record<string, unknown>,
    shape: T,
    table: string,
  ) {
    const result: Record<string, unknown> = {};
    for (const [field, schema] of Object.entries(shape)) {
      if (!(field in row)) {
        continue;
      }
      const parsed = schema.safeParse(row[field]);
      if (parsed.success) {
        result[field] = row[field];
      } else {
        capabilities.diagnostics.push({ table, field, reason: "invalid-field" });
      }
    }
    return z.object(shape).partial().parse(result);
  }
  if (!capabilities.tables["threads"]?.includes("id")) {
    throw new Error("State snapshot has no supported threads table");
  }
  const threads = selectedRows("threads", { ...baseFields, ...optionalFields })
    .map((row) => {
      const defaults = [
        ["archivedAt", null],
        ["gitSha", null],
        ["gitBranch", null],
        ["gitOriginUrl", null],
        ["model", null],
        ["reasoningEffort", null],
        ["name", null],
        ["pinned", 0],
        ["sectionId", null],
      ] as const;
      const candidate: Record<string, unknown> = Object.assign(Object.fromEntries(defaults), row);
      for (const [field, fallback] of defaults) {
        if (!baseThread.shape[field].safeParse(candidate[field]).success) {
          candidate[field] = fallback;
          capabilities.diagnostics.push({ table: "threads", field, reason: "invalid-field" });
        }
      }
      const parsed = baseThread.safeParse(candidate);
      if (!parsed.success) {
        throw new Error("Invalid required thread metadata");
      }
      return Object.assign(parsed.data, optionalValues(row, optionalThread.shape, "threads"));
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));
  const sections = selectedRows(
    "thread_sections",
    { id: "id", name: "name", appearance: "appearance" },
    ["id", "name"],
  )
    .flatMap((row) => {
      if (typeof row["id"] !== "string" || typeof row["name"] !== "string") {
        capabilities.diagnostics.push({ table: "thread_sections", reason: "invalid-field" });
        return [];
      }
      const style = appearance(row["appearance"], "thread_sections", capabilities);
      return [{ id: row["id"], name: row["name"], ...(style ? { appearance: style } : {}) }];
    })
    .toSorted((a, b) => a.id.localeCompare(b.id));
  const edgeSchema = z.object({ parentThreadId: text, childThreadId: text, status: text });
  const spawnEdges = selectedRows(
    "thread_spawn_edges",
    { parentThreadId: "parent_thread_id", childThreadId: "child_thread_id", status: "status" },
    ["parent_thread_id", "child_thread_id", "status"],
  )
    .flatMap((row) => {
      const parsed = edgeSchema.safeParse(row);
      if (!parsed.success) {
        capabilities.diagnostics.push({ table: "thread_spawn_edges", reason: "invalid-field" });
        return [];
      }
      return [parsed.data];
    })
    .toSorted((a, b) => a.childThreadId.localeCompare(b.childThreadId));
  const projectRoots = selectedRows(
    "project_roots",
    { projectId: "project_id", position: "position", path: "path" },
    ["project_id", "position", "path"],
  ).flatMap((row) => {
    const parsed = z
      .object({ projectId: text.min(1), position: timestamp, path: text.min(1) })
      .safeParse(row);
    if (parsed.success) {
      return [parsed.data];
    }
    for (const issue of parsed.error.issues) {
      capabilities.diagnostics.push({
        table: "project_roots",
        field: String(issue.path[0]),
        reason: "invalid-field",
      });
    }
    return [];
  });
  const projects: StateProjectMetadata[] = selectedRows(
    "projects",
    {
      id: "id",
      name: "name",
      metadata: "metadata",
      position: "position",
      createdAtMs: "created_at_ms",
      updatedAtMs: "updated_at_ms",
    },
    ["id", "name"],
  )
    .flatMap((row) => {
      if (typeof row["id"] !== "string" || typeof row["name"] !== "string") {
        capabilities.diagnostics.push({ table: "projects", reason: "invalid-field" });
        return [];
      }
      const roots = projectRoots
        .flatMap((root) =>
          root["projectId"] === row["id"] &&
          typeof root["path"] === "string" &&
          typeof root["position"] === "number"
            ? [{ position: root["position"], path: root["path"] }]
            : [],
        )
        .toSorted((a, b) => a.position - b.position);
      const style = appearance(row["metadata"], "projects", capabilities);
      return [
        {
          id: row["id"],
          name: row["name"],
          roots,
          ...optionalValues(
            row,
            { position: timestamp, createdAtMs: timestamp, updatedAtMs: timestamp },
            "projects",
          ),
          ...(style ? { appearance: style } : {}),
        },
      ];
    })
    .toSorted(
      (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.id.localeCompare(b.id),
    );
  const attachments: StateAttachmentMetadata[] = selectedRows(
    "thread_attachments",
    {
      id: "id",
      threadId: "thread_id",
      type: "attachment_type",
      identityKey: "identity_key",
      payload: "payload",
      createdAt: "created_at",
    },
    ["id", "thread_id", "attachment_type", "identity_key"],
  ).flatMap((row) => {
    const parsed = z
      .object({ id: text, threadId: text, type: text, identityKey: text })
      .safeParse(row);
    if (!parsed.success) {
      capabilities.diagnostics.push({ table: "thread_attachments", reason: "invalid-field" });
      return [];
    }
    const reference = optionalValues(
      jsonObject(row["payload"]),
      {
        url: text,
        threadId: text,
        parentThreadId: text,
        root: nullableText,
        path: text,
        baseBranch: text,
        headBranch: nullableText,
        number: timestamp,
        owner: text,
        repository: text,
        hostname: text,
      },
      "thread_attachments",
    );
    return [
      {
        ...parsed.data,
        ...optionalValues(row, { createdAt: timestamp }, "thread_attachments"),
        ...(Object.keys(reference).length ? { reference } : {}),
      },
    ];
  });
  const readReceipts: StateReadReceiptMetadata[] = selectedRows(
    "thread_read_receipts",
    {
      threadId: "thread_id",
      revision: "revision",
      firstUnreadTurn: "first_unread_turn",
      lastPublishedTurn: "last_published_turn",
    },
    ["thread_id", "revision"],
  ).flatMap((row) => {
    const parsed = z
      .object({
        threadId: text,
        revision: text,
        firstUnreadTurn: nullableText,
        lastPublishedTurn: nullableText,
      })
      .safeParse({ firstUnreadTurn: null, lastPublishedTurn: null, ...row });
    if (!parsed.success) {
      capabilities.diagnostics.push({ table: "thread_read_receipts", reason: "invalid-field" });
      return [];
    }
    return [parsed.data];
  });
  return { threads, sections, spawnEdges, projects, attachments, readReceipts, capabilities };
}
