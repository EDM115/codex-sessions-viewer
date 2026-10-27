import { basename, extname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  catalogProjects,
  membershipProject,
  resolveThreadMembershipFromSources,
} from "../../shared/library/projectIdentity.ts";
import type { ConversationSummary } from "../../shared/types/conversation.ts";
import { createViewerDiagnostic, type ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import type { ConversationProject } from "../../shared/types/library.ts";
import {
  listCatalogProjects,
  listAllCatalogSessions,
  upsertCatalogSessions,
  writeCatalogLibrary,
  type CatalogSessionInput,
  type CatalogSessionRecord,
  type CatalogSessionKind,
} from "../cache/catalogStore.ts";
import {
  CACHE_PARSER_VERSION,
  refreshUnchangedSourceManifest,
  type StableJsonlReader,
} from "../cache/sourceManifest.ts";
import type { SourceDiscoveryResult } from "../ingestion/discoverSources.ts";
import { parseRolloutFilename } from "../ingestion/rolloutIdentity.ts";
import { selectSessionSources } from "../ingestion/selectSessionSources.ts";
import {
  CATALOG_EVIDENCE_VERSION,
  observeSessionMetaSource,
  readSessionMetaPrefix,
  type SessionMetaPrefix,
  type SessionMetaPrefixObservation,
  type SessionMetaPrefixResult,
} from "../ingestion/sessionMetaPrefix.ts";
import type { GlobalStateMetadata } from "../metadata/globalState.ts";
import type { SessionIndexEntry } from "../metadata/sessionIndex.ts";
import { resolveSidebarMetadata } from "../metadata/sidebarMetadata.ts";
import type { StateMetadataSnapshot, StateThreadMetadata } from "../metadata/stateSnapshot.ts";
import {
  classifyThreadMetadata,
  classificationKind,
  isThreadVisible,
} from "../metadata/threadClassification.ts";
import { classifySessionStructure } from "../normalization/subagentTopology.ts";

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
  sidebarIdentityScopeKey?: string | undefined;
  prefixBytes?: number | undefined;
  /** Omit for recovery scans; [] refreshes metadata without rollout observations. */
  changedSourcePaths?: readonly string[] | undefined;
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
  groupsChanged: boolean;
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
  const evidence = existing.structuralEvidence!;
  return {
    status: evidence.status,
    meta: evidence.meta,
    parentThreadIdHint: evidence.parentThreadIdHint,
    bytesRead: 0,
    observation,
    diagnostics: [],
  };
}

function cachedObservation(existing: CatalogSessionInput): SessionMetaPrefixObservation {
  return {
    device: BigInt(existing.sourceDevice ?? "0"),
    inode: BigInt(existing.sourceInode ?? "0"),
    size: BigInt(existing.sourceSize),
    mtimeNs: BigInt(Math.round(existing.sourceMtimeMs * 1_000_000)),
    ctimeNs: 0n,
    regular: true,
    symbolicLink: false,
  };
}

