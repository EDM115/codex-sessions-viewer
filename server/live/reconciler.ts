import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import type { DeepSearchJob, PreparationResult } from "../../shared/types/library.ts";
import type { SearchQuery, ViewerInvalidation, TurnChunk } from "../../shared/types/repository.ts";
import {
  catalogSession,
  listCatalogAuxiliaryChildren,
  listCatalogChildren,
  setCatalogMaterialization,
} from "../cache/catalogStore.ts";
import { hasCachedSession, updateCachedSessionRichContent } from "../cache/conversationStore.ts";
import { getCachedSessionSummary, getCachedTurnsInRange } from "../cache/repositoryStore.ts";
import { countCachedSearchResults } from "../cache/searchStore.ts";
import {
  CACHE_PARSER_VERSION,
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
  observeSessionMetaSource,
  readSessionMetaPrefix,
  type SessionMetaPrefixObservation,
} from "../ingestion/sessionMetaPrefix.ts";
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
  guardianActionHash,
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
  discover?: typeof discoverSources | undefined;
  readPrefix?: typeof readSessionMetaPrefix | undefined;
  observeSource?: ((path: string) => Promise<SessionMetaPrefixObservation>) | undefined;
  readSessionIndex?: typeof readSessionIndex | undefined;
  readGlobalState?: typeof readGlobalState | undefined;
  snapshotStateDatabase?: typeof snapshotStateDatabase | undefined;
  readRetainedStateSnapshot?: typeof readRetainedStateSnapshot | undefined;
  countSearchResults?: typeof countCachedSearchResults | undefined;
  fetchFavicons?: boolean | undefined;
  trustedMediaRoots?: readonly string[] | undefined;
  watch?: ((options: WatchSourcesOptions) => SourceWatcher) | undefined;
  onError?: ((error: unknown) => void) | undefined;
}

interface LiveMetadataReaders {
  readSessionIndex: typeof readSessionIndex;
  readGlobalState: typeof readGlobalState;
  snapshotStateDatabase: typeof snapshotStateDatabase;
  readRetainedStateSnapshot: typeof readRetainedStateSnapshot;
}

async function loadMetadata(
  discovery: SourceDiscoveryResult,
  cacheDir: string,
  freshStateSnapshot: boolean,
  readers: LiveMetadataReaders,
): Promise<LiveMetadata> {
  const diagnostics: ViewerDiagnostic[] = [];
  let sessionIndexEntries: SessionIndexEntry[] = [];
  let globalState: GlobalStateMetadata = { projects: [], pinnedThreadIds: [] };
  let stateSnapshot: StateMetadataSnapshot | null = null;
  if (discovery.metadata.sessionIndex !== null) {
    const result = await readers.readSessionIndex(discovery.metadata.sessionIndex);
    sessionIndexEntries = result.entries;
    diagnostics.push(...result.diagnostics);
  }
  if (discovery.metadata.globalState !== null) {
    const result = await readers.readGlobalState(discovery.metadata.globalState);
    globalState = result.metadata;
    diagnostics.push(...result.diagnostics);
  }
  if (discovery.metadata.stateDatabase !== null) {
    const snapshotRoot = join(cacheDir, "state-snapshots");
    const result = freshStateSnapshot
      ? await readers.snapshotStateDatabase({
          sourceDatabase: discovery.metadata.stateDatabase,
          sourceWal: discovery.metadata.stateWal ?? `${discovery.metadata.stateDatabase}-wal`,
          snapshotRoot,
        })
      : await readers.readRetainedStateSnapshot(snapshotRoot);
    stateSnapshot = result.metadata;
    diagnostics.push(...result.diagnostics);
  }
  return { sessionIndexEntries, globalState, stateSnapshot, diagnostics };
}

