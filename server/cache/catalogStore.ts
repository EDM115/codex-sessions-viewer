import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import {
  resolveConversationProject,
  type ResolvedConversationProject,
} from "../../shared/library/projectIdentity.ts";
import { buildSidebarGroups } from "../../shared/library/sidebarGroups.ts";
import {
  conversationSummarySchema,
  type ConversationSummary,
} from "../../shared/types/conversation.ts";
import {
  libraryEntrySchema,
  catalogSessionMetadataSchema,
  catalogProjectGroupFromLegacy,
  sidebarGroupKey,
  catalogLibrarySchema,
  conversationProjectSchema,
  materializationStateSchema,
  type LibraryEntry,
  type CatalogSessionMetadata,
  type CatalogProjectGroup,
  type CatalogLibrary,
  type ConversationProject,
  type MaterializationState,
  type ThreadClassification,
} from "../../shared/types/library.ts";
import type { CursorPage, SessionListQuery } from "../../shared/types/repository.ts";
import {
  CATALOG_EVIDENCE_VERSION,
  parseSessionMetaBytes,
  sessionMetaEvidenceSchema,
  type SessionMetaEvidence,
} from "../ingestion/sessionMetaPrefix.ts";
import {
  catalogVisibilitySql,
  cachedThreadClassification,
  classifyNormalizedSession,
  classificationKind,
  normalizedSessionMeta,
} from "../metadata/threadClassification.ts";
import { catalogMetadataRevision } from "../metadata/threadFields.ts";
import type { NormalizedSession } from "../normalization/normalizeSession.ts";
import { withCacheTransaction } from "./database.ts";
import { SEED_CATALOG_FROM_SESSIONS_SQL } from "./schema.ts";

export type CatalogSessionKind = "root" | "subagent" | "auxiliary";

export interface CatalogSessionInput {
  summary: CatalogSessionMetadata;
  kind: CatalogSessionKind;
  materialization: MaterializationState;
  project: ResolvedConversationProject;
  parentThreadId: string | null;
  agentPath: string | null;
  agentNickname: string | null;
  agentDepth: number | null;
  childCount: number;
  sourceSize: number;
  sourceMtimeMs: number;
  sourceDevice: string | null;
  sourceInode: string | null;
  sourceRevision: string;
  error: string | null;
  structuralEvidence?: SessionMetaEvidence | null;
}

export interface CatalogSessionRecord extends Omit<CatalogSessionInput, "summary" | "project"> {
  summary: CatalogSessionMetadata;
  project: ResolvedConversationProject;
}

const ROOT_PARENT_SENTINEL = "__root__";

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parsedJson(value: SQLOutputValue | undefined): unknown {
  if (typeof value !== "string") {
    throw new Error("The viewer catalog contains a non-text JSON value.");
  }
  return JSON.parse(value) as unknown;
}

function requiredText(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`The viewer catalog column ${key} is not text.`);
  }
  return value;
}

function nullableText(row: Record<string, SQLOutputValue>, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`The viewer catalog column ${key} is not nullable text.`);
  }
  return value;
}

function requiredNumber(row: Record<string, SQLOutputValue>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`The viewer catalog column ${key} is not numeric.`);
  }
  return value;
}

function nullableNumber(row: Record<string, SQLOutputValue>, key: string): number | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== "number") {
    throw new Error(`The viewer catalog column ${key} is not nullable numeric.`);
  }
  return value;
}

function catalogRecord(row: Record<string, SQLOutputValue>): CatalogSessionRecord {
  const kind = requiredText(row, "session_kind");
  if (kind !== "root" && kind !== "subagent" && kind !== "auxiliary") {
    throw new Error("The viewer catalog contains an invalid session kind.");
  }
  let rawEvidence: unknown = null;
  try {
    rawEvidence =
      row["structural_evidence_json"] === null ? null : parsedJson(row["structural_evidence_json"]);
  } catch {
    rawEvidence = "invalid";
  }
  const evidence = sessionMetaEvidenceSchema.safeParse(rawEvidence);
  const structuralEvidence: SessionMetaEvidence | null =
    rawEvidence === null
      ? null
      : evidence.success
        ? evidence.data
        : {
            version: CATALOG_EVIDENCE_VERSION,
            origin: "rollout-prefix" as const,
            status: "invalid" as const,
            parentThreadIdHint: null,
            meta: null,
            classification: cachedThreadClassification(rawEvidence, kind),
          };
  return {
    summary: catalogSessionMetadataSchema.parse(parsedJson(row["summary_json"])),
    kind,
    materialization: materializationStateSchema.parse(row["materialization_state"]),
    project: {
      id: requiredText(row, "project_id"),
      name: requiredText(row, "project_name"),
      source: conversationProjectSchema.shape.source.parse(row["project_source"]),
      hint: nullableText(row, "project_hint"),
    },
    parentThreadId: nullableText(row, "parent_thread_id"),
    agentPath: nullableText(row, "agent_path"),
    agentNickname: nullableText(row, "agent_nickname"),
    agentDepth: nullableNumber(row, "agent_depth"),
    childCount: requiredNumber(row, "child_count"),
    sourceSize: requiredNumber(row, "source_size"),
    sourceMtimeMs: requiredNumber(row, "source_mtime_ms"),
    sourceDevice: nullableText(row, "source_device"),
    sourceInode: nullableText(row, "source_inode"),
    sourceRevision: requiredText(row, "source_revision"),
    error: nullableText(row, "error"),
    structuralEvidence,
  };
}

