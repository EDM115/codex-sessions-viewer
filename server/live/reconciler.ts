import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import {
  catalogSession,
  listAllCatalogSessions,
  listCatalogAuxiliaryChildren,
  listCatalogChildren,
  setCatalogMaterialization,
  storeValidatedCatalogClassification,
} from "#server/cache/catalogStore.ts";
import {
  hasCachedSession,
  updateCachedSessionRichContent,
} from "#server/cache/conversationStore.ts";
import {
  getCachedSessionSummary,
  getCachedTurnsInRange,
  historyEpochStorage,
} from "#server/cache/repositoryStore.ts";
import { searchMembershipFilter } from "#server/cache/searchMembership.ts";
import { countCachedSearchResults } from "#server/cache/searchStore.ts";
import {
  CACHE_PARSER_VERSION,
  SessionCacheUpdater,
  refreshUnchangedSourceManifest,
  getSourceManifestEntry,
  type StableJsonlReader,
} from "#server/cache/sourceManifest.ts";
import {
  canonicalFaviconOrigin,
  fetchFaviconHttp,
  resolveFavicon,
  type FaviconHttpClient,
} from "#server/content/favicons.ts";
import { prepareConversationForExport } from "#server/export/prepareConversation.ts";
import { HistoryEpochAuthority } from "#server/history/historyEpochAuthority.ts";
import { HistoryPager, HistoryReloadError } from "#server/history/historyPager.ts";
import {
  NativeHistoryService,
  unavailableNativeHistory,
} from "#server/history/nativeHistoryService.ts";
import {
  type DiscoveredRolloutSource,
  type SourceDiscoveryResult,
} from "#server/ingestion/discoverSources.ts";
import { readStableJsonl } from "#server/ingestion/jsonlStream.ts";
import { recoverCatalogSources } from "#server/ingestion/recoverCatalogSources.ts";
import { rolloutRefFromSource } from "#server/ingestion/rolloutIdentity.ts";
import type { ResolvedRolloutLineage } from "#server/ingestion/rolloutLineage.ts";
import { RolloutStore } from "#server/ingestion/rolloutStream.ts";
import {
  observeSessionMetaSource,
  readSessionMetaPrefix,
  parseSessionMetaBytes,
  CATALOG_EVIDENCE_VERSION,
  type SessionMetaPrefixObservation,
} from "#server/ingestion/sessionMetaPrefix.ts";
import {
  watchSources,
  type SourceChange,
  type SourceWatchBatch,
  type SourceWatcher,
  type WatchSourcesOptions,
} from "#server/ingestion/watchSources.ts";
import { refreshLiveCatalog } from "#server/live/catalogBuilder.ts";
import { InvalidationBus } from "#server/live/invalidationBus.ts";
import {
  MaterializationQueue,
  type MaterializationPriority,
} from "#server/live/materializationQueue.ts";
import {
  readCatalogMetadata,
  type CatalogMetadataSnapshot,
} from "#server/metadata/catalogMetadata.ts";
import type { GlobalStateMetadata } from "#server/metadata/globalState.ts";
import { HistorySnapshotManager } from "#server/metadata/historySnapshot.ts";
import type { SessionIndexEntry } from "#server/metadata/sessionIndex.ts";
import type { StateMetadataSnapshot } from "#server/metadata/stateSnapshot.ts";
import {
  catalogVisibilitySql,
  classifyThreadMetadata,
  rawThreadMetadata,
} from "#server/metadata/threadClassification.ts";
import {
  attachGuardianEvidence,
  associateApprovalReviews,
  approvalEvidenceForHistoryPage,
  parseParentNativeReviews,
  parseGuardianTurns,
  type GuardianReview,
} from "#server/normalization/guardianEvidence.ts";
import type { NormalizedSession } from "#server/normalization/normalizeSession.ts";
import { enrichSubagentActivities } from "#server/normalization/subagentTopology.ts";
import { documentReferences } from "#shared/content/documentReferences.ts";
import { conversationActivitySchema, type SourceGeneration } from "#shared/types/conversation.ts";
import type { ViewerDiagnostic } from "#shared/types/diagnostics.ts";
import type { DeepSearchJob, PreparationResult } from "#shared/types/library.ts";
import type {
  SearchQuery,
  ViewerInvalidation,
  TurnChunk,
  HistoryPageQuery,
  HistoryItemQuery,
  RepositoryRequestOptions,
} from "#shared/types/repository.ts";
import type { RichTextDocument } from "#shared/types/richText.ts";

const DEFAULT_RECONCILIATION_INTERVAL_MS = 30_000;

export function coalesceSourceWatchBatches(
  batches: readonly SourceWatchBatch[],
): SourceWatchBatch | null {
  const changes = new Map<string, SourceChange>();
  for (const batch of batches) {
    for (const change of batch.changes) {
      changes.set(`${change.source}\0${resolve(change.path)}`, change);
    }
  }
  const observedAt = batches.at(-1)?.observedAt;
  return observedAt === undefined
    ? null
    : {
        changes: [...changes.values()],
        observedAt,
      };
}

interface LiveMetadata {
  sessionIndexEntries: SessionIndexEntry[];
  globalState: GlobalStateMetadata;
  stateSnapshot: StateMetadataSnapshot | null;
  diagnostics: ViewerDiagnostic[];
}

export interface LiveReconcilerOptions {
  faviconClient?: FaviconHttpClient | undefined;
  bus: InvalidationBus;
  cacheDir: string;
  codexHome: string;
  database: DatabaseSync;
  debounceMs?: number | undefined;
  reconciliationIntervalMs?: number | undefined;
  readJsonl?: StableJsonlReader | undefined;
  readPrefix?: typeof readSessionMetaPrefix | undefined;
  observeSource?: ((path: string) => Promise<SessionMetaPrefixObservation>) | undefined;
  countSearchResults?: typeof countCachedSearchResults | undefined;
  fetchFavicons?: boolean | undefined;
  trustedMediaRoots?: readonly string[] | undefined;
  watch?: ((options: WatchSourcesOptions) => SourceWatcher) | undefined;
  onError?: ((error: unknown) => void) | undefined;
  readMetadata?: typeof readCatalogMetadata;
  recoverSources?: typeof recoverCatalogSources;
}

