import type { DatabaseSync } from "node:sqlite";

import type { SourceGeneration } from "../../shared/types/conversation.ts";
import type { HistoryItemQuery, HistoryPageQuery } from "../../shared/types/repository.ts";
import type { ResolvedRolloutLineage } from "../ingestion/rolloutLineage.ts";
import type { HistorySnapshot, HistorySnapshotLease } from "../metadata/historySnapshot.ts";
import { readNativeHistoryPage, readNativeTurnItems } from "./nativeHistoryReader.ts";
import {
  qualifyNativeProjection,
  VerifiedProjectionStore,
  type NativeProjectionQualification,
  type VerifiedProjectionStoreOptions,
} from "./nativeProjectionQualification.ts";

export interface HistorySnapshotProvider {
  current(): HistorySnapshot | null;
  acquire(snapshot: HistorySnapshot): HistorySnapshotLease | null;
  requestRefresh(): void;
  invalidate(): void;
  close(): Promise<void>;
}
export function unavailableNativeHistory(
  source: SourceGeneration,
  diagnostic: string,
): NativeProjectionQualification {
  return {
    status: "unavailable",
    snapshotDigest: null,
    sourceToken: source.token,
    historyEpoch: null,
    dependencies: [],
    verifiedRanges: [],
    diagnostics: [diagnostic],
    association: null,
    page: null,
  };
}
/** Optional selected-read seam, acquisition never becomes a catalog or first-page prerequisite */
export class NativeHistoryService {
  readonly #snapshots: HistorySnapshotProvider;
  readonly #associations: VerifiedProjectionStore;
  readonly #sources = new Map<string, string>();
  readonly #controller = new AbortController();
  readonly #requests = new Set<Promise<NativeProjectionQualification>>();
  #revision = 0;
  #active = 0;
  #closed = false;
  constructor(
    database: DatabaseSync,
    snapshots: HistorySnapshotProvider,
    options: VerifiedProjectionStoreOptions = {},
  ) {
    this.#snapshots = snapshots;
    this.#associations = new VerifiedProjectionStore(database, options);
  }
  selectedThreadIds(): string[] {
    return [...this.#sources.keys()];
  }
  read(
    lineage: ResolvedRolloutLineage,
    source: SourceGeneration,
    query: HistoryPageQuery | HistoryItemQuery,
    signal?: AbortSignal,
  ): Promise<NativeProjectionQualification> {
    const combined = signal
      ? AbortSignal.any([signal, this.#controller.signal])
      : this.#controller.signal;
    const request = this.#read(lineage, source, query, combined).finally(() =>
      this.#requests.delete(request),
    );
    this.#requests.add(request);
    return request;
  }
  async #read(
    lineage: ResolvedRolloutLineage,
    source: SourceGeneration,
    query: HistoryPageQuery | HistoryItemQuery,
    signal?: AbortSignal,
  ): Promise<NativeProjectionQualification> {
    signal?.throwIfAborted();
    if (this.#closed || this.#active >= 4) {
      return unavailableNativeHistory(source, "native.reader_unavailable");
    }
    const threadId = lineage.segments.at(-1)?.ref.stableThreadId;
    if (!threadId) {
      return unavailableNativeHistory(source, "native.lineage_unavailable");
    }
    this.#sources.set(threadId, source.token);
    this.#snapshots.requestRefresh();
    const snapshot = this.#snapshots.current();
    if (snapshot === null) {
      return unavailableNativeHistory(source, "native.snapshot_pending");
    }
    const lease = this.#snapshots.acquire(snapshot);
    if (lease === null) {
      return unavailableNativeHistory(source, "native.snapshot_retired");
    }
    const revision = this.#revision;
    this.#active += 1;
    try {
      const candidate =
        "turnId" in query
          ? await readNativeTurnItems(lineage, query, snapshot, signal)
          : await readNativeHistoryPage(lineage, query, snapshot, signal);
      if (candidate.status === "unavailable") {
        this.#snapshots.invalidate();
      }
      const qualified = await qualifyNativeProjection(
        candidate,
        lineage,
        source,
        this.#associations,
        signal,
      );
      if (
        this.#closed ||
        revision !== this.#revision ||
        this.#sources.get(threadId) !== source.token
      ) {
        return {
          ...qualified,
          status: "stale",
          page: null,
          diagnostics: [...qualified.diagnostics, "native.publication_superseded"],
        };
      }
      return qualified;
    } finally {
      this.#active -= 1;
      lease.release();
    }
  }
  invalidate(refreshSnapshot = true): void {
    this.#revision += 1;
    this.#associations.canonicalEvidence?.invalidate?.();
    if (refreshSnapshot) {
      this.#snapshots.invalidate();
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#revision += 1;
    this.#controller.abort();
    this.#associations.canonicalEvidence?.invalidate?.();
    await Promise.allSettled(this.#requests);
    await this.#snapshots.close();
    this.#sources.clear();
  }
}