const UPSERT_CATALOG_SQL = `
  INSERT INTO session_catalog (
    id, source_path, scope, project_id, project_name, project_source, project_hint,
    session_kind, materialization_state, title, created_at, updated_at, cwd,
    git_origin_url, parent_thread_id, agent_path, agent_nickname, agent_depth,
    child_count, source_size, source_mtime_ms, source_device, source_inode,
    source_revision, error, summary_json, structural_evidence_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    source_path = excluded.source_path,
    scope = excluded.scope,
    project_id = excluded.project_id,
    project_name = excluded.project_name,
    project_source = excluded.project_source,
    project_hint = excluded.project_hint,
    session_kind = excluded.session_kind,
    materialization_state = CASE
      WHEN session_catalog.source_revision = excluded.source_revision
        AND session_catalog.materialization_state IN ('ready', 'failed')
        AND excluded.materialization_state = 'cold'
      THEN session_catalog.materialization_state
      ELSE excluded.materialization_state
    END,
    title = excluded.title,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    cwd = excluded.cwd,
    git_origin_url = excluded.git_origin_url,
    parent_thread_id = excluded.parent_thread_id,
    agent_path = excluded.agent_path,
    agent_nickname = excluded.agent_nickname,
    agent_depth = excluded.agent_depth,
    child_count = excluded.child_count,
    source_size = excluded.source_size,
    source_mtime_ms = excluded.source_mtime_ms,
    source_device = excluded.source_device,
    source_inode = excluded.source_inode,
    source_revision = excluded.source_revision,
    error = CASE
      WHEN session_catalog.source_revision = excluded.source_revision
        AND session_catalog.materialization_state = 'failed'
        AND excluded.materialization_state = 'cold'
      THEN session_catalog.error
      ELSE excluded.error
    END,
    summary_json = excluded.summary_json,
    structural_evidence_json = excluded.structural_evidence_json
`;

function writeCatalogSession(
  statement: ReturnType<DatabaseSync["prepare"]>,
  input: CatalogSessionInput,
): void {
  const summary = catalogSessionMetadataSchema.parse(input.summary);
  const materialization = materializationStateSchema.parse(input.materialization);
  statement.run(
    summary.id,
    summary.sourcePath,
    summary.scope,
    input.project.id,
    input.project.name,
    input.project.source,
    input.project.hint,
    input.kind,
    materialization,
    summary.title,
    summary.createdAt,
    summary.updatedAt,
    summary.cwd,
    summary.gitOriginUrl,
    input.parentThreadId,
    input.agentPath,
    input.agentNickname,
    input.agentDepth,
    input.childCount,
    input.sourceSize,
    input.sourceMtimeMs,
    input.sourceDevice,
    input.sourceInode,
    input.sourceRevision,
    input.error,
    json(summary),
    input.structuralEvidence == null ? null : json(input.structuralEvidence),
  );
}

export function upsertCatalogSessions(
  database: DatabaseSync,
  inputs: readonly CatalogSessionInput[],
  existingRows?: readonly CatalogSessionRecord[],
): string[] {
  return withCacheTransaction(database, () => {
    const existingById = new Map(
      (existingRows ?? listAllCatalogSessions(database)).map((record) => [
        record.summary.id,
        record,
      ]),
    );
    const statement = database.prepare(UPSERT_CATALOG_SQL);
    const changedIds: string[] = [];
    for (const originalInput of inputs) {
      const input = {
        ...originalInput,
        structuralEvidence: originalInput.structuralEvidence ?? null,
      };
      const existing = existingById.get(input.summary.id);
      const effectiveInput =
        input.materialization === "cold" &&
        existing?.sourceRevision === input.sourceRevision &&
        (existing.materialization === "ready" || existing.materialization === "failed")
          ? {
              ...input,
              materialization: existing.materialization,
              error: existing.materialization === "failed" ? existing.error : input.error,
              summary: input.summary,
            }
          : input;
      if (existing !== undefined && isDeepStrictEqual(existing, effectiveInput)) {
        continue;
      }
      writeCatalogSession(statement, effectiveInput);
      changedIds.push(input.summary.id);
    }
    return changedIds.toSorted();
  });
}

