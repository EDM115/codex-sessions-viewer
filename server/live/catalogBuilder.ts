import { basename, extname, resolve, relative, isAbsolute, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  catalogProjects,
  membershipProject,
  resolveThreadMembershipFromSources,
} from "../../shared/library/projectIdentity.ts";
import { createViewerDiagnostic, type ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import type { CatalogSessionMetadata, ConversationProject } from "../../shared/types/library.ts";
import {
  listCatalogProjects,
  listAllCatalogSessions,
  readCatalogLibrary,
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
import type { CatalogMetadataSnapshot } from "../metadata/catalogMetadata.ts";
import type { GlobalStateMetadata } from "../metadata/globalState.ts";
import type { SessionIndexEntry } from "../metadata/sessionIndex.ts";
import { resolveSidebarMetadata } from "../metadata/sidebarMetadata.ts";
import type { StateMetadataSnapshot, StateThreadMetadata } from "../metadata/stateSnapshot.ts";
import {
  classifyThreadMetadata,
  classificationKind,
  isThreadVisible,
} from "../metadata/threadClassification.ts";
import { catalogMetadataRevision, resolveThreadFields } from "../metadata/threadFields.ts";
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
  catalogMetadata?: CatalogMetadataSnapshot;
  recoveryBatch?: boolean;
  signal?: AbortSignal;
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

function metadataRolloutPath(home: string, path: string): string | null {
  const candidate = resolve(home, path);
  const inside = ["sessions", "archived_sessions"].some((directory) => {
    const child = relative(resolve(home, directory), candidate);
    return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
  });
  return inside && /\.jsonl(?:\.zst)?$/iu.test(candidate) ? candidate : null;
}

async function readRecoveryBatch(options: RefreshLiveCatalogOptions) {
  // oxlint-disable no-await-in-loop -- One bounded prefix at a time keeps recovery cancellable between files
  const selected = [];
  let bytesRead = 0;
  for (const source of options.discovery.rollouts) {
    options.signal?.throwIfAborted();
    // Compressed filenames can establish recovery identity, decoding belongs to explicit open
    const prefix: SessionMetaPrefixResult = source.path.endsWith(".zst")
      ? {
          status: "missing",
          meta: null,
          parentThreadIdHint: null,
          bytesRead: 0,
          diagnostics: [],
          observation: {
            device: 0n,
            inode: 0n,
            size: 0n,
            mtimeNs: 0n,
            ctimeNs: 0n,
            regular: false,
            symbolicLink: false,
          },
        }
      : await (options.readPrefix ?? readSessionMetaPrefix)(source.path, 4096, {
          firstRecordMaxBytes: 4096,
        });
    options.signal?.throwIfAborted();
    bytesRead += prefix.bytesRead;
    selected.push({ source, prefix });
  }
  return { selected, bytesRead, diagnostics: selected.flatMap(({ prefix }) => prefix.diagnostics) };
  // oxlint-enable no-await-in-loop
}

function sourcePathKey(path: string | null): string {
  if (path === null) {
    return "";
  }
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
  existingSummary?: CatalogSessionMetadata | undefined;
  existingHistoryMode?: string | null | undefined;
}): CatalogSessionMetadata {
  const { id, source, prefix, sessionIndex, thread } = options;
  const fields = resolveThreadFields({
    id,
    thread,
    index: sessionIndex,
    knownTitle: options.existingSummary?.title,
    historyMode: prefix.meta?.historyMode ?? options.existingHistoryMode,
    createdAt: prefix.meta?.timestamp ?? options.existingSummary?.createdAt,
    updatedAt: options.existingSummary?.updatedAt ?? prefix.meta?.timestamp,
    recencyAt: options.existingSummary?.recencyAt,
    createdAtSource: prefix.meta?.timestamp
      ? "rollout.timestamp"
      : (options.existingSummary?.fieldSources?.createdAt ?? "retained.createdAt"),
    updatedAtSource: options.existingSummary?.updatedAt
      ? (options.existingSummary.fieldSources?.updatedAt ?? "retained.updatedAt")
      : "rollout.timestamp",
    recencyAtSource: options.existingSummary?.fieldSources?.recencyAt ?? undefined,
  });
  const cwd = prefix.meta?.cwd ?? thread?.cwd ?? options.existingSummary?.cwd ?? null;
  return {
    id,
    ...fields,
    scope: source.scope,
    sourcePath: source.path,
    cwd,
    gitBranch:
      prefix.meta?.git?.branch ?? thread?.gitBranch ?? options.existingSummary?.gitBranch ?? null,
    gitSha:
      prefix.meta?.git?.commitHash ?? thread?.gitSha ?? options.existingSummary?.gitSha ?? null,
    gitOriginUrl:
      prefix.meta?.git?.repositoryUrl ??
      thread?.gitOriginUrl ??
      options.existingSummary?.gitOriginUrl ??
      null,
    pinned: options.pinned,
    sectionName: options.section,
    parentThreadId: options.parentThreadId,
    childThreadIds: options.childThreadIds,
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
  metadataOnly = false,
  recovery = false,
): void {
  const byId = new Map(drafts.map((draft) => [draft.input.summary.id, draft]));
  const threads = new Map((stateSnapshot?.threads ?? []).map((thread) => [thread.id, thread]));
  for (const { input, prefix } of drafts) {
    const thread = threads.get(input.summary.id);
    const currentSource =
      thread === undefined ||
      thread.rolloutPath === "" ||
      sourcePathKey(thread.rolloutPath) === sourcePathKey(input.summary.sourcePath);
    const retained = metadataOnly ? input.structuralEvidence?.classification : undefined;
    const meta =
      currentSource && !metadataOnly ? (input.structuralEvidence?.meta ?? prefix.meta) : null;
    let classification = classifyThreadMetadata(
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
        parentThreadIdHint: metadataOnly ? null : prefix.parentThreadIdHint,
      },
    );
    const nativeDeclaration = classification.declarations?.find(
      (declaration) => declaration.origin === "native",
    );
    const explicitNative =
      thread?.threadSource != null ||
      thread?.parentThreadId != null ||
      thread?.attachedParentThreadId != null ||
      nativeDeclaration?.spawn ||
      nativeDeclaration?.internal ||
      classification.relationship !== "none";
    if (
      metadataOnly &&
      retained &&
      input.structuralEvidence?.meta == null &&
      (thread === undefined || (!explicitNative && retained.visibility !== "user-root"))
    ) {
      classification = {
        ...retained,
        reasons: [...retained.reasons, "retained-structure-unvalidated"],
      };
      input.structuralEvidence = {
        ...input.structuralEvidence!,
        freshness: "retained-unvalidated",
      };
    }
    if (metadataOnly && input.structuralEvidence?.meta != null) {
      if (!explicitNative && retained && retained.visibility !== "user-root") {
        classification = {
          ...retained,
          reasons: [...retained.reasons, "retained-raw-structure-unvalidated"],
        };
      } else {
        classification.reasons.push("retained-raw-structure-unvalidated");
      }
      input.structuralEvidence = { ...input.structuralEvidence, freshness: "retained-unvalidated" };
    }
    if (recovery && thread === undefined && prefix.meta === null) {
      if (input.structuralEvidence?.classification) {
        classification = {
          ...input.structuralEvidence.classification,
          reasons: [
            ...input.structuralEvidence.classification.reasons,
            "retained-structure-unvalidated",
          ],
        };
        input.structuralEvidence = {
          ...input.structuralEvidence,
          freshness: "retained-unvalidated",
        };
      } else {
        classification.visibility = "unresolved";
        classification.reasons.push("recovery-structure-not-loaded");
      }
    }
    if (!currentSource) {
      classification.reasons.push("stale-rollout-structure-ignored");
    }
    classification.reasons = [...new Set(classification.reasons)];
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
  const metadataOnly = options.catalogMetadata !== undefined;
  const previousLibrary = readCatalogLibrary(options.database);
  const previousThreads = new Map(previousLibrary?.threads.map((thread) => [thread.id, thread]));
  const removedIds: string[] = [];
  const absentNativeIds = new Set<string>();
  const native = options.catalogMetadata;
  if (native?.freshness.state === "fresh" && native.threadsComplete) {
    const ids = new Set(native.threads.map((thread) => thread.id));
    for (const row of options.database
      .prepare("SELECT id FROM catalog_native_ownership WHERE authority = ?")
      .all(native.stateAuthority)) {
      const id = String(row["id"]);
      if (!ids.has(id)) {
        absentNativeIds.add(id);
        if (options.database.prepare("DELETE FROM session_catalog WHERE id = ?").run(id).changes) {
          removedIds.push(id);
        }
      }
    }
  }
  const existingRows = listAllCatalogSessions(options.database);
  const removedNativeIds = new Set(
    options.database
      .prepare(
        "SELECT n.id FROM catalog_native_ownership n WHERE NOT EXISTS (SELECT 1 FROM session_catalog c WHERE c.id = n.id)",
      )
      .all()
      .map((row) => String(row["id"])),
  );
  const observedChanges = options.database.prepare("SELECT total_changes() AS count").get()?.[
    "count"
  ];
  const reusable =
    metadataOnly || options.recoveryBatch
      ? {
          prefixes: new Map<string, SessionMetaPrefixResult>(),
          rows: new Map<string, CatalogSessionInput>(),
        }
      : await reusablePrefixes(options, existingRows);
  const readPrefix = options.readPrefix ?? readSessionMetaPrefix;
  const sourceSelection = metadataOnly
    ? { selected: [], diagnostics: [], bytesRead: 0 }
    : options.recoveryBatch
      ? await readRecoveryBatch(options)
      : await selectSessionSources(options.discovery.rollouts, {
          currentRolloutPaths: new Map(
            (options.stateSnapshot?.threads ?? []).map((thread) => [thread.id, thread.rolloutPath]),
          ),
          prefixBytes: options.prefixBytes,
          readPrefix: (path, maxBytes, prefixOptions) =>
            Promise.resolve(
              reusable.prefixes.get(sourcePathKey(path)) ??
                readPrefix(path, maxBytes, prefixOptions),
            ),
          readJsonl: options.readJsonl,
        });
  const diagnostics = [...options.discovery.diagnostics, ...sourceSelection.diagnostics];
  options.signal?.throwIfAborted();
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

  if (native) {
    const existing = new Map(existingRows.map((row) => [row.summary.id, row]));
    const ids = new Set([...threads.keys(), ...sessionIndex.keys(), ...existing.keys()]);
    for (const id of ids) {
      if (absentNativeIds.has(id) || (removedNativeIds.has(id) && !threads.has(id))) {
        continue;
      }
      const previous = existing.get(id);
      const thread = threads.get(id);
      const sourcePath = thread?.rolloutPath
        ? metadataRolloutPath(native.codexHome, thread.rolloutPath)
        : (previous?.summary.sourcePath ?? null);
      const prefix: SessionMetaPrefixResult = {
        status: "missing",
        meta: null,
        parentThreadIdHint: null,
        bytesRead: 0,
        diagnostics: [],
        observation: {
          device: 0n,
          inode: 0n,
          size: 0n,
          mtimeNs: 0n,
          ctimeNs: 0n,
          regular: false,
          symbolicLink: false,
        },
      };
      const currentSourceRevision =
        previous?.summary.sourcePath === sourcePath
          ? previous.sourceRevision
          : `metadata:${id}:${sourcePath ?? "unresolved"}`;
      const summary = coldSummary({
        id,
        source: {
          path: sourcePath ?? "",
          scope: thread
            ? thread.archived
              ? "archived"
              : "active"
            : (previous?.summary.scope ?? "active"),
        },
        prefix,
        thread,
        sessionIndex: sessionIndex.get(id),
        pinned: pinned.has(id) || thread?.pinned === true,
        section: thread ? sectionName(thread, sections) : (previous?.summary.sectionName ?? null),
        parentThreadId: null,
        childThreadIds: [],
        existingSummary: previous?.summary,
        existingHistoryMode: previous?.structuralEvidence?.classification?.historyMode,
      });
      summary.sourcePath = sourcePath;
      summary.revision = currentSourceRevision;
      drafts.push({
        prefix,
        input: {
          summary,
          kind: previous?.kind ?? "root",
          materialization: "cold",
          project: previous?.project ?? { id: "none", name: "Recents", source: "none", hint: null },
          parentThreadId: null,
          agentPath: null,
          agentNickname: null,
          agentDepth: null,
          childCount: 0,
          sourceSize: previous?.sourceSize ?? 0,
          sourceMtimeMs: previous?.sourceMtimeMs ?? 0,
          sourceDevice: previous?.sourceDevice ?? null,
          sourceInode: previous?.sourceInode ?? null,
          sourceRevision: currentSourceRevision,
          error: null,
          structuralEvidence: previous?.structuralEvidence ?? {
            version: CATALOG_EVIDENCE_VERSION,
            origin: thread ? "native-metadata" : "session-index",
            status: "missing",
            meta: null,
            parentThreadIdHint: null,
          },
        },
      });
    }
  }

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
    const retainedSource = options.recoveryBatch
      ? existingRows.find(
          (row) => sourcePathKey(row.summary.sourcePath) === sourcePathKey(source.path),
        )
      : undefined;
    const id = prefix.meta?.id ?? retainedSource?.summary.id ?? fallbackSessionId(source.path);
    const thread = threads.get(id);
    const existing = retainedSource ?? reusable.rows.get(sourcePathKey(source.path));
    const retainedEvidence =
      options.recoveryBatch &&
      prefix.meta === null &&
      ["missing", "exhausted", "incomplete"].includes(prefix.status)
        ? existing?.structuralEvidence
        : undefined;
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
        structuralEvidence: retainedEvidence
          ? { ...retainedEvidence, freshness: "retained-unvalidated" }
          : {
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
        materialization: options.recoveryBatch ? existing.materialization : "cold",
        sourceRevision: options.recoveryBatch
          ? existing.sourceRevision
          : existing.sourceRevision.endsWith(":unavailable")
            ? existing.sourceRevision
            : `${existing.sourceRevision}:unavailable`,
        error: options.recoveryBatch
          ? existing.error
          : "Rollout source is temporarily unavailable, awaiting a stable representation.",
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
  applyTopology(drafts, options.stateSnapshot, diagnostics, metadataOnly, options.recoveryBatch);
  const rows = drafts.map(({ input }) => input);
  const prefixesById = new Map(drafts.map(({ input, prefix }) => [input.summary.id, prefix]));
  const memberships = rows.map((row) => {
    const id = row.summary.id;
    const nativeThread = threads.get(id);
    if (nativeThread) {
      row.summary = { ...row.summary, scope: nativeThread.archived ? "archived" : "active" };
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
    let membership = resolveThreadMembershipFromSources(id, source);
    const previous = previousThreads.get(id);
    const explicitGlobalMembership =
      (!native || native.freshness.globalState === "fresh") &&
      (metadata.globalState.projectlessThreadIds?.includes(id) ||
        Object.hasOwn(metadata.globalState.threadProjectAssignments ?? {}, id) ||
        Object.hasOwn(workspace ?? {}, "project"));
    const retainMembership =
      (metadataOnly || options.recoveryBatch === true) &&
      !nativeThread &&
      previous !== undefined &&
      !explicitGlobalMembership;
    if (retainMembership) {
      membership = {
        ...membership,
        projectId: previous.projectId,
        hostId: previous.hostId,
        diagnostics: [...membership.diagnostics, "retained-membership-unvalidated"],
      };
      const retainedProject = previousLibrary?.projects.find(
        (project) => project.id === previous.projectId,
      );
      if (retainedProject && !projects.some((project) => project.id === retainedProject.id)) {
        projects.push(retainedProject);
      }
    }
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
    return {
      row,
      membership,
      retainMembership,
      retainedSection:
        (metadataOnly || options.recoveryBatch === true) && !nativeThread ? previous : undefined,
    };
  });
  const sidebar = resolveSidebarMetadata(metadata, {
    identityScopeKey: options.sidebarIdentityScopeKey,
  });
  const retainedSectionIds = new Set(
    memberships
      .filter(({ retainedSection }) => retainedSection !== undefined)
      .map(({ row }) => row.summary.id),
  );
  const currentSectionMembers = new Set(sidebar.sections.flatMap((section) => section.threadIds));
  const qualifiedSectionIdentity = sidebar.qualifiedSectionIdentity;
  const freshSectionState =
    native?.freshness.globalState === "fresh" && qualifiedSectionIdentity
      ? metadata.globalState.sectionsByIdentity?.[qualifiedSectionIdentity]
      : undefined;
  for (const previous of previousLibrary?.sections ?? []) {
    const qualifiedPrefix = `custom:${qualifiedSectionIdentity}:`;
    const qualifiedCurrentCollection =
      freshSectionState?.sections !== undefined && previous.id.startsWith(qualifiedPrefix);
    const currentDefinition = qualifiedCurrentCollection
      ? freshSectionState.sections?.find(
          (section) => section.id === previous.id.slice(qualifiedPrefix.length),
        )
      : undefined;
    // A qualified section collection can explicitly remove the entire section
    if (qualifiedCurrentCollection && !currentDefinition) {
      continue;
    }
    const retainedIds = previous.threadIds.filter((id) => {
      const host =
        freshSectionState?.threadHostIds?.[id] ??
        metadata.globalState.threadProjectMembershipHostIds?.[id];
      const explicitlyDeleted =
        host !== undefined &&
        currentDefinition?.pendingDeletionHostIdsByItemKey?.[
          `codex:thread:${host}:${id}`
        ]?.includes(host);
      const observedHostItems =
        host !== undefined &&
        currentDefinition !== undefined &&
        sidebar.sectionItemCoverage[previous.id] === "complete";
      return (
        retainedSectionIds.has(id) &&
        !currentSectionMembers.has(id) &&
        !explicitlyDeleted &&
        !observedHostItems
      );
    });
    if (!retainedIds.length) {
      continue;
    }
    const current = sidebar.sections.find((section) => section.id === previous.id);
    if (current) {
      current.threadIds.push(...retainedIds);
    } else {
      sidebar.sections.push({ ...previous, threadIds: retainedIds, projectIds: [] });
    }
  }
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
  for (const row of rows) {
    row.summary.metadataRevision = catalogMetadataRevision(row.summary);
    if (row.summary.metadataConflicts?.length) {
      diagnostics.push(
        createViewerDiagnostic({
          code: "metadata.snapshot_invalid",
          severity: "info",
          area: "metadata",
          sessionId: row.summary.id,
          message: "Independent metadata sources disagree, field precedence was applied.",
          details: {
            fields: row.summary.metadataConflicts,
            sources: row.summary.fieldSources ?? {},
          },
        }),
      );
    }
  }
  const changedIds = upsertCatalogSessions(options.database, rows, currentRows);
  if (native) {
    for (const thread of native.threads) {
      options.database
        .prepare(
          "INSERT INTO catalog_native_ownership (id, authority) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET authority = excluded.authority",
        )
        .run(thread.id, native.stateAuthority);
    }
    options.database
      .prepare(
        "INSERT INTO catalog_metadata_status (id, payload_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json",
      )
      .run(
        JSON.stringify({
          codexHome: native.codexHome,
          freshness: native.freshness,
          generations: native.generations,
          stateAuthority: native.stateAuthority,
          threadsComplete: native.threadsComplete,
        }),
      );
  }
  const groupsChanged = writeCatalogLibrary(options.database, {
    projects,
    sections: sidebar.sections,
    preferences: sidebar.preferences,
    diagnostics: sidebar.diagnostics,
    threads: memberships.map(({ row, membership, retainMembership, retainedSection }) => {
      const thread = threads.get(row.summary.id);
      const legacyTimestamp =
        sessionIndex.get(row.summary.id)?.updatedAt ??
        prefixesById.get(row.summary.id)?.meta?.timestamp ??
        row.summary.updatedAt;
      const updatedAt =
        thread?.updatedAtMs ??
        (thread ? thread.updatedAt * 1000 : legacyTimestamp ? Date.parse(legacyTimestamp) : null);
      return {
        id: row.summary.id,
        title: row.summary.title,
        projectId: membership.projectId,
        hostId: membership.hostId,
        scope: row.summary.scope,
        sectionId: thread ? thread.sectionId : (retainedSection?.sectionId ?? null),
        sectionPosition: thread
          ? (thread.sectionPosition ?? null)
          : (retainedSection?.sectionPosition ?? null),
        membershipFreshness: retainMembership ? "retained-unvalidated" : "fresh",
        sectionFreshness: retainedSection ? "retained-unvalidated" : "fresh",
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
    removedIds,
    diagnostics,
    bytesRead: sourceSelection.bytesRead,
  };
}
