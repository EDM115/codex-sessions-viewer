import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import type { DeepSearchJob, PreparationResult } from "../../shared/types/library.ts";
import type { SearchQuery, ViewerInvalidation } from "../../shared/types/repository.ts";
import {
  catalogSession,
  listCatalogAuxiliaryChildren,
  listCatalogChildren,
  setCatalogMaterialization,
} from "../cache/catalogStore.ts";
import { getCachedSession, updateCachedSessionRichContent } from "../cache/conversationStore.ts";
import { searchCachedSessions } from "../cache/searchStore.ts";
import {
  getSourceManifestEntry,
  SessionCacheUpdater,
  type StableJsonlReader,
} from "../cache/sourceManifest.ts";
import { prepareConversationForExport } from "../export/prepareConversation.ts";
import {
  discoverSources,
  type DiscoveredRolloutSource,
  type SourceDiscoveryResult,
} from "../ingestion/discoverSources.ts";
import { readStableJsonl } from "../ingestion/jsonlStream.ts";
import {
  watchSources,
  type SourceChange,
  type SourceWatchBatch,
  type SourceWatcher,
  type WatchSourcesOptions,
} from "../ingestion/watchSources.ts";
import { readGlobalState, type GlobalStateMetadata } from "../metadata/globalState.ts";
import { readSessionIndex, type SessionIndexEntry } from "../metadata/sessionIndex.ts";
import {
  readRetainedStateSnapshot,
  snapshotStateDatabase,
  type StateMetadataSnapshot,
} from "../metadata/stateSnapshot.ts";
import {
  attachGuardianEvidence,
  parseGuardianTurn,
  type GuardianReview,
} from "../normalization/guardianEvidence.ts";
import type { NormalizedSession } from "../normalization/normalizeSession.ts";
import { enrichSubagentActivities } from "../normalization/subagentTopology.ts";
import { refreshLiveCatalog } from "./catalogBuilder.ts";
import { InvalidationBus } from "./invalidationBus.ts";
import { MaterializationQueue, type MaterializationPriority } from "./materializationQueue.ts";

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
  bus: InvalidationBus;
  cacheDir: string;
  codexHome: string;
  database: DatabaseSync;
  debounceMs?: number | undefined;
  reconciliationIntervalMs?: number | undefined;
  readJsonl?: StableJsonlReader | undefined;
  fetchFavicons?: boolean | undefined;
  watch?: ((options: WatchSourcesOptions) => SourceWatcher) | undefined;
  onError?: ((error: unknown) => void) | undefined;
}

function changedTurnIds(before: NormalizedSession | null, after: NormalizedSession): string[] {
  if (before === null) {
    return after.turns.map(({ id }) => id);
  }
  const previous = new Map(before.turns.map((turn) => [turn.id, JSON.stringify(turn)]));
  const currentIds = new Set(after.turns.map(({ id }) => id));
  return [
    ...after.turns
      .filter((turn) => previous.get(turn.id) !== JSON.stringify(turn))
      .map(({ id }) => id),
    ...before.turns.filter(({ id }) => !currentIds.has(id)).map(({ id }) => id),
  ];
}

async function loadMetadata(
  discovery: SourceDiscoveryResult,
  cacheDir: string,
  freshStateSnapshot: boolean,
): Promise<LiveMetadata> {
  const diagnostics: ViewerDiagnostic[] = [];
  let sessionIndexEntries: SessionIndexEntry[] = [];
  let globalState: GlobalStateMetadata = { projects: [], pinnedThreadIds: [] };
  let stateSnapshot: StateMetadataSnapshot | null = null;
  if (discovery.metadata.sessionIndex !== null) {
    const result = await readSessionIndex(discovery.metadata.sessionIndex);
    sessionIndexEntries = result.entries;
    diagnostics.push(...result.diagnostics);
  }
  if (discovery.metadata.globalState !== null) {
    const result = await readGlobalState(discovery.metadata.globalState);
    globalState = result.metadata;
    diagnostics.push(...result.diagnostics);
  }
  if (discovery.metadata.stateDatabase !== null) {
    const snapshotRoot = join(cacheDir, "state-snapshots");
    const result = freshStateSnapshot
      ? await snapshotStateDatabase({
          sourceDatabase: discovery.metadata.stateDatabase,
          sourceWal: discovery.metadata.stateWal ?? `${discovery.metadata.stateDatabase}-wal`,
          snapshotRoot,
        })
      : await readRetainedStateSnapshot(snapshotRoot);
    stateSnapshot = result.metadata;
    diagnostics.push(...result.diagnostics);
  }
  return { sessionIndexEntries, globalState, stateSnapshot, diagnostics };
}