export function listAllCatalogSessions(database: DatabaseSync): CatalogSessionRecord[] {
  return database.prepare("SELECT * FROM session_catalog ORDER BY id").all().map(catalogRecord);
}

export function writeCatalogLibrary(database: DatabaseSync, library: CatalogLibrary): boolean {
  const validated = catalogLibrarySchema.parse(library);
  database.exec(
    "CREATE TABLE IF NOT EXISTS catalog_sidebar (id INTEGER PRIMARY KEY CHECK (id = 1), payload_json TEXT NOT NULL) STRICT",
  );
  return (
    database
      .prepare(
        "INSERT INTO catalog_sidebar (id, payload_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json WHERE catalog_sidebar.payload_json <> excluded.payload_json",
      )
      .run(json(validated)).changes === 1
  );
}

export function readCatalogLibrary(database: DatabaseSync): CatalogLibrary | null {
  if (
    !database
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'catalog_sidebar'")
      .get()
  ) {
    return null;
  }
  const row = database.prepare("SELECT payload_json FROM catalog_sidebar WHERE id = 1").get();
  if (!row) {
    return null;
  }
  const library = catalogLibrarySchema.parse(parsedJson(row["payload_json"]));
  const current = new Map(
    database
      .prepare("SELECT id, structural_evidence_json, session_kind FROM session_catalog")
      .all()
      .map((currentRow) => [
        requiredText(currentRow, "id"),
        cachedThreadClassification(
          currentRow["structural_evidence_json"] === null
            ? null
            : parsedJson(currentRow["structural_evidence_json"]),
          requiredText(currentRow, "session_kind"),
        ),
      ]),
  );
  return {
    ...library,
    threads: library.threads.flatMap((thread) => {
      const classification = current.get(thread.id);
      return classification ? [{ ...thread, classification }] : [];
    }),
  };
}

export function seedCatalogFromNormalizedSessions(database: DatabaseSync): void {
  withCacheTransaction(database, () => database.exec(SEED_CATALOG_FROM_SESSIONS_SQL));
}

function queryOffset(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!/^\d+$/u.test(cursor)) {
    throw new Error("The viewer catalog cursor is invalid.");
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) {
    throw new Error("The viewer catalog cursor is invalid.");
  }
  return offset;
}

