import { basename, extname, resolve } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

import { resolveConversationProject } from "../../shared/library/projectIdentity.ts";
import type { ConversationSummary, JsonValue } from "../../shared/types/conversation.ts";
import { createViewerDiagnostic, type ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import type { ConversationProject } from "../../shared/types/library.ts";
import {
  listCatalogProjects,
  listAllCatalogSessions,
  removeCatalogSource,
  upsertCatalogSessions,
  type CatalogSessionInput,
  type CatalogSessionKind,
} from "../cache/catalogStore.ts";
import { removeCachedSource } from "../cache/conversationStore.ts";
import {
  CACHE_PARSER_VERSION,
  refreshUnchangedSourceManifest,
  type StableJsonlReader,
} from "../cache/sourceManifest.ts";
import type { SourceDiscoveryResult } from "../ingestion/discoverSources.ts";
import { selectSessionSources } from "../ingestion/selectSessionSources.ts";
import {
  observeSessionMetaSource,
  readSessionMetaPrefix,
  type SessionMetaPrefix,
  type SessionMetaPrefixObservation,
  type SessionMetaPrefixResult,
} from "../ingestion/sessionMetaPrefix.ts";
import type { GlobalStateMetadata } from "../metadata/globalState.ts";
import type { SessionIndexEntry } from "../metadata/sessionIndex.ts";
import type { StateMetadataSnapshot, StateThreadMetadata } from "../metadata/stateSnapshot.ts";

export interface SessionMetaClassification {
  kind: CatalogSessionKind;
  parentThreadId: string | null;
  agentPath: string | null;
  agentNickname: string | null;
  agentDepth: number | null;
}

export interface RefreshLiveCatalogOptions {
  database: DatabaseSync;
  discovery: SourceDiscoveryResult;
  sessionIndexEntries: readonly SessionIndexEntry[];
  globalState: GlobalStateMetadata;
  stateSnapshot: StateMetadataSnapshot | null;
  prefixBytes?: number | undefined;
  readPrefix?: typeof readSessionMetaPrefix | undefined;
  readJsonl?: StableJsonlReader | undefined;
  observeSource?: ((path: string) => Promise<SessionMetaPrefixObservation>) | undefined;
}

export interface CatalogRefreshResult {
  rows: CatalogSessionInput[];
  changedIds: string[];
  projects: ConversationProject[];
  removedIds: string[];
  diagnostics: ViewerDiagnostic[];
  bytesRead: number;
}

interface DraftCatalogRow {
  input: CatalogSessionInput;
  prefix: SessionMetaPrefixResult;
}

const SOURCE_OBSERVATION_CONCURRENCY = 32;
const CATALOG_REVISION_PREFIX = `catalog:${CACHE_PARSER_VERSION}:`;

function sourcePathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function matchingCatalogObservation(
  existing: CatalogSessionInput,
  observed: SessionMetaPrefixObservation,
): boolean {
  return (
    existing.sourceDevice === observed.device.toString() &&
    existing.sourceInode === observed.inode.toString() &&
    existing.sourceSize === Number(observed.size) &&
    existing.sourceMtimeMs === Number(observed.mtimeNs) / 1_000_000 &&
    observed.regular &&
    !observed.symbolicLink
  );
}

function cachedSessionSource(
  existing: CatalogSessionInput,
  observation: SessionMetaPrefixObservation,
): SessionMetaPrefixResult {
  let subagentSource: JsonValue = null;
  if (existing.kind === "auxiliary") {
    subagentSource = {
      subagent: { other: "guardian", parent_thread_id: existing.parentThreadId },
    };
  } else if (existing.kind === "subagent") {
    subagentSource = {
      subagent: {
        thread_spawn: {
          parent_thread_id: existing.parentThreadId,
          agent_path: existing.agentPath,
          agent_nickname: existing.agentNickname,
          depth: existing.agentDepth,
        },
      },
    };
  }
  return {
    status: "found",
    meta: {
      id: existing.summary.id,
      parentThreadId: existing.parentThreadId,
      timestamp: existing.summary.createdAt,
      cwd: existing.summary.cwd,
      source: subagentSource,
      modelProvider: null,
      git: {
        branch: existing.summary.gitBranch,
        commitHash: existing.summary.gitSha,
        repositoryUrl: existing.summary.gitOriginUrl,
      },
    },
    parentThreadIdHint: existing.parentThreadId,
    bytesRead: 0,
    observation,
    diagnostics: [],
  };
}

async function reusablePrefixes(options: RefreshLiveCatalogOptions): Promise<{
  prefixes: Map<string, SessionMetaPrefixResult>;
  rows: Map<string, CatalogSessionInput>;
}> {
  const existingByPath = new Map(
    listAllCatalogSessions(options.database).map((record) => [
      sourcePathKey(record.summary.sourcePath),
      record,
    ]),
  );
  const reusable = new Map<string, SessionMetaPrefixResult>();
  const reusableRows = new Map<string, CatalogSessionInput>();
  const observeSource = options.observeSource ?? observeSessionMetaSource;
  for (
    let index = 0;
    index < options.discovery.rollouts.length;
    index += SOURCE_OBSERVATION_CONCURRENCY
  ) {
    const sources = options.discovery.rollouts.slice(index, index + SOURCE_OBSERVATION_CONCURRENCY);
    // oxlint-disable-next-line no-await-in-loop -- Bounded batches cap cheap source observations at the prefix-read concurrency limit.
    const observations = await Promise.all(
      sources.map(async (source) => {
        const existing = existingByPath.get(sourcePathKey(source.path));
        if (existing === undefined) {
          return null;
        }
        try {
          const observation = await observeSource(source.path);
          const unchanged =
            matchingCatalogObservation(existing, observation) ||
            (await refreshUnchangedSourceManifest(
              options.database,
              source.path,
              existing.summary.id,
            ));
          return unchanged
            ? { path: source.path, prefix: cachedSessionSource(existing, observation), existing }
            : null;
        } catch {
          return null;
        }
      }),
    );
    for (const entry of observations) {
      if (entry !== null) {
        reusable.set(sourcePathKey(entry.path), entry.prefix);
        reusableRows.set(sourcePathKey(entry.path), entry.existing);
      }
    }
  }
  return { prefixes: reusable, rows: reusableRows };
}

function asRecord(value: JsonValue | null | undefined): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringProperty(record: Record<string, JsonValue> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberProperty(record: Record<string, JsonValue> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function classifySessionMeta(
  meta: SessionMetaPrefix | null,
  threadModel: string | null | undefined = null,
  parentThreadIdHint: string | null = null,
): SessionMetaClassification {
  const source = asRecord(meta?.source);
  const subagent = asRecord(source?.["subagent"]);
  if (stringProperty(subagent, "other") === "guardian" || threadModel === "codex-auto-review") {
    return {
      kind: "auxiliary",
      parentThreadId:
        meta?.parentThreadId ?? stringProperty(subagent, "parent_thread_id") ?? parentThreadIdHint,
      agentPath: null,
      agentNickname: null,
      agentDepth: null,
    };
  }
  const spawn = asRecord(subagent?.["thread_spawn"]);
  if (spawn !== null) {
    return {
      kind: "subagent",
      parentThreadId: stringProperty(spawn, "parent_thread_id"),
      agentPath: stringProperty(spawn, "agent_path"),
      agentNickname: stringProperty(spawn, "agent_nickname"),
      agentDepth: numberProperty(spawn, "depth"),
    };
  }
  return {
    kind: "root",
    parentThreadId: null,
    agentPath: null,
    agentNickname: null,
    agentDepth: null,
  };
}

function fallbackSessionId(path: string): string {
  const name = basename(path, extname(path));
  const uuid = name.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  )?.[0];
  return uuid ?? name;
}

function stateTimestamp(value: number | undefined, fallbackMs: number): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return new Date(fallbackMs).toISOString();
  }
  return new Date(value < 1_000_000_000_000 ? value * 1_000 : value).toISOString();
}

