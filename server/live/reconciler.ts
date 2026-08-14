import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import type { ViewerInvalidation } from "../../shared/types/repository.ts";
import {
  getCachedSession,
  listCachedSourcePaths,
  removeCachedSource,
  updateCachedSessionRichContent,
} from "../cache/conversationStore.ts";
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
import {
  watchSources,
  type SourceWatchBatch,
  type SourceWatcher,
  type WatchSourcesOptions,
} from "../ingestion/watchSources.ts";
import { readGlobalState } from "../metadata/globalState.ts";
import { readSessionIndex, type SessionIndexEntry } from "../metadata/sessionIndex.ts";
import { snapshotStateDatabase, type StateMetadataSnapshot } from "../metadata/stateSnapshot.ts";
import type { NormalizedSession } from "../normalization/normalizeSession.ts";
import { InvalidationBus } from "./invalidationBus.ts";

const DEFAULT_RECONCILIATION_INTERVAL_MS = 30_000;

interface LiveMetadata {
  sessionIndexEntries: SessionIndexEntry[];
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

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return (
    pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
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

function changedMapKeys<T>(
  before: readonly T[],
  after: readonly T[],
  key: (value: T) => string,
): Set<string> {
  const previous = new Map(before.map((value) => [key(value), JSON.stringify(value)]));
  const current = new Map(after.map((value) => [key(value), JSON.stringify(value)]));
  return new Set(
    [...new Set([...previous.keys(), ...current.keys()])].filter(
      (id) => previous.get(id) !== current.get(id),
    ),
  );
}

function affectedMetadataSessions(before: LiveMetadata, after: LiveMetadata): Set<string> {
  const affected = changedMapKeys(
    before.sessionIndexEntries,
    after.sessionIndexEntries,
    ({ id }) => id,
  );
  const beforeState = before.stateSnapshot;
  const afterState = after.stateSnapshot;
  if (beforeState === null && afterState === null) {
    return affected;
  }
  const beforeThreads = beforeState?.threads ?? [];
  const afterThreads = afterState?.threads ?? [];
  for (const changedId of changedMapKeys(beforeThreads, afterThreads, ({ id }) => id)) {
    affected.add(changedId);
  }
  const changedSections = changedMapKeys(
    beforeState?.sections ?? [],
    afterState?.sections ?? [],
    ({ id }) => id,
  );
  for (const thread of [...beforeThreads, ...afterThreads]) {
    if (thread.sectionId !== null && changedSections.has(thread.sectionId)) {
      affected.add(thread.id);
    }
  }
  const beforeEdges = beforeState?.spawnEdges ?? [];
  const afterEdges = afterState?.spawnEdges ?? [];
  const edgeKey = (edge: StateMetadataSnapshot["spawnEdges"][number]): string =>
    `${edge.parentThreadId}\0${edge.childThreadId}`;
  const changedEdges = changedMapKeys(beforeEdges, afterEdges, edgeKey);
  for (const edge of [...beforeEdges, ...afterEdges]) {
    if (changedEdges.has(edgeKey(edge))) {
      affected.add(edge.parentThreadId);
      affected.add(edge.childThreadId);
    }
  }
  return affected;
}

async function loadMetadata(
  discovery: SourceDiscoveryResult,
  cacheDir: string,
): Promise<LiveMetadata> {
  const diagnostics: ViewerDiagnostic[] = [];
  let sessionIndexEntries: SessionIndexEntry[] = [];
  let stateSnapshot: StateMetadataSnapshot | null = null;
  if (discovery.metadata.sessionIndex !== null) {
    const result = await readSessionIndex(discovery.metadata.sessionIndex);
    sessionIndexEntries = result.entries;
    diagnostics.push(...result.diagnostics);
  }
  if (discovery.metadata.globalState !== null) {
    const result = await readGlobalState(discovery.metadata.globalState);
    diagnostics.push(...result.diagnostics);
  }
  if (discovery.metadata.stateDatabase !== null) {
    const result = await snapshotStateDatabase({
      sourceDatabase: discovery.metadata.stateDatabase,
      sourceWal: discovery.metadata.stateWal ?? `${discovery.metadata.stateDatabase}-wal`,
      snapshotRoot: join(cacheDir, "state-snapshots"),
    });
    stateSnapshot = result.metadata;
    diagnostics.push(...result.diagnostics);
  }
  return { sessionIndexEntries, stateSnapshot, diagnostics };
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
  readonly #knownFaviconOrigins = new Map<string, string>();
  #metadata: LiveMetadata = {
    sessionIndexEntries: [],
    stateSnapshot: null,
    diagnostics: [],
  };
  #watcher: SourceWatcher | null = null;
  #interval: NodeJS.Timeout | null = null;
  #queue = Promise.resolve();
  #pendingBatches: SourceWatchBatch[] = [];
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
    this.#updater = new SessionCacheUpdater(this.#database, {
      retainLiveSources: true,
      readJsonl: options.readJsonl,
    });
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

  async #updateSource(
    source: DiscoveredRolloutSource,
    force: boolean,
    announce: boolean,
  ): Promise<void> {
    const manifest = getSourceManifestEntry(this.#database, source.path);
    const before = manifest?.sessionId
      ? getCachedSession(this.#database, manifest.sessionId)
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
      return;
    }
    if (result.status === "unchanged") {
      return;
    }
    let after = getCachedSession(this.#database, result.sessionId);
    if (after === null) {
      return;
    }
    try {
      after = await this.#prepareRichContent(after);
    } catch (error) {
      this.#onError?.(error);
    }
    if (!announce) {
      return;
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
  }

  async #reconcileAll(announce: boolean): Promise<void> {
    const discovery = await discoverSources(this.#codexHome);
    const metadata = await loadMetadata(discovery, this.#cacheDir);
    const affected = affectedMetadataSessions(this.#metadata, metadata);
    this.#metadata = metadata;
    const expectedPaths = new Set(discovery.rollouts.map(({ path }) => resolve(path)));
    for (const source of discovery.rollouts) {
      const sessionId = getSourceManifestEntry(this.#database, source.path)?.sessionId;
      // oxlint-disable-next-line no-await-in-loop -- One SQLite writer and stable-read parser are intentionally serialized.
      await this.#updateSource(
        source,
        typeof sessionId === "string" && affected.has(sessionId),
        announce,
      );
    }
    for (const sourcePath of listCachedSourcePaths(this.#database)) {
      if (!isWithinRoot(this.#codexHome, sourcePath) || expectedPaths.has(resolve(sourcePath))) {
        continue;
      }
      const removedSessionId = removeCachedSource(this.#database, sourcePath);
      if (announce && removedSessionId !== null) {
        this.#publish({
          type: "library.updated",
          ids: [removedSessionId],
          revision: this.#nextRevision(),
        });
      }
    }
    const diagnostics = [...discovery.diagnostics, ...metadata.diagnostics];
    if (announce && diagnostics.length > 0) {
      this.#publish({
        type: "diagnostic.updated",
        ids: diagnostics.map(({ id }) => id),
        revision: this.#nextRevision(),
      });
    }
  }

  async #processBatch(batch: SourceWatchBatch): Promise<void> {
    if (batch.changes.some((change) => change.source !== "rollout" || change.kind === "removed")) {
      await this.#reconcileAll(true);
      return;
    }
    for (const change of batch.changes) {
      if (change.source !== "rollout") {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- A watcher batch uses one serialized cache writer.
      await this.#updateSource({ path: change.path, scope: change.scope }, false, true);
    }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const scheduled = this.#queue.then(operation, operation);
    this.#queue = scheduled.catch((error: unknown) => {
      this.#onError?.(error);
    });
    return scheduled;
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
        if (!this.#started) {
          this.#pendingBatches.push(batch);
          return;
        }
        void this.#enqueue(() => this.#processBatch(batch));
      },
      onError: (error) => {
        this.#onError?.(error);
        if (this.#started) {
          void this.reconcileNow("watcher-error");
        }
      },
    });
    await this.#watcher.ready;
    await this.#reconcileAll(false);
    this.#started = true;
    const pending = this.#pendingBatches.splice(0);
    for (const batch of pending) {
      // oxlint-disable-next-line no-await-in-loop -- Startup events are replayed in observation order after the initial scan.
      await this.#processBatch(batch);
    }
    this.#interval = setInterval(() => {
      void this.reconcileNow("periodic");
    }, this.#reconciliationIntervalMs);
    this.#interval.unref();
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#interval !== null) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
    await this.#watcher?.close();
    await this.#queue;
    this.#watcher = null;
  }
}