function likeValue(value: string): string {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function listConditions(query: SessionListQuery): { sql: string; values: Array<string | number> } {
  // Root filters choose trees. Explicit expansion reveals every direct ordinary child,
  // including children whose actual project, archive scope, model or tools differ.
  if (query.parentThreadId !== undefined && query.parentThreadId !== ROOT_PARENT_SENTINEL) {
    return {
      sql: `${catalogVisibilitySql("child", "c")} AND c.parent_thread_id = ?`,
      values: [query.parentThreadId],
    };
  }
  const conditions = ["c.scope = ?", catalogVisibilitySql("ordinary", "c")];
  const values: Array<string | number> = [query.scope];
  if (query.projectId !== undefined) {
    conditions.push("c.project_id = ?");
    values.push(query.projectId ?? "none");
  }
  if (query.parentThreadId === ROOT_PARENT_SENTINEL || query.parentThreadId === undefined) {
    conditions.push(catalogVisibilitySql("root", "c"), "c.parent_thread_id IS NULL");
  } else {
    conditions.push("c.session_kind = 'subagent'", "c.parent_thread_id = ?");
    values.push(query.parentThreadId);
  }
  if (query.query?.trim()) {
    conditions.push(
      "(lower(c.title) LIKE ? ESCAPE '\\' OR lower((SELECT s.preview FROM sessions s WHERE s.id = c.id)) LIKE ? ESCAPE '\\')",
    );
    const pattern = likeValue(query.query.trim().toLocaleLowerCase("en-US"));
    values.push(pattern, pattern);
  }
  if (query.model !== undefined) {
    conditions.push(
      "EXISTS (SELECT 1 FROM json_each((SELECT s.models_json FROM sessions s WHERE s.id = c.id)) WHERE value = ?)",
    );
    values.push(query.model);
  }
  if (query.cwd !== undefined) {
    conditions.push("c.cwd = ?");
    values.push(query.cwd);
  }
  if (query.tool !== undefined) {
    conditions.push(
      "EXISTS (SELECT 1 FROM json_each((SELECT s.tool_counts_json FROM sessions s WHERE s.id = c.id)) WHERE key = ? AND value > 0)",
    );
    values.push(query.tool);
  }
  if (query.hasMedia !== undefined) {
    conditions.push("(SELECT s.has_media FROM sessions s WHERE s.id = c.id) = ?");
    values.push(query.hasMedia ? 1 : 0);
  }
  return { sql: conditions.join(" AND "), values };
}

export function listCatalogSessions(
  database: DatabaseSync,
  query: SessionListQuery,
): CursorPage<LibraryEntry> {
  const offset = queryOffset(query.cursor);
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 200);
  const library = readCatalogLibrary(database);
  const expandingChild =
    query.parentThreadId !== undefined && query.parentThreadId !== ROOT_PARENT_SENTINEL;
  const group =
    library && query.groupId !== undefined && !expandingChild
      ? buildSidebarGroups(library, { ...library.preferences, scope: query.scope }).find(
          (candidate) => sidebarGroupKey(candidate) === query.groupId,
        )
      : null;
  const { projectId: _projectId, ...withoutMembership } = query;
  const conditions = listConditions(library ? withoutMembership : query);
  if (library && query.projectId !== undefined && !expandingChild) {
    conditions.sql += " AND c.id IN (SELECT value FROM json_each(?))";
    conditions.values.push(
      json(
        library.threads
          .filter((thread) => thread.projectId === query.projectId)
          .map((thread) => thread.id),
      ),
    );
  }
  if (!library && query.groupId !== undefined && query.projectId === undefined) {
    conditions.sql += " AND c.project_id = ?";
    conditions.values.push(decodeURIComponent(query.groupId.slice(query.groupId.indexOf(":") + 1)));
  }
  if (query.groupId !== undefined && library && !expandingChild) {
    conditions.sql += " AND c.id IN (SELECT value FROM json_each(?))";
    conditions.values.push(json(group?.threadIds ?? []));
  }
  const membershipGroup =
    library && query.projectId !== undefined && !expandingChild
      ? buildSidebarGroups(library, { ...library.preferences, scope: query.scope }).find(
          (candidate) =>
            query.projectId === null
              ? candidate.kind === "recents"
              : candidate.kind === "project" && candidate.projectId === query.projectId,
        )
      : undefined;
  const recencyIds = library?.threads
    .toSorted(
      (a, b) => (b.recencyAt ?? -Infinity) - (a.recencyAt ?? -Infinity) || a.id.localeCompare(b.id),
    )
    .map((thread) => thread.id);
  const orderedIds =
    group?.threadIds ??
    (membershipGroup
      ? [
          ...membershipGroup.threadIds,
          ...(recencyIds ?? []).filter((id) => !membershipGroup.threadIds.includes(id)),
        ]
      : recencyIds);
  const totalRow = database
    .prepare(`SELECT count(*) AS count FROM session_catalog c WHERE ${conditions.sql}`)
    .get(...conditions.values);
  const total = requiredNumber(totalRow ?? {}, "count");
  const rows = database
    .prepare(`
      SELECT c.*
      FROM session_catalog c
      WHERE ${conditions.sql}
      ORDER BY ${orderedIds ? "(SELECT key FROM json_each(?) WHERE value = c.id)," : ""} c.updated_at DESC, c.id
      LIMIT ? OFFSET ?
    `)
    .all(...conditions.values, ...(orderedIds ? [json(orderedIds)] : []), limit, offset);
  const items = rows.map((row) => {
    const record = catalogRecord(row);
    if (record.kind === "auxiliary") {
      throw new Error("An auxiliary session crossed the public catalog boundary.");
    }
    const metadata = library?.threads.find((thread) => thread.id === record.summary.id);
    return libraryEntrySchema.parse({
      id: record.summary.id,
      title: record.summary.title,
      scope: record.summary.scope,
      orderKey:
        metadata?.recencyAt == null
          ? (record.summary.updatedAt ?? "")
          : new Date(metadata.recencyAt).toISOString(),
      kind: record.kind,
      projectId: metadata
        ? metadata.projectId
        : record.project.id === "none"
          ? null
          : record.project.id,
      parentThreadId: record.parentThreadId,
      childCount: record.childCount,
    });
  });
  const nextOffset = offset + items.length;
  return { items, nextCursor: nextOffset < total ? String(nextOffset) : null, total };
}