function sourceRevision(prefix: SessionMetaPrefixResult): string {
  const observation = prefix.observation;
  return [
    "catalog",
    CACHE_PARSER_VERSION,
    observation.device,
    observation.inode,
    observation.size,
    observation.mtimeNs / BigInt(1_000_000),
  ].join(":");
}

function reusableSourceRevision(
  existing: CatalogSessionInput | undefined,
  prefix: SessionMetaPrefixResult,
): string {
  return existing?.sourceRevision.startsWith(CATALOG_REVISION_PREFIX) === true
    ? existing.sourceRevision
    : sourceRevision(prefix);
}

function sectionName(
  thread: StateThreadMetadata | undefined,
  sections: ReadonlyMap<string, string>,
): string | null {
  return thread?.sectionId === null || thread?.sectionId === undefined
    ? null
    : (sections.get(thread.sectionId) ?? null);
}

function coldSummary(options: {
  id: string;
  source: SourceDiscoveryResult["rollouts"][number];
  prefix: SessionMetaPrefixResult;
  sessionIndex: SessionIndexEntry | undefined;
  thread: StateThreadMetadata | undefined;
  pinned: boolean;
  section: string | null;
  parentThreadId: string | null;
  childThreadIds: string[];
  existingSummary?: ConversationSummary | undefined;
}): ConversationSummary {
  const { id, source, prefix, sessionIndex, thread } = options;
  const mtimeMs = Number(prefix.observation.mtimeNs) / 1_000_000;
  const createdAt =
    prefix.meta?.timestamp ??
    stateTimestamp(thread?.createdAt, Number.isFinite(mtimeMs) ? mtimeMs : 0);
  const updatedAt =
    sessionIndex?.updatedAt ??
    (thread?.updatedAt === undefined
      ? options.existingSummary?.updatedAt
      : stateTimestamp(thread.updatedAt, Number.isFinite(mtimeMs) ? mtimeMs : 0)) ??
    stateTimestamp(undefined, Number.isFinite(mtimeMs) ? mtimeMs : 0);
  const title =
    sessionIndex?.threadName?.trim() ||
    thread?.name?.trim() ||
    thread?.title.trim() ||
    thread?.firstUserMessage.trim() ||
    options.existingSummary?.title ||
    fallbackSessionId(source.path);
  const preview = thread?.firstUserMessage.trim() || options.existingSummary?.preview || title;
  const cwd = prefix.meta?.cwd ?? thread?.cwd ?? null;
  return {
    id,
    title,
    scope: source.scope,
    sourcePath: source.path,
    createdAt,
    updatedAt,
    cwd,
    gitBranch: prefix.meta?.git?.branch ?? thread?.gitBranch ?? null,
    gitSha: prefix.meta?.git?.commitHash ?? thread?.gitSha ?? null,
    gitOriginUrl: prefix.meta?.git?.repositoryUrl ?? thread?.gitOriginUrl ?? null,
    models: thread?.model ? [thread.model] : [],
    reasoningEfforts: thread?.reasoningEffort ? [thread.reasoningEffort] : [],
    turnCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    toolCounts: {},
    preview,
    pinned: options.pinned,
    sectionName: options.section,
    parentThreadId: options.parentThreadId,
    childThreadIds: options.childThreadIds,
    hasMedia: false,
    diagnosticCount: 0,
    revision: sourceRevision(prefix),
  };
}