async function loadChangedMetadata(
  discovery: SourceDiscoveryResult,
  cacheDir: string,
  previous: LiveMetadata,
  changedSources: ReadonlySet<SourceChange["source"]>,
  readers: LiveMetadataReaders,
): Promise<LiveMetadata> {
  let sessionIndexEntries = previous.sessionIndexEntries;
  let globalState = previous.globalState;
  let stateSnapshot = previous.stateSnapshot;
  const diagnostics: ViewerDiagnostic[] = [];
  if (changedSources.has("session-index")) {
    if (discovery.metadata.sessionIndex === null) {
      sessionIndexEntries = [];
    } else {
      const result = await readers.readSessionIndex(discovery.metadata.sessionIndex);
      sessionIndexEntries = result.entries;
      diagnostics.push(...result.diagnostics);
    }
  }
  if (changedSources.has("global-state")) {
    if (discovery.metadata.globalState === null) {
      globalState = { projects: [], pinnedThreadIds: [] };
    } else {
      const result = await readers.readGlobalState(discovery.metadata.globalState);
      globalState = result.metadata;
      diagnostics.push(...result.diagnostics);
    }
  }
  if (changedSources.has("state-database") || changedSources.has("state-wal")) {
    if (discovery.metadata.stateDatabase === null) {
      stateSnapshot = null;
    } else {
      const result = await readers.snapshotStateDatabase({
        sourceDatabase: discovery.metadata.stateDatabase,
        sourceWal: discovery.metadata.stateWal ?? `${discovery.metadata.stateDatabase}-wal`,
        snapshotRoot: join(cacheDir, "state-snapshots"),
      });
      stateSnapshot = result.metadata;
      diagnostics.push(...result.diagnostics);
    }
  }
  return { sessionIndexEntries, globalState, stateSnapshot, diagnostics };
}

function sourcePathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function discoveryAfterBatch(
  previous: SourceDiscoveryResult,
  batch: SourceWatchBatch,
): SourceDiscoveryResult {
  const rollouts = new Map(previous.rollouts.map((source) => [sourcePathKey(source.path), source]));
  const metadata = { ...previous.metadata };
  const metadataKeys = {
    "global-state": "globalState",
    "session-index": "sessionIndex",
    "state-database": "stateDatabase",
    "state-wal": "stateWal",
  } as const;
  for (const change of batch.changes) {
    if (change.source === "rollout") {
      const key = sourcePathKey(change.path);
      if (change.kind === "removed") {
        rollouts.delete(key);
      } else {
        rollouts.set(key, { path: resolve(change.path), scope: change.scope });
      }
      continue;
    }
    metadata[metadataKeys[change.source]] = change.kind === "removed" ? null : resolve(change.path);
  }
  return {
    rollouts: [...rollouts.values()].toSorted((left, right) => left.path.localeCompare(right.path)),
    metadata,
    diagnostics: previous.diagnostics,
  };
}