export function listCatalogProjects(database: DatabaseSync): ConversationProject[] {
  const library = readCatalogLibrary(database);
  if (library) {
    const active = buildSidebarGroups(library, { ...library.preferences, scope: "active" });
    const archived = buildSidebarGroups(library, { ...library.preferences, scope: "archived" });
    const groups = [
      ...active.filter((group) => group.kind !== "recents"),
      ...archived.filter(
        (group) => group.kind !== "recents" && !active.some((other) => other.id === group.id),
      ),
      ...active.filter((group) => group.kind === "recents"),
    ];
    return groups.map((group) => {
      const project = library.projects.find((candidate) => candidate.id === group.projectId);
      const count = (scope: "active" | "archived", ids: string[]) => {
        const result = database
          .prepare(
            `SELECT count(*) AS count FROM session_catalog WHERE scope = ? AND ${catalogVisibilitySql("root")} AND id IN (SELECT value FROM json_each(?))`,
          )
          .get(scope, json(ids));
        return requiredNumber(result ?? {}, "count");
      };
      return conversationProjectSchema.parse({
        id: group.id,
        name: group.name,
        source: group.kind === "project" ? "codex" : "none",
        hint: project?.rootPaths[0] ?? null,
        activeCount: count(
          "active",
          active.find((other) => other.id === group.id)?.threadIds ?? [],
        ),
        archivedCount: count(
          "archived",
          archived.find((other) => other.id === group.id)?.threadIds ?? [],
        ),
        sidebar: {
          order: {
            active: active.findIndex((candidate) => candidate.id === group.id),
            archived: archived.findIndex((candidate) => candidate.id === group.id),
          },
          kind: group.kind,
          sectionId: group.sectionId,
          sectionName: group.sectionId
            ? (library.sections.find((section) => section.id === group.sectionId)?.name ?? null)
            : null,
        },
      });
    });
  }
  return database
    .prepare(`
      SELECT
        project_id,
        project_name,
        project_source,
        project_hint,
        sum(CASE WHEN scope = 'active' THEN 1 ELSE 0 END) AS active_count,
        sum(CASE WHEN scope = 'archived' THEN 1 ELSE 0 END) AS archived_count
      FROM session_catalog
      WHERE ${catalogVisibilitySql("root")}
      GROUP BY project_id, project_name, project_source, project_hint
      ORDER BY project_name COLLATE NOCASE, project_id
    `)
    .all()
    .map((row) =>
      conversationProjectSchema.parse({
        id: requiredText(row, "project_id"),
        name: requiredText(row, "project_name"),
        source: requiredText(row, "project_source"),
        hint: nullableText(row, "project_hint"),
        activeCount: requiredNumber(row, "active_count"),
        archivedCount: requiredNumber(row, "archived_count"),
      }),
    );
}

export function listCatalogProjectGroups(database: DatabaseSync): CatalogProjectGroup[] {
  const library = readCatalogLibrary(database);
  if (!library) {
    return listCatalogProjects(database).map(catalogProjectGroupFromLegacy);
  }
  const active = buildSidebarGroups(library, { ...library.preferences, scope: "active" });
  const archived = buildSidebarGroups(library, { ...library.preferences, scope: "archived" });
  const groups = [
    ...active,
    ...archived.filter(
      (group) => !active.some((other) => sidebarGroupKey(other) === sidebarGroupKey(group)),
    ),
  ];
  return groups.map((group) => {
    const groupId = sidebarGroupKey(group);
    const project =
      group.kind === "project"
        ? library.projects.find((candidate) => candidate.id === group.projectId)
        : undefined;
    return {
      id: group.id,
      name: group.name,
      rootPaths: project?.rootPaths ?? [],
      hostId: project?.hostId ?? null,
      source: project?.source ?? "legacy",
      position: project?.position ?? null,
      recencyAt: project?.recencyAt ?? null,
      groupId,
      activeCount:
        active.find((candidate) => sidebarGroupKey(candidate) === groupId)?.threadIds.length ?? 0,
      archivedCount:
        archived.find((candidate) => sidebarGroupKey(candidate) === groupId)?.threadIds.length ?? 0,
      sidebar: {
        order: {
          active: active.findIndex((candidate) => sidebarGroupKey(candidate) === groupId),
          archived: archived.findIndex((candidate) => sidebarGroupKey(candidate) === groupId),
        },
        kind: group.kind,
        sectionId: group.sectionId,
        sectionName: group.sectionId
          ? (library.sections.find((section) => section.id === group.sectionId)?.name ?? null)
          : null,
      },
    };
  });
}

export function listCatalogAuxiliaryChildren(
  database: DatabaseSync,
  parentThreadId: string,
): CatalogSessionRecord[] {
  return database
    .prepare(
      "SELECT * FROM session_catalog WHERE session_kind = 'auxiliary' AND parent_thread_id = ? ORDER BY updated_at, id",
    )
    .all(parentThreadId)
    .map(catalogRecord);
}