export class LiveReconciler {
  readonly #bus: InvalidationBus;
  readonly #cacheDir: string;
  readonly #codexHome: string;
  readonly #database: DatabaseSync;
  readonly #debounceMs: number | undefined;
  readonly #reconciliationIntervalMs: number;
  readonly #fetchFavicons: boolean;
  readonly #watch: (options: WatchSourcesOptions) => SourceWatcher;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #updater: SessionCacheUpdater;
  readonly #readJsonl: StableJsonlReader;
  readonly #materializationQueue: MaterializationQueue;
  readonly #knownFaviconOrigins = new Map<string, string>();
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
    const interval = options.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
    if (!Number.isSafeInteger(interval) || interval < 1_000) {
      throw new RangeError("reconciliationIntervalMs must be a safe integer of at least 1000");
    }
    this.#bus = options.bus;
    this.#cacheDir = options.cacheDir;
    this.#codexHome = resolve(options.codexHome);
    this.#database = options.database;
    this.#debounceMs = options.debounceMs;
    this.#reconciliationIntervalMs = interval;
    this.#fetchFavicons = options.fetchFavicons ?? true;
    this.#watch = options.watch ?? watchSources;
    this.#onError = options.onError;
    this.#readJsonl = options.readJsonl ?? readStableJsonl;
    this.#updater = new SessionCacheUpdater(this.#database, {
      retainLiveSources: false,
      readJsonl: options.readJsonl,
    });
    this.#materializationQueue = new MaterializationQueue((id, priority) =>
      this.#materialize(id, priority),
    );
    for (const row of this.#database.prepare("SELECT origin FROM favicons").all()) {
      if (typeof row["origin"] === "string") {
        this.#knownFaviconOrigins.set(this.#faviconKey(row["origin"]), row["origin"]);
      }
    }
  }

  get codexHome(): string {
    return this.#codexHome;
  }

  faviconOrigin(key: string): string | null {
    return this.#knownFaviconOrigins.get(key) ?? null;
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

  async #prepareRichContent(session: NormalizedSession): Promise<NormalizedSession> {
    const prepared = await prepareConversationForExport(this.#database, session, {
      mediaRoot: join(this.#cacheDir, "assets"),
      faviconRoot: join(this.#cacheDir, "favicons"),
      offline: !this.#fetchFavicons,
      mode: "live",
    });
    updateCachedSessionRichContent(this.#database, prepared.conversation);
    for (const origin of prepared.faviconOrigins) {
      this.#knownFaviconOrigins.set(this.#faviconKey(origin), origin);
    }
    for (const favicon of prepared.faviconResults) {
      if (favicon.backgroundRefresh === null) {
        continue;
      }
      void favicon.backgroundRefresh
        .then(() => {
          if (!this.#closed) {
            this.#publish({
              type: "session.updated",
              ids: [session.summary.id],
              revision: this.#nextRevision(),
            });
          }
          return undefined;
        })
        .catch((error: unknown) => this.#onError?.(error));
    }
    return prepared.conversation;
  }

  async #guardianReviews(parentThreadId: string): Promise<GuardianReview[]> {
    const reviews: GuardianReview[] = [];
    for (const guardian of listCatalogAuxiliaryChildren(this.#database, parentThreadId)) {
      // oxlint-disable-next-line no-await-in-loop -- Guardian evidence is bounded to auxiliary children of the opened conversation.
      const result = await this.#readJsonl(guardian.summary.sourcePath, { start: 0 });
      if (result.read.status !== "stable") {
        continue;
      }
      const review = parseGuardianTurn(result.records);
      if (review !== null && review.parentThreadId === parentThreadId) {
        reviews.push(review);
      }
    }
    return reviews;
  }

  async #attachGuardianReviews(session: NormalizedSession): Promise<void> {
    const reviews = await this.#guardianReviews(session.summary.id);
    if (reviews.length === 0) {
      return;
    }
    attachGuardianEvidence(
      session.turns.flatMap(({ activities }) =>
        activities.filter((activity) => activity.kind === "tool"),
      ),
      reviews,
    );
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
    force: boolean,
    announce: boolean,
  ): Promise<PreparationResult> {
    const manifest = getSourceManifestEntry(this.#database, source.path);
    const before =
      announce && manifest?.sessionId
        ? getCachedSession(this.#database, manifest.sessionId, { includeRawEvents: false })
        : null;
    const result = await this.#updater.update(source, {
      force,
      sessionIndexEntries: this.#metadata.sessionIndexEntries,
      stateSnapshot: this.#metadata.stateSnapshot,
    });
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
        getCachedSession(this.#database, result.sessionId) !== null
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
    let after = getCachedSession(this.#database, result.sessionId, { includeRawEvents: false });
    if (after === null) {
      return {
        id: expectedSessionId,
        state: "failed",
        error: "The normalized conversation was not committed to the viewer cache.",
      };
    }
    try {
      await this.#attachGuardianReviews(after);
      this.#enrichSubagents(after);
      after = await this.#prepareRichContent(after);
    } catch (error) {
      this.#onError?.(error);
    }
    if (!announce) {
      return { id: expectedSessionId, state: "ready", error: null };
    }
    const turnIds = changedTurnIds(before, after);
    this.#publish({
      type: "library.updated",
      ids: [result.sessionId],
      revision: after.summary.revision,
    });
    this.#publish({
      type: "session.updated",
      ids: [result.sessionId, ...turnIds],
      revision: after.summary.revision,
    });
    return { id: expectedSessionId, state: "ready", error: null };
  }

  async #materialize(id: string, _priority: MaterializationPriority): Promise<PreparationResult> {
    const catalog = catalogSession(this.#database, id);
    if (catalog === null || catalog.kind === "auxiliary") {
      return { id, state: "failed", error: "Conversation not found." };
    }
    if (catalog.materialization === "ready" && getCachedSession(this.#database, id) !== null) {
      return { id, state: "ready", error: null };
    }
    setCatalogMaterialization(this.#database, id, "loading", null);
    let result: PreparationResult;
    try {
      result = await this.#updateSource(
        { path: catalog.summary.sourcePath, scope: catalog.summary.scope },
        id,
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
    setCatalogMaterialization(
      this.#database,
      id,
      result.state === "ready" ? "ready" : "failed",
      result.error,
    );
    this.#publish({
      type: "library.updated",
      ids: [id],
      revision: this.#nextRevision(),
    });
    return result;
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
      if (catalog === null || catalog.kind === "auxiliary") {
        immediate.set(id, { id, state: "failed", error: "Conversation not found." });
      } else if (
        catalog.materialization === "ready" &&
        getCachedSession(this.#database, id) !== null
      ) {
        immediate.set(id, { id, state: "ready", error: null });
      } else {
        if (catalog.materialization !== "queued" && catalog.materialization !== "loading") {
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

  cancelOwner(owner: string): void {
    this.#materializationQueue.cancelOwner(owner);
  }

  startDeepSearch(query: SearchQuery): DeepSearchJob {
    const id = randomUUID();
    const now = new Date().toISOString();
    const values: string[] = [query.scope];
    const filters = ["scope = ?", "session_kind = 'root'", "materialization_state <> 'ready'"];
    if (query.projectId !== undefined) {
      filters.push("project_id = ?");
      values.push(query.projectId);
    }
    const sessionIds = this.#database
      .prepare(
        `SELECT id FROM session_catalog WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC, id`,
      )
      .all(...values)
      .flatMap((row) => (typeof row["id"] === "string" ? [row["id"]] : []));
    const job: DeepSearchJob = {
      id,
      scope: query.scope,
      query: query.query,
      state: sessionIds.length === 0 ? "completed" : "queued",
      total: sessionIds.length,
      completed: 0,
      failed: 0,
      resultCount: searchCachedSessions(this.#database, { ...query, cursor: undefined, limit: 1 })
        .total,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#deepSearchJobs.set(id, job);
    this.#publish({ type: "search.updated", ids: [id], revision: this.#nextRevision() });
    if (sessionIds.length > 0) {
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
        resultCount: searchCachedSessions(this.#database, {
          ...query,
          cursor: undefined,
          limit: 1,
        }).total,
        updatedAt: new Date().toISOString(),
      };
      this.#deepSearchJobs.set(id, updated);
      this.#publish({ type: "search.updated", ids: [id], revision: this.#nextRevision() });
    }
    const current = this.#deepSearchJobs.get(id);
    if (current !== undefined && current.state !== "cancelled") {
      this.#deepSearchJobs.set(id, {
        ...current,
        state: "completed",
        updatedAt: new Date().toISOString(),
      });
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

  async #reconcileAll(announce: boolean, freshStateSnapshot = true): Promise<void> {
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
    const discovery = await discoverSources(this.#codexHome);
    const metadata = await loadMetadata(discovery, this.#cacheDir, freshStateSnapshot);
    this.#metadata = metadata;
    const refreshed = await refreshLiveCatalog({
      database: this.#database,
      discovery,
      sessionIndexEntries: metadata.sessionIndexEntries,
      globalState: metadata.globalState,
      stateSnapshot: metadata.stateSnapshot,
    });
    if (announce && (refreshed.rows.length > 0 || refreshed.removedIds.length > 0)) {
      this.#publish({
        type: "library.updated",
        ids: [...refreshed.rows.map(({ summary }) => summary.id), ...refreshed.removedIds],
        revision: this.#nextRevision(),
      });
    }
    const hotIds = announce
      ? refreshed.rows
          .filter(
            (row) =>
              row.kind !== "auxiliary" &&
              readyBefore.has(row.summary.id) &&
              readyBefore.get(row.summary.id) !== row.sourceRevision,
          )
          .map(({ summary }) => summary.id)
      : [];
    if (hotIds.length > 0) {
      void this.prepareSessions(hotIds, "visible", "watcher:hot").catch((error: unknown) => {
        this.#onError?.(error);
      });
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

  async #processBatch(batch: SourceWatchBatch): Promise<void> {
    void batch;
    await this.#reconcileAll(true);
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

  async start(): Promise<void> {
    if (this.#started || this.#watcher !== null) {
      throw new Error("The live reconciler has already been started.");
    }
    if (this.#closed) {
      throw new Error("A closed live reconciler cannot be restarted.");
    }
    this.#watcher = this.#watch({
      codexHome: this.#codexHome,
      debounceMs: this.#debounceMs,
      onBatch: (batch) => {
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
    await this.#reconcileAll(false, false);
    if (this.#closed) {
      return;
    }
    this.#started = true;
    this.#scheduleBatchDrain();
    void watcherReady
      .then(() => this.reconcileNow("watcher-ready"))
      .catch((error: unknown) => this.#onError?.(error));
    void this.reconcileNow("fresh-state-snapshot").catch((error: unknown) => {
      this.#onError?.(error);
    });
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
    const materializationClosing = this.#materializationQueue.close();
    if (this.#interval !== null) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
    await this.#watcher?.close();
    await this.#queue;
    await materializationClosing;
    this.#watcher = null;
  }
}