async function reusablePrefixes(
  options: RefreshLiveCatalogOptions,
  existingRows: readonly CatalogSessionRecord[],
): Promise<{
  prefixes: Map<string, SessionMetaPrefixResult>;
  rows: Map<string, CatalogSessionInput>;
}> {
  const existingByPath = new Map(
    existingRows.map((record) => [sourcePathKey(record.summary.sourcePath), record]),
  );
  const reusable = new Map<string, SessionMetaPrefixResult>();
  const reusableRows = new Map<string, CatalogSessionInput>();
  const observeSource = options.observeSource ?? observeSessionMetaSource;
  const changedPaths =
    options.changedSourcePaths === undefined
      ? null
      : new Set(options.changedSourcePaths.map(sourcePathKey));
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
        if (
          existing === undefined ||
          existing.structuralEvidence?.version !== CATALOG_EVIDENCE_VERSION
        ) {
          return null;
        }
        if (changedPaths !== null && !changedPaths.has(sourcePathKey(source.path))) {
          return {
            path: source.path,
            prefix: cachedSessionSource(existing, cachedObservation(existing)),
            existing,
          };
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

export function classifySessionMeta(
  meta: SessionMetaPrefix | null,
  threadModel: string | null | undefined = null,
  parentThreadIdHint: string | null = null,
  fallbackSource: string | null | undefined = null,
): SessionMetaClassification {
  return classifySessionStructure({
    ...meta,
    source: meta?.source ?? null,
    parentThreadId: meta?.parentThreadId,
    threadModel,
    parentThreadIdHint,
    fallbackSource,
  });
}

function fallbackSessionId(path: string): string {
  const identity = parseRolloutFilename(path);
  if (identity !== null) {
    return identity.stableThreadId;
  }
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
  const threads = new Map((stateSnapshot?.threads ?? []).map((thread) => [thread.id, thread]));
  for (const { input, prefix } of drafts) {
    const thread = threads.get(input.summary.id);
    const currentSource =
      thread === undefined ||
      thread.rolloutPath === "" ||
      sourcePathKey(thread.rolloutPath) === sourcePathKey(input.summary.sourcePath);
    const meta = currentSource ? (input.structuralEvidence?.meta ?? prefix.meta) : null;
    const classification = classifyThreadMetadata(
      {
        metadata: meta,
        status:
          currentSource && prefix.status === "invalid"
            ? "invalid"
            : meta === null
              ? "missing"
              : "valid",
        issues: currentSource && prefix.status === "invalid" ? ["rollout-prefix"] : [],
      },
      thread,
      {
        spawnParentThreadIds: (stateSnapshot?.spawnEdges ?? [])
          .filter((edge) => edge.childThreadId === input.summary.id)
          .map((edge) => edge.parentThreadId),
        parentThreadIdHint: prefix.parentThreadIdHint,
      },
    );
    if (!currentSource) {
      classification.reasons.push("stale-rollout-structure-ignored");
    }
    input.kind = classificationKind(classification);
    input.parentThreadId =
      classification.relationship === "attached" || classification.relationship === "fork"
        ? null
        : classification.parentThreadId;
    input.agentPath = classification.agentPath;
    input.agentNickname = classification.agentNickname;
    input.agentDepth = classification.agentDepth;
    if (input.structuralEvidence == null) {
      input.structuralEvidence = {
        version: CATALOG_EVIDENCE_VERSION,
        origin: "rollout-prefix",
        status: prefix.status,
        meta,
        parentThreadIdHint: prefix.parentThreadIdHint,
      };
    }
    input.structuralEvidence = { ...input.structuralEvidence, classification };
    if (
      classification.visibility === "unresolved" ||
      classification.reasons.includes("legacy-absent-role-compatible-root") ||
      (input.parentThreadId !== null && !byId.has(input.parentThreadId))
    ) {
      diagnostics.push(
        createViewerDiagnostic({
          code: "metadata.snapshot_invalid",
          severity: "warning",
          area: "metadata",
          message: "Thread structural placement retains incomplete or conflicting evidence.",
          details: {
            threadId: input.summary.id,
            visibility: classification.visibility,
            reasons: classification.reasons,
            parentThreadId: input.parentThreadId,
            diagnosticPath: `/api/sessions/${encodeURIComponent(input.summary.id)}/classification`,
          },
        }),
      );
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
        row.input.kind = "auxiliary";
        const classification = row.input.structuralEvidence?.classification;
        if (classification !== undefined) {
          classification.visibility = "unresolved";
          classification.reasons.push("parent-cycle");
        }
      }
    }
  }
  const childIds = new Map<string, string[]>();
  for (const { input } of drafts) {
    if (
      !isThreadVisible(input.structuralEvidence!.classification!, "child") ||
      input.parentThreadId === null
    ) {
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

export async function refreshLiveCatalog(
  options: RefreshLiveCatalogOptions,
): Promise<CatalogRefreshResult> {
  const existingRows = listAllCatalogSessions(options.database);
  const observedChanges = options.database.prepare("SELECT total_changes() AS count").get()?.[
    "count"
  ];
  const reusable = await reusablePrefixes(options, existingRows);
  const readPrefix = options.readPrefix ?? readSessionMetaPrefix;
  const sourceSelection = await selectSessionSources(options.discovery.rollouts, {
    currentRolloutPaths: new Map(
      (options.stateSnapshot?.threads ?? []).map((thread) => [thread.id, thread.rolloutPath]),
    ),
    prefixBytes: options.prefixBytes,
    readPrefix: (path, maxBytes, prefixOptions) =>
      Promise.resolve(
        reusable.prefixes.get(sourcePathKey(path)) ?? readPrefix(path, maxBytes, prefixOptions),
      ),
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
  const metadata = {
    threads: options.stateSnapshot?.threads ?? [],
    projects: options.stateSnapshot?.projects ?? [],
    sections: options.stateSnapshot?.sections ?? [],
    globalState: options.globalState,
  };
  const projects = catalogProjects(metadata);

  for (const { source, prefix } of prefixes) {
    if (prefix.status === "changed") {
      const existing = existingRows.find(
        (row) => sourcePathKey(row.summary.sourcePath) === sourcePathKey(source.path),
      );
      if (existing !== undefined) {
        drafts.push({ prefix, input: { ...existing, summary: { ...existing.summary } } });
      }
      continue;
    }
    const id = prefix.meta?.id ?? fallbackSessionId(source.path);
    const thread = threads.get(id);
    const existing = reusable.rows.get(sourcePathKey(source.path));
    const classification = classifySessionMeta(
      prefix.meta,
      thread?.model,
      prefix.parentThreadIdHint,
      thread?.source,
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
    const project = { id: "none", name: "Recents", source: "none" as const, hint: null };
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
        structuralEvidence: {
          version: CATALOG_EVIDENCE_VERSION,
          origin: existing?.structuralEvidence?.origin ?? "rollout-prefix",
          status: prefix.status,
          meta: prefix.meta,
          parentThreadIdHint: prefix.parentThreadIdHint,
        },
      },
    });
  }

  // Materialization can commit while prefix I/O is pending. Usually the original metadata
  // snapshot is reusable; after concurrent writes, merge against current rows synchronously.
  const currentRows =
    options.database.prepare("SELECT total_changes() AS count").get()?.["count"] === observedChanges
      ? existingRows
      : listAllCatalogSessions(options.database);
  if (currentRows !== existingRows) {
    const currentById = new Map(currentRows.map((row) => [row.summary.id, row]));
    for (const draft of drafts) {
      const current = currentById.get(draft.input.summary.id);
      const evidence = current?.structuralEvidence;
      if (
        current?.sourceRevision !== draft.input.sourceRevision ||
        evidence?.origin !== "materialized" ||
        evidence.status !== "found" ||
        draft.input.structuralEvidence?.status === "found"
      ) {
        continue;
      }
      // A full parse can recover a capped declaration during the same refresh. Retain it
      // before resolving the graph, so parent lists and child placement use that evidence.
      const classification = classifySessionMeta(
        evidence.meta,
        undefined,
        evidence.parentThreadIdHint,
      );
      draft.input.structuralEvidence = evidence;
      draft.input.kind = classification.kind;
      draft.input.parentThreadId = classification.parentThreadId;
      draft.input.agentPath = classification.agentPath;
      draft.input.agentNickname = classification.agentNickname;
      draft.input.agentDepth = classification.agentDepth;
    }
  }
  const observedIds = new Set(drafts.map((draft) => draft.input.summary.id));
  for (const existing of currentRows) {
    if (observedIds.has(existing.summary.id)) {
      continue;
    }
    drafts.push({
      input: {
        ...existing,
        materialization: "cold",
        sourceRevision: existing.sourceRevision.endsWith(":unavailable")
          ? existing.sourceRevision
          : `${existing.sourceRevision}:unavailable`,
        error: "Rollout source is temporarily unavailable, awaiting a stable representation.",
      },
      prefix: {
        status: "missing",
        meta: existing.structuralEvidence?.meta ?? null,
        parentThreadIdHint: existing.parentThreadId,
        bytesRead: 0,
        diagnostics: [],
        observation: {
          device: BigInt(existing.sourceDevice ?? 0),
          inode: BigInt(existing.sourceInode ?? 0),
          size: BigInt(existing.sourceSize),
          mtimeNs: BigInt(Math.round(existing.sourceMtimeMs * 1_000_000)),
          ctimeNs: 0n,
          regular: false,
          symbolicLink: false,
        },
      },
    });
  }
  applyTopology(drafts, options.stateSnapshot, diagnostics);
  const rows = drafts.map(({ input }) => input);
  const prefixesById = new Map(drafts.map(({ input, prefix }) => [input.summary.id, prefix]));
  const memberships = rows.map((row) => {
    const id = row.summary.id;
    const native = threads.get(id);
    if (native) {
      row.summary = { ...row.summary, scope: native.archived ? "archived" : "active" };
    }
    const workspace = metadata.globalState.workspaceStates?.[id];
    const source = metadata.threads.some((thread) => thread.id === id)
      ? metadata
      : {
          ...metadata,
          globalState: {
            ...metadata.globalState,
            workspaceStates: {
              ...metadata.globalState.workspaceStates,
              [id]: {
                ...workspace,
                applied: { ...workspace?.applied, cwd: workspace?.applied?.cwd ?? row.summary.cwd },
              },
            },
          },
        };
    const membership = resolveThreadMembershipFromSources(id, source);
    row.project = membershipProject(membership, projects);
    for (const reason of membership.diagnostics) {
      diagnostics.push(
        createViewerDiagnostic({
          code: "metadata.snapshot_invalid",
          severity: "warning",
          area: "metadata",
          sessionId: id,
          message: "Project membership is unresolved.",
          details: { reason },
        }),
      );
    }
    return { row, membership };
  });
  const sidebar = resolveSidebarMetadata(metadata, {
    identityScopeKey: options.sidebarIdentityScopeKey,
  });
  for (const reason of sidebar.diagnostics) {
    diagnostics.push(
      createViewerDiagnostic({
        code: "metadata.snapshot_invalid",
        severity: "warning",
        area: "metadata",
        message: "Sidebar metadata could not be mapped safely.",
        details: { reason },
      }),
    );
  }
  const changedIds = upsertCatalogSessions(options.database, rows, currentRows);
  const groupsChanged = writeCatalogLibrary(options.database, {
    projects,
    sections: sidebar.sections,
    preferences: sidebar.preferences,
    diagnostics: sidebar.diagnostics,
    threads: memberships.map(({ row, membership }) => {
      const thread = threads.get(row.summary.id);
      const legacyTimestamp =
        sessionIndex.get(row.summary.id)?.updatedAt ??
        prefixesById.get(row.summary.id)?.meta?.timestamp;
      const updatedAt =
        thread?.updatedAtMs ??
        (thread ? thread.updatedAt * 1000 : legacyTimestamp ? Date.parse(legacyTimestamp) : null);
      return {
        id: row.summary.id,
        title:
          thread?.name ??
          thread?.title ??
          sessionIndex.get(row.summary.id)?.threadName ??
          row.summary.id,
        projectId: membership.projectId,
        hostId: membership.hostId,
        scope: row.summary.scope,
        sectionId: thread?.sectionId ?? null,
        sectionPosition: thread?.sectionPosition ?? null,
        pinned: row.summary.pinned,
        recencyAt:
          thread?.recencyAtMs ??
          (thread?.recencyAt === null || thread?.recencyAt === undefined
            ? updatedAt
            : thread.recencyAt * 1000),
        classification: row.structuralEvidence!.classification!,
      };
    }),
  });

  return {
    rows,
    groupsChanged,
    changedIds,
    projects: listCatalogProjects(options.database),
    removedIds: [],
    diagnostics,
    bytesRead: sourceSelection.bytesRead,
  };
}