export function listCatalogChildren(
  database: DatabaseSync,
  parentThreadId: string,
): CatalogSessionRecord[] {
  return database
    .prepare(
      `SELECT * FROM session_catalog WHERE ${catalogVisibilitySql("child")} AND parent_thread_id = ? ORDER BY updated_at DESC, id`,
    )
    .all(parentThreadId)
    .map(catalogRecord);
}

export function catalogSession(database: DatabaseSync, id: string): CatalogSessionRecord | null {
  const row = database.prepare("SELECT * FROM session_catalog WHERE id = ?").get(id);
  return row === undefined ? null : catalogRecord(row);
}

export function storeMaterializedClassification(
  database: DatabaseSync,
  session: NormalizedSession,
): void {
  const existing = catalogSession(database, session.summary.id);
  if (existing === null || existing.structuralEvidence?.classification !== undefined) {
    return;
  }
  const classification = classifyNormalizedSession(session);
  const meta = parseSessionMetaBytes(
    session.summary.sourcePath,
    Buffer.from(
      `${JSON.stringify({ type: "session_meta", payload: normalizedSessionMeta(session) })}\n`,
    ),
  ).meta;
  const parentThreadId =
    classification.relationship === "spawn" || classification.visibility === "internal"
      ? classification.parentThreadId
      : null;
  const evidence: SessionMetaEvidence = {
    version: CATALOG_EVIDENCE_VERSION,
    origin: "materialized",
    status: meta === null ? "missing" : "found",
    parentThreadIdHint: classification.parentThreadId,
    meta,
    classification,
  };
  const summary = { ...existing.summary, parentThreadId };
  database
    .prepare(
      "UPDATE session_catalog SET session_kind = ?, parent_thread_id = ?, structural_evidence_json = ?, summary_json = ? WHERE id = ?",
    )
    .run(
      classificationKind(classification),
      parentThreadId,
      json(evidence),
      json(catalogSessionMetadataSchema.parse(summary)),
      summary.id,
    );
}

export function storeValidatedCatalogClassification(
  database: DatabaseSync,
  id: string,
  evidence: SessionMetaEvidence & { classification: ThreadClassification; validatedSha256: string },
  expected: CatalogReadyFence,
): string[] {
  return withCacheTransaction(database, () => {
    const existing = catalogSession(database, id);
    const source = database
      .prepare("SELECT sha256 FROM source_files WHERE path = ? AND session_id = ?")
      .get(expected.sourcePath, id);
    if (
      !existing ||
      existing.sourceRevision !== expected.sourceRevision ||
      existing.summary.sourcePath !== expected.sourcePath ||
      source?.["sha256"] !== evidence.validatedSha256
    ) {
      return [];
    }
    const classification = {
      ...evidence.classification,
      reasons: [...evidence.classification.reasons],
    };
    let parentThreadId =
      classification.relationship === "spawn" || classification.visibility === "internal"
        ? classification.parentThreadId
        : null;
    const seen = new Set([id]);
    let ancestor = parentThreadId;
    while (ancestor !== null) {
      if (seen.has(ancestor)) {
        classification.visibility = "unresolved";
        classification.reasons.push("parent-cycle");
        parentThreadId = null;
        break;
      }
      seen.add(ancestor);
      ancestor = catalogSession(database, ancestor)?.parentThreadId ?? null;
    }
    const validated = sessionMetaEvidenceSchema.parse({ ...evidence, classification });
    const kind = classificationKind(classification);
    const changed = new Set<string>();
    if (existing.kind !== kind || existing.parentThreadId !== parentThreadId) {
      changed.add(id);
    }
    if (
      !isDeepStrictEqual(existing.structuralEvidence, validated) ||
      existing.parentThreadId !== parentThreadId
    ) {
      const summary = { ...existing.summary, parentThreadId };
      summary.metadataRevision = catalogMetadataRevision(summary);
      database
        .prepare(
          "UPDATE session_catalog SET session_kind = ?, parent_thread_id = ?, agent_path = ?, agent_nickname = ?, agent_depth = ?, structural_evidence_json = ?, summary_json = ? WHERE id = ?",
        )
        .run(
          kind,
          parentThreadId,
          classification.agentPath,
          classification.agentNickname,
          classification.agentDepth,
          json(validated),
          json(summary),
          id,
        );
    }
    for (const parent of new Set([existing.parentThreadId, parentThreadId])) {
      if (parent === null) {
        continue;
      }
      const record = catalogSession(database, parent);
      if (!record) {
        continue;
      }
      const children = listCatalogChildren(database, parent)
        .map((child) => child.summary.id)
        .toSorted();
      if (!isDeepStrictEqual(record.summary.childThreadIds, children)) {
        const summary = { ...record.summary, childThreadIds: children };
        summary.metadataRevision = catalogMetadataRevision(summary);
        database
          .prepare("UPDATE session_catalog SET child_count = ?, summary_json = ? WHERE id = ?")
          .run(children.length, json(summary), parent);
        changed.add(parent);
      }
    }
    return [...changed];
  });
}