export class LiveReconciler {
  readonly #faviconClient: FaviconHttpClient | undefined;
  readonly #faviconController = new AbortController();
  readonly #faviconTasks = new Set<Promise<void>>();
  readonly #publishedFavicons = new Map<string, string | null>();
  readonly #faviconJobs = new Set<string>();
  readonly #faviconQueue: string[] = [];
  #activeFavicons = 0;
  readonly #bus: InvalidationBus;
  readonly #cacheDir: string;
  readonly #codexHome: string;
  readonly #database: DatabaseSync;
  readonly #nativeHistory: NativeHistoryService;
  readonly #historyPager: HistoryPager;
  readonly #rolloutStore: RolloutStore;
  readonly #debounceMs: number | undefined;
  readonly #reconciliationIntervalMs: number;
  readonly #fetchFavicons: boolean;
  readonly #trustedMediaRoots: readonly string[];
  readonly #watch: (options: WatchSourcesOptions) => SourceWatcher;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #updater: SessionCacheUpdater;
  readonly #readJsonl: StableJsonlReader;
  readonly #readPrefix: typeof readSessionMetaPrefix;
  readonly #observeSource: (path: string) => Promise<SessionMetaPrefixObservation>;
  readonly #countSearchResults: typeof countCachedSearchResults;
  readonly #readMetadata: typeof readCatalogMetadata;
  readonly #recoverSources: typeof recoverCatalogSources;
  #catalogMetadata: CatalogMetadataSnapshot | undefined;
  #recoveryController: AbortController | null = null;
  #recovery: Promise<void> = Promise.resolve();
  #recoveryState: "idle" | "running" | "complete" | "failed" = "idle";
  readonly #materializationQueue: MaterializationQueue;
  readonly #knownFaviconOrigins = new Map<string, string>();
  readonly #richPreparations = new Map<string, Promise<void>>();
  readonly #deepSearchJobs = new Map<string, DeepSearchJob>();
  #metadata: LiveMetadata = {
    sessionIndexEntries: [],
    globalState: { projects: [], pinnedThreadIds: [] },
    stateSnapshot: null,
    diagnostics: [],
  };
  #watcher: SourceWatcher | null = null;
  #interval: NodeJS.Timeout | null = null;
  #queue = Promise.resolve();
  #pendingBatches: SourceWatchBatch[] = [];
  #batchDrainScheduled = false;
  #started = false;
  #closed = false;
  #revisionSequence = 0;

  constructor(options: LiveReconcilerOptions) {
    this.#faviconClient = (url, request) =>
      (options.faviconClient ?? fetchFaviconHttp)(url, {
        ...request,
        signal: this.#faviconController.signal,
      });
    const interval = options.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
    if (!Number.isSafeInteger(interval) || interval < 1_000) {
      throw new RangeError("reconciliationIntervalMs must be a safe integer of at least 1000");
    }
    this.#bus = options.bus;
    this.#cacheDir = options.cacheDir;
    this.#codexHome = resolve(options.codexHome);
    this.#database = options.database;
    const epochAuthority = new HistoryEpochAuthority(historyEpochStorage(options.database));
    this.#rolloutStore = new RolloutStore({
      cacheDirectory: join(options.cacheDir, "decoded-rollouts"),
    });
    this.#nativeHistory = new NativeHistoryService(
      options.database,
      new HistorySnapshotManager({
        sourceDatabase: join(this.#codexHome, "thread_history_1.sqlite"),
        sourceWal: join(this.#codexHome, "thread_history_1.sqlite-wal"),
        snapshotRoot: join(options.cacheDir, "history-snapshots"),
      }),
      { epochAuthority },
    );
    this.#historyPager = new HistoryPager({
      database: options.database,
      epochAuthority,
      native: this.#nativeHistory,
      open: (ref, signal) => this.#rolloutStore.open(ref, signal),
    });
    this.#debounceMs = options.debounceMs;
    this.#reconciliationIntervalMs = interval;
    this.#fetchFavicons = options.fetchFavicons ?? true;
    this.#trustedMediaRoots = options.trustedMediaRoots ?? [join(this.#codexHome, "attachments")];
    this.#watch = options.watch ?? watchSources;
    this.#onError = options.onError;
    this.#readJsonl = options.readJsonl ?? readStableJsonl;
    this.#readPrefix = options.readPrefix ?? readSessionMetaPrefix;
    this.#observeSource = options.observeSource ?? observeSessionMetaSource;
    this.#countSearchResults = options.countSearchResults ?? countCachedSearchResults;
    this.#readMetadata = options.readMetadata ?? readCatalogMetadata;
    this.#recoverSources = options.recoverSources ?? recoverCatalogSources;
    this.#updater = new SessionCacheUpdater(this.#database, {
      openRollout: (ref, signal) => this.#rolloutStore.open(ref, signal),
      maxRetainedSources: 4,
      maxRetainedBytes: 64 * 1024 * 1024,
      readJsonl: options.readJsonl,
    });
    this.#materializationQueue = new MaterializationQueue((id, priority) =>
      this.#materialize(id, priority),
    );
  }

  get codexHome(): string {
    return this.#codexHome;
  }

  get catalogStatus() {
    const catalogSource =
      this.#catalogMetadata?.freshness.state === "fresh"
        ? this.#catalogMetadata.threadsComplete
          ? ("fresh" as const)
          : ("partial" as const)
        : this.#catalogMetadata?.freshness.state === "retained"
          ? ("retained" as const)
          : ("recovery" as const);
    return { catalogSource, recoveryState: this.#recoveryState };
  }

  whenRecoverySettled(): Promise<void> {
    return this.#recovery;
  }

  faviconOrigin(key: string): string | null {
    return this.#knownFaviconOrigins.get(key) ?? null;
  }

  scheduleDocumentFavicons(document: RichTextDocument): void {
    this.#scheduleFaviconOrigins(documentReferences(document).origins);
  }

  #scheduleFaviconOrigins(origins: Iterable<string>): void {
    if (this.#closed) {
      return;
    }
    for (const origin of origins) {
      let canonical: string;
      try {
        canonical = canonicalFaviconOrigin(origin);
      } catch {
        continue;
      }
      this.#knownFaviconOrigins.set(this.#faviconKey(canonical), canonical);
      if (this.#knownFaviconOrigins.size > 512) {
        this.#knownFaviconOrigins.delete(this.#knownFaviconOrigins.keys().next().value!);
      }
      if (
        !this.#fetchFavicons ||
        this.#faviconJobs.has(canonical) ||
        this.#faviconQueue.length >= 32
      ) {
        continue;
      }
      this.#faviconJobs.add(canonical);
      this.#faviconQueue.push(canonical);
    }
    this.#drainFavicons();
  }

  #drainFavicons(): void {
    while (!this.#closed && this.#activeFavicons < 2 && this.#faviconQueue.length) {
      const origin = this.#faviconQueue.shift()!;
      this.#activeFavicons += 1;
      const task = resolveFavicon(this.#database, origin, {
        mode: "live",
        faviconRoot: join(this.#cacheDir, "favicons"),
        client: this.#faviconClient,
      })
        .then(async (result) => {
          const resolution = result.backgroundRefresh ? await result.backgroundRefresh : result;
          if (
            !this.#closed &&
            resolution.status === "available" &&
            (result.backgroundRefresh !== null ||
              this.#publishedFavicons.get(origin) !== resolution.sha256)
          ) {
            this.#publishedFavicons.set(origin, resolution.sha256);
            if (this.#publishedFavicons.size > 512) {
              this.#publishedFavicons.delete(this.#publishedFavicons.keys().next().value!);
            }
            this.#publish({
              type: "favicon.updated",
              ids: [origin],
              revision: this.#nextRevision(),
            });
          }
          return undefined;
        })
        .catch((error: unknown) => {
          if (!this.#closed) {
            this.#onError?.(error);
          }
        })
        .finally(() => {
          this.#faviconTasks.delete(task);
          this.#activeFavicons -= 1;
          this.#faviconJobs.delete(origin);
          this.#drainFavicons();
        });
      this.#faviconTasks.add(task);
    }
  }

  #faviconKey(origin: string): string {
    return Buffer.from(origin).toString("base64url");
  }

  #nextRevision(): string {
    this.#revisionSequence += 1;
    return `live:${this.#revisionSequence}`;
  }

  #publish(event: ViewerInvalidation): void {
    this.#bus.publish(event);
  }

  #richEvidenceRevision(sessionId: string): string {
    return JSON.stringify(
      this.#database
        .prepare(
          "SELECT id, source_revision, source_path, parent_thread_id, agent_path, agent_nickname FROM session_catalog WHERE id = ? OR parent_thread_id = ? ORDER BY id",
        )
        .all(sessionId, sessionId),
    );
  }

  async #prepareRichContent(
    session: NormalizedSession,
    evidenceRevision: string,
  ): Promise<NormalizedSession> {
    const prepared = await prepareConversationForExport(this.#database, session, {
      mediaRoot: join(this.#cacheDir, "assets"),
      faviconRoot: join(this.#cacheDir, "favicons"),
      offline: true,
      mode: "live",
      trustedMediaRoots: this.#trustedMediaRoots,
    });
    if (evidenceRevision !== this.#richEvidenceRevision(session.summary.id)) {
      throw new Error("The conversation evidence changed during rich preparation.");
    }
    updateCachedSessionRichContent(this.#database, prepared.conversation);
    this.#scheduleFaviconOrigins(prepared.faviconOrigins);
    return prepared.conversation;
  }

  async #guardianReviews(parentThreadId: string): Promise<GuardianReview[]> {
    const reviews: GuardianReview[] = [];
    for (const guardian of listCatalogAuxiliaryChildren(this.#database, parentThreadId)) {
      if (guardian.summary.sourcePath === null) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- Guardian evidence is bounded to auxiliary children of the opened conversation.
      const result = await this.#readJsonl(guardian.summary.sourcePath, { start: 0 });
      if (result.read.status !== "stable") {
        continue;
      }
      const parsedReviews = parseGuardianTurns(
        result.records,
        rolloutRefFromSource(
          guardian.summary.sourcePath,
          guardian.structuralEvidence?.meta ?? null,
        ),
      );
      reviews.push(...parsedReviews.filter((review) => review.parentThreadId === parentThreadId));
    }
    return reviews;
  }

  #approvalTools(sessionId: string, reviews: readonly GuardianReview[]) {
    const turns = reviews.flatMap((review) =>
      review.targetItemId == null &&
      review.reviewId == null &&
      review.toolName != null &&
      review.targetTurnId != null
        ? [review.targetTurnId]
        : [],
    );
    const items = reviews.flatMap((review) =>
      review.targetItemId == null ? [] : [review.targetItemId],
    );
    const ids = reviews.flatMap((review) => (review.reviewId == null ? [] : [review.reviewId]));
    if (turns.length + items.length + ids.length === 0) {
      return [];
    }
    return this.#database
      .prepare(`
      SELECT json_set(payload_json, '$.output', NULL, '$.error', NULL, '$.rawEventIds', json('[]'), '$.approval', NULL, '$.approvalAttempts', json('[]')) AS evidence_json
      FROM activities WHERE session_id = ? AND kind = 'tool' AND (
        turn_id IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?))
        OR json_extract(payload_json, '$.nativeItemId') IN (SELECT value FROM json_each(?))
        OR json_extract(payload_json, '$.approvalReviewId') IN (SELECT value FROM json_each(?))
      )
    `)
      .all(
        sessionId,
        JSON.stringify([...new Set(turns)]),
        JSON.stringify(items),
        JSON.stringify(items),
        JSON.stringify(ids),
      )
      .flatMap((row) => {
        const parsed = conversationActivitySchema.safeParse(
          JSON.parse(String(row["evidence_json"])),
        );
        return parsed.success && parsed.data.kind === "tool" ? [parsed.data] : [];
      });
  }
  async #attachGuardianReviews(session: NormalizedSession): Promise<void> {
    const reviews = [
      ...parseParentNativeReviews(session),
      ...(await this.#guardianReviews(session.summary.id)),
    ];
    const allTools = this.#approvalTools(session.summary.id, reviews);
    const associations = associateApprovalReviews(allTools, reviews, {
      sessionId: session.summary.id,
    });
    const matchedReviews = [...associations.matches.values()].flat();
    attachGuardianEvidence(
      session.turns.flatMap(({ activities }) =>
        activities.filter((activity) => activity.kind === "tool"),
      ),
      matchedReviews,
      { sessionId: session.summary.id },
    );
  }

  async getApprovalEvidence(sessionId: string, options: RepositoryRequestOptions = {}) {
    const release = this.#materializationQueue.holdSelected();
    try {
      const selection = this.#historySelection(sessionId);
      const page = await this.#historyPager.readRawEvidence(
        selection.ref,
        selection.references,
        { anchor: { kind: "latest" } },
        options.signal,
        selection.sourceRevision,
      );
      const auxiliary = await this.#guardianReviews(sessionId);
      options.signal?.throwIfAborted();
      const current = catalogSession(this.#database, sessionId);
      if (
        current?.summary.sourcePath !== selection.ref.sourcePath ||
        current.sourceRevision !== selection.sourceRevision
      ) {
        throw new HistoryReloadError("history.selection_changed");
      }
      return approvalEvidenceForHistoryPage(page, auxiliary);
    } finally {
      release();
    }
  }

  #enrichSubagents(session: NormalizedSession): void {
    const children = listCatalogChildren(this.#database, session.summary.id);
    enrichSubagentActivities(
      session.turns.flatMap(({ activities }) =>
        activities.filter((activity) => activity.kind === "subagent"),
      ),
      children.map((child) => ({
        id: child.summary.id,
        parentThreadId: child.parentThreadId,
        agentPath: child.agentPath,
        agentNickname: child.agentNickname,
      })),
    );
  }

  async #updateSource(
    source: DiscoveredRolloutSource,
    expectedSessionId: string,
    expectedCatalogSourceRevision: string,
    force: boolean,
    announce: boolean,
  ): Promise<PreparationResult> {
    const result = await this.#updater.update(source, {
      force,
      expectedCatalogSessionId: expectedSessionId,
      expectedCatalogSourceRevision,
      sessionIndexEntries: this.#metadata.sessionIndexEntries,
      stateSnapshot: this.#metadata.stateSnapshot,
    });
    if (result.status === "stale-catalog" || result.status === "superseded") {
      return { id: expectedSessionId, state: "loading", error: null };
    }
    const currentCatalog = catalogSession(this.#database, expectedSessionId);
    if (
      currentCatalog === null ||
      currentCatalog.sourceRevision !== expectedCatalogSourceRevision ||
      currentCatalog.summary.sourcePath !== source.path
    ) {
      return { id: expectedSessionId, state: "loading", error: null };
    }
    if (result.status === "failed") {
      if (announce) {
        this.#publish({
          type: "diagnostic.updated",
          ids: result.diagnostics.map(({ id }) => id),
          revision: this.#nextRevision(),
        });
      }
      return {
        id: expectedSessionId,
        state: "failed",
        error:
          result.diagnostics.map(({ message }) => message).join(" ") ||
          "The conversation could not be materialized.",
      };
    }
    if (result.status === "unchanged") {
      return result.sessionId !== null &&
        hasCachedSession(this.#database, result.sessionId, CACHE_PARSER_VERSION)
        ? { id: expectedSessionId, state: "ready", error: null }
        : {
            id: expectedSessionId,
            state: "failed",
            error: "The source was unchanged but no normalized conversation is available.",
          };
    }
    if (result.sessionId !== expectedSessionId) {
      return {
        id: expectedSessionId,
        state: "failed",
        error: `The rollout materialized as unexpected session ${result.sessionId}.`,
      };
    }
    const after = getCachedSessionSummary(this.#database, result.sessionId);
    if (after === null) {
      return {
        id: expectedSessionId,
        state: "failed",
        error: "The normalized conversation was not committed to the viewer cache.",
      };
    }
    const catalogAfterPreparation = catalogSession(this.#database, expectedSessionId);
    if (
      catalogAfterPreparation === null ||
      catalogAfterPreparation.sourceRevision !== expectedCatalogSourceRevision ||
      catalogAfterPreparation.summary.sourcePath !== source.path
    ) {
      return { id: expectedSessionId, state: "loading", error: null };
    }
    if (!announce) {
      return { id: expectedSessionId, state: "ready", error: null };
    }
    this.#publish({
      type: "session.updated",
      ids: [result.sessionId, ...result.changedTurnIds],
      revision: after.revision,
    });
    return { id: expectedSessionId, state: "ready", error: null };
  }

  async #materialize(id: string, _priority: MaterializationPriority): Promise<PreparationResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const catalog = catalogSession(this.#database, id);
      if (
        catalog === null ||
        (catalog.kind === "auxiliary" &&
          catalog.structuralEvidence?.classification?.visibility !== "unresolved")
      ) {
        return { id, state: "failed", error: "Conversation not found." };
      }
      if (catalog.summary.sourcePath === null) {
        return {
          id,
          state: "failed",
          error:
            "The conversation exists in metadata but its rollout source has not been resolved.",
        };
      }
      if (
        catalog.materialization === "ready" &&
        hasCachedSession(this.#database, id, CACHE_PARSER_VERSION) &&
        // oxlint-disable-next-line no-await-in-loop -- The bounded retry must validate the selected catalog revision before serving its cached body
        (await refreshUnchangedSourceManifest(this.#database, catalog.summary.sourcePath, id))
      ) {
        const current = catalogSession(this.#database, id);
        if (
          current?.sourceRevision === catalog.sourceRevision &&
          current.summary.sourcePath === catalog.summary.sourcePath
        ) {
          if (!this.#reconcileValidatedStructure(id)) {
            return { id, state: "failed", error: "The selected source is an internal helper." };
          }
          return { id, state: "ready", error: null };
        }
        continue;
      }
      setCatalogMaterialization(this.#database, id, "loading", null);
      let result: PreparationResult;
      try {
        // oxlint-disable-next-line no-await-in-loop -- The materialization retry is intentionally sequential and bounded to two attempts.
        result = await this.#updateSource(
          { path: catalog.summary.sourcePath, scope: catalog.summary.scope },
          id,
          catalog.sourceRevision,
          false,
          true,
        );
      } catch (error) {
        result = {
          id,
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const latest = catalogSession(this.#database, id);
      if (
        result.state === "loading" ||
        latest === null ||
        latest.sourceRevision !== catalog.sourceRevision ||
        latest.summary.sourcePath !== catalog.summary.sourcePath
      ) {
        continue;
      }
      if (result.state === "ready") {
        if (!this.#reconcileValidatedStructure(id)) {
          return { id, state: "failed", error: "The selected source is an internal helper." };
        }
      }
      if (latest.materialization !== result.state) {
        setCatalogMaterialization(
          this.#database,
          id,
          result.state === "ready" ? "ready" : "failed",
          result.error,
        );
      }
      this.#publish({
        type: "library.updated",
        ids: [id],
        revision: this.#nextRevision(),
      });
      return result;
    }
    const latest = catalogSession(this.#database, id);
    if (
      latest !== null &&
      (latest.kind !== "auxiliary" ||
        latest.structuralEvidence?.classification?.visibility === "unresolved") &&
      latest.materialization === "loading"
    ) {
      setCatalogMaterialization(this.#database, id, "cold", null);
    }
    this.#publish({
      type: "library.updated",
      ids: [id],
      revision: this.#nextRevision(),
    });
    return {
      id,
      state: "cold",
      error: "The conversation changed again during materialization; retry is required.",
    };
  }

  #reconcileValidatedStructure(id: string): boolean {
    const catalog = catalogSession(this.#database, id);
    if (!catalog?.summary.sourcePath) {
      return false;
    }
    const manifest = getSourceManifestEntry(this.#database, catalog.summary.sourcePath);
    if (!manifest || manifest.sessionId !== id) {
      return false;
    }
    const row = this.#database
      .prepare(
        "SELECT payload_json FROM raw_events WHERE session_id = ? AND type = 'session_meta' AND json_valid(payload_json) AND coalesce(json_extract(payload_json, '$.payload.id'), json_extract(payload_json, '$.id')) = ? ORDER BY source_order DESC LIMIT 1",
      )
      .get(id, id);
    const envelope: unknown =
      typeof row?.["payload_json"] === "string" ? JSON.parse(row["payload_json"]) : null;
    const payload =
      envelope && typeof envelope === "object" && "payload" in envelope
        ? envelope.payload
        : envelope;
    const raw = rawThreadMetadata(payload);
    const native = this.#metadata.stateSnapshot?.threads.find((thread) => thread.id === id);
    const classification = classifyThreadMetadata(raw, native, {
      spawnParentThreadIds: (this.#metadata.stateSnapshot?.spawnEdges ?? [])
        .filter((edge) => edge.childThreadId === id)
        .map((edge) => edge.parentThreadId),
    });
    if (raw.status === "missing" && native === undefined) {
      classification.visibility = "unresolved";
      classification.reasons.push("selected-structure-missing");
    }
    const prefix = parseSessionMetaBytes(
      catalog.summary.sourcePath,
      Buffer.from(JSON.stringify({ type: "session_meta", payload }) + "\n"),
    );
    const changed = storeValidatedCatalogClassification(
      this.#database,
      id,
      {
        version: CATALOG_EVIDENCE_VERSION,
        origin: "materialized",
        status: raw.status === "invalid" ? "invalid" : prefix.meta === null ? "missing" : "found",
        meta: prefix.meta,
        parentThreadIdHint: classification.parentThreadId,
        classification,
        freshness: "verified",
        validatedSha256: manifest.fingerprint.sha256,
      },
      { sourceRevision: catalog.sourceRevision, sourcePath: catalog.summary.sourcePath },
    );
    if (changed.length) {
      this.#publish({
        type: "library.updated",
        ids: changed,
        groupsChanged: true,
        revision: this.#nextRevision(),
      });
    }
    return classification.visibility !== "internal";
  }

  async prepareSessions(
    ids: readonly string[],
    priority: MaterializationPriority = "visible",
    owner?: string,
  ): Promise<PreparationResult[]> {
    const immediate = new Map<string, PreparationResult>();
    const pending: string[] = [];
    for (const id of new Set(ids)) {
      const catalog = catalogSession(this.#database, id);
      if (
        catalog === null ||
        (catalog.kind === "auxiliary" &&
          catalog.structuralEvidence?.classification?.visibility !== "unresolved")
      ) {
        immediate.set(id, { id, state: "failed", error: "Conversation not found." });
      } else if (
        priority !== "open" &&
        catalog.materialization === "ready" &&
        hasCachedSession(this.#database, id, CACHE_PARSER_VERSION)
      ) {
        immediate.set(id, { id, state: "ready", error: null });
      } else {
        if (
          catalog.materialization !== "ready" &&
          catalog.materialization !== "queued" &&
          catalog.materialization !== "loading"
        ) {
          setCatalogMaterialization(this.#database, id, "queued", null);
        }
        pending.push(id);
      }
    }
    const queued = await this.#materializationQueue.enqueue(pending, priority, owner);
    const queuedById = new Map(queued.map((result) => [result.id, result]));
    return ids.map(
      (id) =>
        immediate.get(id) ??
        queuedById.get(id) ?? {
          id,
          state: "failed",
          error: "Conversation materialization did not return a result.",
        },
    );
  }

  async ensureMaterialized(id: string): Promise<void> {
    const result = (await this.prepareSessions([id], "open", `open:${id}`))[0];
    if (result?.state !== "ready") {
      throw new Error(result?.error ?? "Conversation could not be materialized.");
    }
  }

  /** Normalization is ready independently of rich rendering; only the requested page enters this path. */
  async prepareTurnChunk(chunk: TurnChunk): Promise<TurnChunk> {
    if (chunk.turns.length === 0) {
      return chunk;
    }
    const ready = new Set(
      this.#database
        .prepare(
          `SELECT id FROM turns WHERE session_id = ? AND rich_revision IS NOT NULL AND id IN (${chunk.turns.map(() => "?").join(",")})`,
        )
        .all(chunk.sessionId, ...chunk.turns.map(({ id }) => id))
        .map((row) => String(row["id"])),
    );
    if (ready.size === chunk.turns.length) {
      return chunk;
    }
    const keys = chunk.turns.map(({ id }) => JSON.stringify([chunk.sessionId, chunk.revision, id]));
    const pending = new Set<Promise<void>>();
    const missing = chunk.turns.filter((turn, index) => {
      if (ready.has(turn.id)) {
        return false;
      }
      const existing = this.#richPreparations.get(keys[index]!);
      if (existing === undefined) {
        return true;
      }
      pending.add(existing);
      return false;
    });
    if (missing.length > 0) {
      const missingKeys = missing.map(({ id }) =>
        JSON.stringify([chunk.sessionId, chunk.revision, id]),
      );
      const preparation = this.#prepareTurnChunk({ ...chunk, turns: missing }).finally(() => {
        for (const key of missingKeys) {
          this.#richPreparations.delete(key);
        }
      });
      for (const key of missingKeys) {
        this.#richPreparations.set(key, preparation);
      }
      pending.add(preparation);
    }
    await Promise.all(pending);
    const revision = this.#database
      .prepare("SELECT revision FROM sessions WHERE id = ?")
      .get(chunk.sessionId)?.["revision"];
    if (revision !== chunk.revision) {
      throw new Error("The conversation changed during rich preparation; retry the page.");
    }
    return {
      ...chunk,
      turns: getCachedTurnsInRange(
        this.#database,
        chunk.sessionId,
        chunk.turns[0]!.index,
        chunk.turns.length,
      ),
    };
  }

  async #prepareTurnChunk(chunk: TurnChunk): Promise<void> {
    const summary = getCachedSessionSummary(this.#database, chunk.sessionId);
    if (summary === null || summary.revision !== chunk.revision) {
      throw new Error("The conversation changed before rich preparation.");
    }
    const check = this.#database.prepare(
      "SELECT rich_revision FROM turns WHERE session_id = ? AND id = ?",
    );
    const turns = chunk.turns.filter(
      ({ id }) => check.get(chunk.sessionId, id)?.["rich_revision"] == null,
    );
    if (turns.length === 0) {
      return;
    }
    const session: NormalizedSession = { summary, turns, rawEvents: [] };
    const evidenceRevision = this.#richEvidenceRevision(chunk.sessionId);
    if (turns.some(({ activities }) => activities.some(({ kind }) => kind === "tool"))) {
      await this.#attachGuardianReviews(session);
    }
    this.#enrichSubagents(session);
    await this.#prepareRichContent(session, evidenceRevision);
  }

  get retainedSourceState(): SessionCacheUpdater["retention"] {
    return this.#updater.retention;
  }

  cancelOwner(owner: string): void {
    this.#materializationQueue.cancelOwner(owner);
  }

  startDeepSearch(query: SearchQuery): DeepSearchJob {
    const id = randomUUID();
    const now = new Date().toISOString();
    const membership = searchMembershipFilter(this.#database, query, "c");
    const values = [query.scope, ...membership.values];
    const filters = [
      "scope = ?",
      catalogVisibilitySql("ordinary"),
      "materialization_state <> 'ready'",
      membership.sql,
    ];
    const sessionIds = this.#database
      .prepare(
        `SELECT id FROM session_catalog c WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC, id`,
      )
      .all(...values)
      .flatMap((row) => (typeof row["id"] === "string" ? [row["id"]] : []));
    let resultCount = 0;
    let countError: string | null = null;
    try {
      resultCount = this.#countSearchResults(this.#database, query);
    } catch (error) {
      countError = error instanceof Error ? error.message : String(error);
    }
    const job: DeepSearchJob = {
      id,
      scope: query.scope,
      query: query.query,
      state: countError === null ? (sessionIds.length === 0 ? "completed" : "queued") : "failed",
      total: sessionIds.length,
      completed: 0,
      failed: 0,
      resultCount,
      error: countError,
      createdAt: now,
      updatedAt: now,
    };
    this.#deepSearchJobs.set(id, job);
    this.#publish({ type: "search.updated", ids: [id], revision: this.#nextRevision() });
    if (sessionIds.length > 0 && countError === null) {
      void this.#runDeepSearch(id, query, sessionIds).catch((error: unknown) => {
        const current = this.#deepSearchJobs.get(id);
        if (current !== undefined && current.state !== "cancelled") {
          this.#deepSearchJobs.set(id, {
            ...current,
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
            updatedAt: new Date().toISOString(),
          });
          this.#publish({ type: "search.updated", ids: [id], revision: this.#nextRevision() });
        }
        this.#onError?.(error);
      });
    }
    return { ...job };
  }

  async #runDeepSearch(
    id: string,
    query: SearchQuery,
    sessionIds: readonly string[],
  ): Promise<void> {
    const owner = `search:${id}`;
    const queued = this.#deepSearchJobs.get(id);
    if (queued === undefined || queued.state === "cancelled") {
      return;
    }
    this.#deepSearchJobs.set(id, {
      ...queued,
      state: "running",
      updatedAt: new Date().toISOString(),
    });
    this.#publish({ type: "search.updated", ids: [id], revision: this.#nextRevision() });
    for (const sessionId of sessionIds) {
      const before = this.#deepSearchJobs.get(id);
      if (before === undefined || before.state === "cancelled") {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- Progress is persisted and published after each bounded materialization result.
      const result = (await this.prepareSessions([sessionId], "deep-search", owner))[0];
      const current = this.#deepSearchJobs.get(id);
      if (current === undefined) {
        return;
      }
      const failed = result?.state === "ready" ? current.failed : current.failed + 1;
      const completed = result?.state === "ready" ? current.completed + 1 : current.completed;
      const updated: DeepSearchJob = {
        ...current,
        completed,
        failed,
        updatedAt: new Date().toISOString(),
      };
      this.#deepSearchJobs.set(id, updated);
      this.#publish({ type: "search.updated", ids: [id], revision: this.#nextRevision() });
    }
    const current = this.#deepSearchJobs.get(id);
    if (current !== undefined && current.state !== "cancelled") {
      let terminal: DeepSearchJob;
      try {
        terminal = {
          ...current,
          state: "completed",
          resultCount: this.#countSearchResults(this.#database, query),
          updatedAt: new Date().toISOString(),
        };
      } catch (error) {
        terminal = {
          ...current,
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        };
      }
      this.#deepSearchJobs.set(id, terminal);
      this.#publish({ type: "search.updated", ids: [id], revision: this.#nextRevision() });
    }
  }

  getDeepSearch(id: string): DeepSearchJob | null {
    const job = this.#deepSearchJobs.get(id);
    return job === undefined ? null : { ...job };
  }

  cancelDeepSearch(id: string): boolean {
    const job = this.#deepSearchJobs.get(id);
    if (job === undefined) {
      return false;
    }
    this.#materializationQueue.cancelOwner(`search:${id}`);
    this.#deepSearchJobs.set(id, {
      ...job,
      state: "cancelled",
      updatedAt: new Date().toISOString(),
    });
    this.#publish({ type: "search.updated", ids: [id], revision: this.#nextRevision() });
    return true;
  }

  async #refreshCatalog(
    discovery: SourceDiscoveryResult,
    metadata: LiveMetadata,
    announce: boolean,
    changedSourcePaths?: readonly string[],
    catalogMetadata?: CatalogMetadataSnapshot,
    recoverySignal?: AbortSignal,
  ): Promise<void> {
    const readyBefore = new Map(
      this.#database
        .prepare(
          "SELECT id, source_revision FROM session_catalog WHERE materialization_state = 'ready'",
        )
        .all()
        .flatMap((row) =>
          typeof row["id"] === "string" && typeof row["source_revision"] === "string"
            ? [[row["id"], row["source_revision"]] as const]
            : [],
        ),
    );
    const previousParents = new Map(
      this.#database
        .prepare(
          "SELECT id, parent_thread_id FROM session_catalog WHERE parent_thread_id IS NOT NULL",
        )
        .all()
        .map((row) => [String(row["id"]), String(row["parent_thread_id"])]),
    );
    this.#metadata = metadata;
    const refreshed = await refreshLiveCatalog({
      database: this.#database,
      discovery,
      sessionIndexEntries: metadata.sessionIndexEntries,
      globalState: metadata.globalState,
      stateSnapshot: metadata.stateSnapshot,
      readPrefix: this.#readPrefix,
      readJsonl: this.#readJsonl,
      observeSource: this.#observeSource,
      changedSourcePaths,
      ...(catalogMetadata ? { catalogMetadata } : {}),
      ...(recoverySignal ? { recoveryBatch: true, signal: recoverySignal } : {}),
    });
    if (
      announce &&
      (refreshed.groupsChanged ||
        refreshed.changedIds.length > 0 ||
        refreshed.removedIds.length > 0)
    ) {
      this.#publish({
        type: "library.updated",
        ids: [...new Set([...refreshed.changedIds, ...refreshed.removedIds])].toSorted(),
        revision: this.#nextRevision(),
        ...(refreshed.groupsChanged ? { groupsChanged: true } : {}),
      });
    }
    const changedIds = new Set(refreshed.changedIds);
    const evidenceParents = new Set<string>();
    for (const id of [...refreshed.changedIds, ...refreshed.removedIds]) {
      const previousParent = previousParents.get(id);
      if (previousParent !== undefined) {
        evidenceParents.add(previousParent);
      }
    }
    for (const row of refreshed.rows) {
      if (changedIds.has(row.summary.id) && row.parentThreadId !== null) {
        evidenceParents.add(row.parentThreadId);
      }
    }
    for (const parentId of evidenceParents) {
      this.#database
        .prepare("UPDATE turns SET rich_revision = NULL WHERE session_id = ?")
        .run(parentId);
      if (announce && readyBefore.has(parentId)) {
        this.#publish({ type: "session.updated", ids: [parentId], revision: this.#nextRevision() });
      }
    }
    const diagnostics = [...metadata.diagnostics, ...refreshed.diagnostics];
    if (announce && diagnostics.length > 0) {
      this.#publish({
        type: "diagnostic.updated",
        ids: diagnostics.map(({ id }) => id),
        revision: this.#nextRevision(),
      });
    }
  }

  async #reconcileAll(announce: boolean): Promise<void> {
    const current = await this.#readMetadata(
      this.#codexHome,
      join(this.#cacheDir, "catalog-snapshots"),
    );
    if (this.#closed) {
      return;
    }
    const usableNative =
      current.freshness.state !== "unavailable" &&
      (current.threadsComplete || current.threads.length > 0);
    if (usableNative) {
      this.#recoveryController?.abort();
    }
    this.#catalogMetadata = current;
    if (usableNative) {
      this.#recoveryState = "idle";
    }
    const metadata: LiveMetadata = {
      sessionIndexEntries: current.sessionIndex,
      globalState: current.globalState,
      stateSnapshot:
        current.stateAuthority === "unavailable"
          ? null
          : {
              threads: current.threads.map((thread) => ({
                ...thread,
                rolloutPath: thread.rolloutPath ? resolve(this.#codexHome, thread.rolloutPath) : "",
              })),
              threadsComplete: current.threadsComplete,
              projects: current.projects,
              sections: current.sections,
              spawnEdges: current.spawnEdges,
              attachments: current.attachments,
              readReceipts: current.readReceipts,
              ...(current.capabilities ? { capabilities: current.capabilities } : {}),
            },
      diagnostics: current.diagnostics,
    };
    await this.#refreshCatalog(
      { rollouts: [], metadata: current.sources, diagnostics: [] },
      metadata,
      announce,
      [],
      current,
    );
    if (
      !usableNative &&
      this.#recoveryState !== "complete" &&
      (this.#recoveryState !== "running" || this.#recoveryController?.signal.aborted)
    ) {
      this.#startRecovery();
    }
  }

  async #processBatch(batch: SourceWatchBatch): Promise<void> {
    if (batch.changes.some((change) => change.source !== "rollout")) {
      await this.#reconcileAll(true);
    }
  }

  #startRecovery(): void {
    const controller = new AbortController();
    this.#recoveryController = controller;
    const { signal } = controller;
    this.#recoveryState = "running";
    this.#recovery = (async () => {
      await yieldToEventLoop();
      for await (const rollouts of this.#recoverSources(this.#codexHome, signal)) {
        signal.throwIfAborted();
        await this.#enqueue(async () => {
          if (signal.aborted) {
            return;
          }
          try {
            await this.#refreshCatalog(
              { rollouts, metadata: this.#catalogMetadata!.sources, diagnostics: [] },
              this.#metadata,
              true,
              rollouts.map(({ path }) => path),
              undefined,
              signal,
            );
          } catch (error) {
            if (!signal.aborted) {
              throw error;
            }
          }
        });
        await yieldToEventLoop();
      }
      signal.throwIfAborted();
      this.#recoveryState = "complete";
      this.#publish({
        type: "library.updated",
        ids: [],
        groupsChanged: true,
        revision: this.#nextRevision(),
      });
    })().catch((error: unknown) => {
      if (signal.aborted) {
        return;
      }
      this.#recoveryState = "failed";
      this.#onError?.(error);
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const scheduled = this.#queue.then(operation, operation);
    this.#queue = scheduled.catch((error: unknown) => {
      this.#onError?.(error);
    });
    return scheduled;
  }

  #scheduleBatchDrain(): void {
    if (
      this.#closed ||
      !this.#started ||
      this.#batchDrainScheduled ||
      this.#pendingBatches.length === 0
    ) {
      return;
    }
    this.#batchDrainScheduled = true;
    const draining = this.#enqueue(async () => {
      const batch = coalesceSourceWatchBatches(this.#pendingBatches.splice(0));
      if (batch !== null) {
        await this.#processBatch(batch);
      }
    });
    void draining.then(
      () => {
        this.#batchDrainScheduled = false;
        this.#scheduleBatchDrain();
        return undefined;
      },
      () => {
        this.#batchDrainScheduled = false;
        this.#scheduleBatchDrain();
        return undefined;
      },
    );
  }

  reconcileNow(_reason = "manual"): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }
    return this.#enqueue(() => this.#reconcileAll(this.#started));
  }

  readNativeHistory(
    lineage: ResolvedRolloutLineage,
    source: SourceGeneration,
    query: HistoryPageQuery | HistoryItemQuery,
    options: RepositoryRequestOptions = {},
  ) {
    const ref = lineage.segments.at(-1)?.ref;
    const current = ref ? catalogSession(this.#database, ref.stableThreadId) : null;
    if (
      current?.summary.sourcePath != null &&
      resolve(current.summary.sourcePath) !== resolve(source.sourcePath)
    ) {
      return Promise.resolve(unavailableNativeHistory(source, "native.catalog_selection_changed"));
    }
    return this.#nativeHistory.read(lineage, source, query, options.signal);
  }

  #historySelection(id: string) {
    const record = catalogSession(this.#database, id);
    if (!record) {
      throw new Error("Session not found");
    }
    const references = listAllCatalogSessions(this.#database).flatMap((entry) => {
      if (!entry.summary.sourcePath) {
        return [];
      }
      const ref = rolloutRefFromSource(
        entry.summary.sourcePath,
        entry.structuralEvidence?.meta ?? null,
      );
      return [
        {
          ...ref,
          stableThreadId: entry.summary.id,
          physicalRolloutId: ref.physicalRolloutId?.startsWith("path:")
            ? entry.summary.id
            : ref.physicalRolloutId,
        },
      ];
    });
    const ref = references.find((entry) => entry.stableThreadId === id);
    if (!ref) {
      throw new Error("rollout.source_unresolved");
    }
    return { ref, references, sourceRevision: record.sourceRevision };
  }

  async getHistoryPage(
    id: string,
    query: HistoryPageQuery,
    options: RepositoryRequestOptions = {},
  ) {
    const release = this.#materializationQueue.holdSelected();
    try {
      const selection = this.#historySelection(id);
      const result = await this.#historyPager.read(
        selection.ref,
        selection.references,
        query,
        options.signal,
        selection.sourceRevision,
      );
      const current = catalogSession(this.#database, id);
      if (
        current?.summary.sourcePath !== selection.ref.sourcePath ||
        current.sourceRevision !== selection.sourceRevision
      ) {
        throw new HistoryReloadError("history.selection_changed");
      }
      return result;
    } finally {
      release();
    }
  }

  async getTurnItems(id: string, query: HistoryItemQuery, options: RepositoryRequestOptions = {}) {
    const release = this.#materializationQueue.holdSelected();
    try {
      const selection = this.#historySelection(id);
      const result = await this.#historyPager.readItems(
        selection.ref,
        selection.references,
        query,
        options.signal,
        selection.sourceRevision,
      );
      const current = catalogSession(this.#database, id);
      if (
        current?.summary.sourcePath !== selection.ref.sourcePath ||
        current.sourceRevision !== selection.sourceRevision
      ) {
        throw new HistoryReloadError("history.selection_changed");
      }
      return result;
    } finally {
      release();
    }
  }

  async start(): Promise<void> {
    if (this.#started || this.#watcher !== null) {
      throw new Error("The live reconciler has already been started.");
    }
    if (this.#closed) {
      throw new Error("A closed live reconciler cannot be restarted.");
    }
    this.#watcher = this.#watch({
      codexHome: this.#codexHome,
      metadataOnly: true,
      debounceMs: this.#debounceMs,
      onBatch: (batch) => {
        const historyChanged = batch.changes.some(
          (change) => change.source === "history-database" || change.source === "history-wal",
        );
        if (batch.changes.length > 0) {
          this.#nativeHistory.invalidate(historyChanged);
        }
        if (historyChanged) {
          const ids = this.#nativeHistory.selectedThreadIds();
          if (ids.length > 0) {
            this.#publish({ type: "session.updated", ids, revision: this.#nextRevision() });
          }
        }
        batch = {
          ...batch,
          changes: batch.changes.filter(
            (change) => change.source !== "history-database" && change.source !== "history-wal",
          ),
        };
        if (batch.changes.length === 0) {
          return;
        }
        if (batch.changes.some((change) => change.source !== "rollout")) {
          this.#recoveryController?.abort();
        }
        this.#pendingBatches.push(batch);
        this.#scheduleBatchDrain();
      },
      onError: (error) => {
        this.#onError?.(error);
        if (this.#started) {
          void this.reconcileNow("watcher-error");
        }
      },
    });
    const watcherReady = this.#watcher.ready;
    await this.#reconcileAll(false);
    if (this.#closed) {
      return;
    }
    this.#started = true;
    this.#scheduleBatchDrain();
    void watcherReady.then(() => undefined).catch((error: unknown) => this.#onError?.(error));
    this.#interval = setInterval(() => {
      void this.reconcileNow("periodic").catch((error: unknown) => {
        this.#onError?.(error);
      });
    }, this.#reconciliationIntervalMs);
    this.#interval.unref();
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#faviconController.abort();
    this.#faviconQueue.length = 0;
    await Promise.allSettled(this.#faviconTasks);
    await this.#historyPager.close();
    await this.#rolloutStore.close();
    await this.#nativeHistory.close();
    this.#recoveryController?.abort();
    const materializationClosing = this.#materializationQueue.close();
    if (this.#interval !== null) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
    await this.#watcher?.close();
    await this.#queue;
    await this.#recovery;
    await materializationClosing;
    await Promise.allSettled(this.#richPreparations.values());
    this.#updater.clear();
    this.#watcher = null;
  }
}