function cycleDiagnostic(ids: readonly string[]): ViewerDiagnostic {
  return createViewerDiagnostic({
    code: "metadata.snapshot_invalid",
    severity: "warning",
    area: "metadata",
    message: "A subagent parent cycle was rejected while building the conversation catalog.",
    details: { threadIds: [...ids] },
  });
}

function cyclicIds(parentById: ReadonlyMap<string, string | null>): Set<string> {
  const cyclic = new Set<string>();
  for (const start of parentById.keys()) {
    const chain: string[] = [];
    const indexes = new Map<string, number>();
    let current: string | null | undefined = start;
    while (current !== null && current !== undefined && parentById.has(current)) {
      const previousIndex = indexes.get(current);
      if (previousIndex !== undefined) {
        for (const id of chain.slice(previousIndex)) {
          cyclic.add(id);
        }
        break;
      }
      indexes.set(current, chain.length);
      chain.push(current);
      current = parentById.get(current);
    }
  }
  return cyclic;
}

function applyTopology(
  drafts: DraftCatalogRow[],
  stateSnapshot: StateMetadataSnapshot | null,
  diagnostics: ViewerDiagnostic[],
): void {
  const byId = new Map(drafts.map((draft) => [draft.input.summary.id, draft]));
  for (const edge of stateSnapshot?.spawnEdges ?? []) {
    const child = byId.get(edge.childThreadId);
    if (child === undefined) {
      continue;
    }
    if (child.input.parentThreadId === null) {
      child.input.parentThreadId = edge.parentThreadId;
      if (child.input.kind !== "auxiliary") {
        child.input.kind = "subagent";
      }
    }
  }
  for (const { input } of drafts) {
    if (
      input.kind !== "auxiliary" &&
      input.parentThreadId !== null &&
      !byId.has(input.parentThreadId)
    ) {
      input.kind = "root";
      input.parentThreadId = null;
      input.agentDepth = null;
    }
  }
  const parents = new Map(drafts.map(({ input }) => [input.summary.id, input.parentThreadId]));
  const cycles = cyclicIds(parents);
  if (cycles.size > 0) {
    diagnostics.push(cycleDiagnostic([...cycles].toSorted()));
    for (const id of cycles) {
      const row = byId.get(id);
      if (row === undefined) {
        continue;
      }
      row.input.parentThreadId = null;
      row.input.agentDepth = null;
      if (row.input.kind !== "auxiliary") {
        row.input.kind = "root";
      }
    }
  }
  const childIds = new Map<string, string[]>();
  for (const { input } of drafts) {
    if (input.kind !== "subagent" || input.parentThreadId === null) {
      continue;
    }
    const children = childIds.get(input.parentThreadId) ?? [];
    children.push(input.summary.id);
    childIds.set(input.parentThreadId, children);
  }
  const depth = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) {
      return 1;
    }
    seen.add(id);
    const row = byId.get(id);
    if (row?.input.parentThreadId === null || row === undefined) {
      return 0;
    }
    return depth(row.input.parentThreadId, seen) + 1;
  };
  for (const { input } of drafts) {
    const children = (childIds.get(input.summary.id) ?? []).toSorted();
    input.childCount = children.length;
    if (input.kind === "subagent" && input.agentDepth === null) {
      input.agentDepth = depth(input.summary.id);
    }
    input.summary = {
      ...input.summary,
      parentThreadId: input.parentThreadId,
      childThreadIds: children,
    };
  }
}