export function setCatalogMaterialization(
  database: DatabaseSync,
  id: string,
  state: MaterializationState,
  error: string | null,
): void {
  const validated = materializationStateSchema.parse(state);
  const result = database
    .prepare("UPDATE session_catalog SET materialization_state = ?, error = ? WHERE id = ?")
    .run(validated, error, id);
  if (result.changes !== 1) {
    throw new Error(`Cannot update missing catalog session ${id}.`);
  }
}

export function removeCatalogSource(database: DatabaseSync, sourcePath: string): string | null {
  return withCacheTransaction(database, () => {
    const row = database
      .prepare("SELECT id FROM session_catalog WHERE source_path = ?")
      .get(sourcePath);
    if (row === undefined) {
      return null;
    }
    const id = requiredText(row, "id");
    database.prepare("DELETE FROM session_catalog WHERE id = ?").run(id);
    return id;
  });
}

export function catalogMaterializedSessionIds(database: DatabaseSync): string[] {
  return database
    .prepare(`
      SELECT id
      FROM session_catalog
      WHERE materialization_state = 'ready' AND ${catalogVisibilitySql("ordinary")}
      ORDER BY id
    `)
    .all()
    .map((row) => requiredText(row, "id"));
}

export interface CatalogReadyFence {
  sourceRevision: string;
  sourcePath: string;
}