export class LiveReconciler {
  readonly #bus: InvalidationBus;
  readonly #cacheDir: string;
  readonly #codexHome: string;
  readonly #database: DatabaseSync;
  readonly #debounceMs: number | undefined;
  readonly #reconciliationIntervalMs: number;
  readonly #fetchFavicons: boolean;
  readonly #trustedMediaRoots: readonly string[];
  readonly #watch: (options: WatchSourcesOptions) => SourceWatcher;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #updater: SessionCacheUpdater;
  readonly #readJsonl: StableJsonlReader;
  readonly #discover: typeof discoverSources;
  readonly #readPrefix: typeof readSessionMetaPrefix;
  readonly #observeSource: (path: string) => Promise<SessionMetaPrefixObservation>;
  readonly #metadataReaders: LiveMetadataReaders;
  readonly #countSearchResults: typeof countCachedSearchResults;
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
  #discovery: SourceDiscoveryResult | null = null;
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
    this.#trustedMediaRoots = options.trustedMediaRoots ?? [join(this.#codexHome, "attachments")];
    this.#watch = options.watch ?? watchSources;
    this.#onError = options.onError;
    this.#readJsonl = options.readJsonl ?? readStableJsonl;
    this.#discover = options.discover ?? discoverSources;
    this.#readPrefix = options.readPrefix ?? readSessionMetaPrefix;
    this.#observeSource = options.observeSource ?? observeSessionMetaSource;
    this.#metadataReaders = {
      readSessionIndex: options.readSessionIndex ?? readSessionIndex,
      readGlobalState: options.readGlobalState ?? readGlobalState,
      snapshotStateDatabase: options.snapshotStateDatabase ?? snapshotStateDatabase,
      readRetainedStateSnapshot: options.readRetainedStateSnapshot ?? readRetainedStateSnapshot,
    };
    this.#countSearchResults = options.countSearchResults ?? countCachedSearchResults;
    this.#updater = new SessionCacheUpdater(this.#database, {
      maxRetainedSources: 4,
      maxRetainedBytes: 64 * 1024 * 1024,
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
      offline: !this.#fetchFavicons,
      mode: "live",
      trustedMediaRoots: this.#trustedMediaRoots,
    });
    if (evidenceRevision !== this.#richEvidenceRevision(session.summary.id)) {
      throw new Error("The conversation evidence changed during rich preparation.");
    }
    updateCachedSessionRichContent(this.#database, prepared.conversation);
    for (const origin of prepared.faviconOrigins) {
      this.#knownFaviconOrigins.set(this.#faviconKey(origin), origin);
    }
    for (const favicon of prepared.faviconResults) {
      if (favicon.backgroundRefresh === null) {
        continue;
      }
      void favicon.backgroundRefresh
        .then((resolution) => {
          if (!this.#closed && resolution.status === "available") {
            this.#publish({
              type: "favicon.updated",
              ids: [favicon.origin],
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
    const count = this.#database.prepare(
      "SELECT count(*) AS count FROM activities WHERE session_id = ? AND guardian_input_hash = ?",
    );
    const uniqueReviews = reviews.filter(
      (review) =>
        count.get(session.summary.id, guardianActionHash(review.reviewedAction))?.["count"] === 1,
    );
    attachGuardianEvidence(
      session.turns.flatMap(({ activities }) =>
        activities.filter((activity) => activity.kind === "tool"),
      ),
      uniqueReviews,
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
    if (result.status === "stale-catalog") {
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
      if (catalog === null || catalog.kind === "auxiliary") {
        return { id, state: "failed", error: "Conversation not found." };
      }
      if (
        catalog.materialization === "ready" &&
        hasCachedSession(this.#database, id, CACHE_PARSER_VERSION)
      ) {
        return { id, state: "ready", error: null };
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
    if (latest !== null && latest.kind !== "auxiliary" && latest.materialization === "loading") {
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
        hasCachedSession(this.#database, id, CACHE_PARSER_VERSION)
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
    const values: string[] = [query.scope];
    const filters = [
      "scope = ?",
      "session_kind <> 'auxiliary'",
      "materialization_state <> 'ready'",
    ];
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
    this.#discovery = discovery;
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
    });
    if (announce && (refreshed.changedIds.length > 0 || refreshed.removedIds.length > 0)) {
      this.#publish({
        type: "library.updated",
        ids: [...new Set([...refreshed.changedIds, ...refreshed.removedIds])].toSorted(),
        revision: this.#nextRevision(),
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
    const hotIds = announce
      ? refreshed.rows
          .filter(
            (row) =>
              row.kind !== "auxiliary" &&
              changedIds.has(row.summary.id) &&
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

  async #reconcileAll(announce: boolean, freshStateSnapshot = true): Promise<void> {
    const discovery = await this.#discover(this.#codexHome);
    const metadata = await loadMetadata(
      discovery,
      this.#cacheDir,
      freshStateSnapshot,
      this.#metadataReaders,
    );
    await this.#refreshCatalog(discovery, metadata, announce);
  }

  async #processBatch(batch: SourceWatchBatch): Promise<void> {
    if (this.#discovery === null) {
      await this.#reconcileAll(true);
      return;
    }
    const discovery = discoveryAfterBatch(this.#discovery, batch);
    const changedSources = new Set(batch.changes.map(({ source }) => source));
    const metadata = await loadChangedMetadata(
      discovery,
      this.#cacheDir,
      this.#metadata,
      changedSources,
      this.#metadataReaders,
    );
    await this.#refreshCatalog(
      discovery,
      metadata,
      true,
      batch.changes.filter(({ source }) => source === "rollout").map(({ path }) => path),
    );
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
      .then(() =>
        this.#closed ? undefined : this.reconcileNow("watcher-ready-and-fresh-state-snapshot"),
      )
      .catch((error: unknown) => this.#onError?.(error));
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
    await Promise.allSettled(this.#richPreparations.values());
    this.#updater.clear();
    this.#watcher = null;
  }
}