function requiredText(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`The viewer catalog column ${key} is not text.`);
  }
  return value;
}

export async function refreshLiveCatalog(
  options: RefreshLiveCatalogOptions,
): Promise<CatalogRefreshResult> {
  const reusable = await reusablePrefixes(options);
  const readPrefix = options.readPrefix ?? readSessionMetaPrefix;
  const sourceSelection = await selectSessionSources(options.discovery.rollouts, {
    prefixBytes: options.prefixBytes,
    readPrefix: (path, maxBytes) =>
      Promise.resolve(reusable.prefixes.get(sourcePathKey(path)) ?? readPrefix(path, maxBytes)),
    readJsonl: options.readJsonl,
  });
  const diagnostics = [...options.discovery.diagnostics, ...sourceSelection.diagnostics];
  const prefixes = sourceSelection.selected;
  const sessionIndex = new Map(options.sessionIndexEntries.map((entry) => [entry.id, entry]));
  const threads = new Map(
    (options.stateSnapshot?.threads ?? []).map((thread) => [thread.id, thread]),
  );
  const sections = new Map(
    (options.stateSnapshot?.sections ?? []).map((section) => [section.id, section.name]),
  );
  const pinned = new Set(options.globalState.pinnedThreadIds);
  const drafts: DraftCatalogRow[] = [];

  for (const { source, prefix } of prefixes) {
    if (prefix.status === "changed") {
      continue;
    }
    const id = prefix.meta?.id ?? fallbackSessionId(source.path);
    const thread = threads.get(id);
    const existing = reusable.rows.get(sourcePathKey(source.path));
    const classification = classifySessionMeta(
      prefix.meta,
      thread?.model,
      prefix.parentThreadIdHint,
    );
    const summary = coldSummary({
      id,
      source,
      prefix,
      sessionIndex: sessionIndex.get(id),
      thread,
      pinned: pinned.has(id) || thread?.pinned === true,
      section: sectionName(thread, sections),
      parentThreadId: classification.parentThreadId,
      childThreadIds: [],
      existingSummary: existing?.summary,
    });
    const project = resolveConversationProject(
      { cwd: summary.cwd, gitOriginUrl: summary.gitOriginUrl },
      options.globalState.projects,
    );
    drafts.push({
      prefix,
      input: {
        summary,
        kind: classification.kind,
        materialization: "cold",
        project,
        parentThreadId: classification.parentThreadId,
        agentPath: classification.agentPath,
        agentNickname: classification.agentNickname,
        agentDepth: classification.agentDepth,
        childCount: 0,
        sourceSize: existing?.sourceSize ?? Number(prefix.observation.size),
        sourceMtimeMs: existing?.sourceMtimeMs ?? Number(prefix.observation.mtimeNs) / 1_000_000,
        sourceDevice: existing?.sourceDevice ?? prefix.observation.device.toString(),
        sourceInode: existing?.sourceInode ?? prefix.observation.inode.toString(),
        sourceRevision: reusableSourceRevision(existing, prefix),
        error: null,
      },
    });
  }

  applyTopology(drafts, options.stateSnapshot, diagnostics);
  const rows = drafts.map(({ input }) => input);
  const changedIds = upsertCatalogSessions(options.database, rows);

  const expectedPaths = new Set(prefixes.map(({ source }) => resolve(source.path)));
  const removedIds: string[] = [];
  for (const row of options.database.prepare("SELECT id, source_path FROM session_catalog").all()) {
    const id = requiredText(row, "id");
    const sourcePath = requiredText(row, "source_path");
    if (expectedPaths.has(resolve(sourcePath))) {
      continue;
    }
    removeCachedSource(options.database, sourcePath);
    removeCatalogSource(options.database, sourcePath);
    removedIds.push(id);
  }

  return {
    rows,
    changedIds,
    projects: listCatalogProjects(options.database),
    removedIds: removedIds.toSorted(),
    diagnostics,
    bytesRead: sourceSelection.bytesRead,
  };
}