export function markCatalogSessionReady(
  database: DatabaseSync,
  summaryInput: ConversationSummary,
  expected?: CatalogReadyFence,
): boolean {
  let summary = conversationSummarySchema.parse(summaryInput);
  const existing = catalogSession(database, summary.id);
  if (
    existing?.kind === "auxiliary" &&
    existing.structuralEvidence?.classification?.visibility !== "unresolved"
  ) {
    return false;
  }
  if (existing !== null) {
    if (
      expected !== undefined &&
      (existing.sourceRevision !== expected.sourceRevision ||
        existing.summary.sourcePath !== expected.sourcePath)
    ) {
      return false;
    }
    // Full parsing may recover a declaration whose first record exceeded the startup cap.
    // Never replace a successfully parsed rollout declaration with optional normalization data.
    const recoveredParent =
      existing.structuralEvidence?.status !== "found" && summary.parentThreadId !== null
        ? catalogSession(database, summary.parentThreadId)
        : null;
    if (existing.structuralEvidence?.status !== "found" && summary.parentThreadId !== null) {
      existing.structuralEvidence = {
        version: CATALOG_EVIDENCE_VERSION,
        origin: "materialized",
        status: "found",
        parentThreadIdHint: summary.parentThreadId,
        meta: {
          id: summary.id,
          parentThreadId: summary.parentThreadId,
          timestamp: summary.createdAt,
          cwd: summary.cwd,
          source: null,
          modelProvider: null,
          git: {
            branch: summary.gitBranch,
            commitHash: summary.gitSha,
            repositoryUrl: summary.gitOriginUrl,
          },
        },
      };
    }
    const recovered =
      recoveredParent !== null &&
      recoveredParent.kind !== "auxiliary" &&
      recoveredParent.summary.id !== summary.id;
    if (recovered) {
      // Reject an edge back into the child's own ancestry before changing the effective graph.
      const visited = new Set([summary.id]);
      let ancestor: CatalogSessionRecord | null = recoveredParent;
      while (ancestor !== null && !visited.has(ancestor.summary.id)) {
        visited.add(ancestor.summary.id);
        ancestor =
          ancestor.parentThreadId === null
            ? null
            : catalogSession(database, ancestor.parentThreadId);
      }
      if (ancestor === null) {
        existing.kind = "subagent";
        existing.parentThreadId = recoveredParent.summary.id;
        existing.agentDepth = (recoveredParent.agentDepth ?? 0) + 1;
      }
    }
    summary = {
      ...summary,
      title: existing.summary.title,
      createdAt: existing.summary.createdAt ?? summary.createdAt,
      updatedAt:
        existing.summary.fieldSources?.updatedAt?.startsWith("native.") ||
        existing.summary.fieldSources?.updatedAt === "session-index.updatedAt"
          ? (existing.summary.updatedAt ?? summary.updatedAt)
          : summary.updatedAt,
      scope: existing.summary.scope,
      pinned: existing.summary.pinned,
      sectionName: existing.summary.sectionName,
      parentThreadId: existing.parentThreadId,
      childThreadIds: existing.summary.childThreadIds,
    };
    const catalogMetadata = catalogSessionMetadataSchema.parse({ ...existing.summary, ...summary });
    const authoritative = (source: string | null | undefined) =>
      source?.startsWith("native.") || source?.startsWith("session-index.");
    if (!authoritative(existing.summary.fieldSources?.updatedAt) && catalogMetadata.fieldSources) {
      catalogMetadata.fieldSources.updatedAt = "rollout.events";
    }
    if (!authoritative(existing.summary.fieldSources?.recencyAt)) {
      catalogMetadata.recencyAt = summary.updatedAt;
      if (catalogMetadata.fieldSources) {
        catalogMetadata.fieldSources.recencyAt = "rollout.events";
      }
    }
    catalogMetadata.metadataRevision = catalogMetadataRevision(catalogMetadata);
    const values = [
      summary.title,
      summary.createdAt,
      summary.updatedAt,
      summary.cwd,
      summary.gitOriginUrl,
      summary.parentThreadId,
      summary.childThreadIds.length,
      json(catalogMetadata),
      summary.id,
    ];
    const result =
      expected === undefined
        ? database
            .prepare(`
              UPDATE session_catalog
              SET materialization_state = 'ready', error = NULL, title = ?, created_at = ?,
                updated_at = ?, cwd = ?, git_origin_url = ?, parent_thread_id = ?,
                child_count = ?, summary_json = ?
              WHERE id = ?
            `)
            .run(...values)
        : database
            .prepare(`
              UPDATE session_catalog
              SET materialization_state = 'ready', error = NULL, title = ?, created_at = ?,
                updated_at = ?, cwd = ?, git_origin_url = ?, parent_thread_id = ?,
                child_count = ?, summary_json = ?
              WHERE id = ? AND source_revision = ? AND source_path = ?
                AND (session_kind <> 'auxiliary' OR json_extract(structural_evidence_json, '$.classification.visibility') = 'unresolved')
            `)
            .run(...values, expected.sourceRevision, expected.sourcePath);
    if (result.changes === 1 && existing.structuralEvidence?.origin === "materialized") {
      database
        .prepare(
          "UPDATE session_catalog SET session_kind = ?, agent_depth = ?, structural_evidence_json = ? WHERE id = ?",
        )
        .run(existing.kind, existing.agentDepth, json(existing.structuralEvidence), summary.id);
      if (recoveredParent !== null && existing.parentThreadId === recoveredParent.summary.id) {
        const childIds = listCatalogChildren(database, recoveredParent.summary.id)
          .map(({ summary: child }) => child.id)
          .toSorted();
        const parentSummary = { ...recoveredParent.summary, childThreadIds: childIds };
        database
          .prepare("UPDATE session_catalog SET child_count = ?, summary_json = ? WHERE id = ?")
          .run(childIds.length, json(parentSummary), recoveredParent.summary.id);
      }
    }
    return result.changes === 1;
  }
  if (expected !== undefined) {
    return false;
  }

  const parent =
    summary.parentThreadId === null ? null : catalogSession(database, summary.parentThreadId);
  const effectiveParent = summary.parentThreadId;
  const children = listCatalogChildren(database, summary.id).map(({ summary: child }) => child.id);
  summary = {
    ...summary,
    parentThreadId: effectiveParent,
    childThreadIds: children,
  };
  const source = database
    .prepare("SELECT size, mtime_ms, device, inode FROM source_files WHERE path = ?")
    .get(summary.sourcePath);
  if (source === undefined) {
    throw new Error(`Cannot mark uncataloged session ${summary.id} ready without its source.`);
  }
  const project = resolveConversationProject(
    { cwd: summary.cwd, gitOriginUrl: summary.gitOriginUrl },
    [],
  );
  const statement = database.prepare(UPSERT_CATALOG_SQL);
  writeCatalogSession(statement, {
    summary,
    kind: summary.parentThreadId === null ? "root" : "subagent",
    materialization: "ready",
    project,
    parentThreadId: summary.parentThreadId,
    agentPath: null,
    agentNickname: null,
    agentDepth: effectiveParent === null ? null : (parent?.agentDepth ?? 0) + 1,
    childCount: children.length,
    sourceSize: requiredNumber(source, "size"),
    sourceMtimeMs: requiredNumber(source, "mtime_ms"),
    sourceDevice: nullableText(source, "device"),
    sourceInode: nullableText(source, "inode"),
    sourceRevision: summary.revision,
    error: null,
  });
  return true;
}
