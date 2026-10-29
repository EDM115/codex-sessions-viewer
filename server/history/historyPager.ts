import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  historyEpochStorage,
  initializeHistoryIndexes,
  persistHistoryWindows,
} from "#server/cache/repositoryStore.ts";
import { HistoryEpochAuthority } from "#server/history/historyEpochAuthority.ts";
import type { NativeHistoryService } from "#server/history/nativeHistoryService.ts";
import { RolloutHistoryReader } from "#server/history/rolloutHistoryReader.ts";
import type { ResolvedRolloutLineage } from "#server/ingestion/rolloutLineage.ts";
import type { SeekableRollout } from "#server/ingestion/rolloutStream.ts";
import { resolveSelectedRolloutLineage } from "#server/ingestion/selectedRolloutLineage.ts";
import type { RolloutRef } from "#shared/types/conversation.ts";
import type { HistoryPage, HistoryTurnWindow } from "#shared/types/history.ts";
import {
  historyItemQuerySchema,
  historyPageQuerySchema,
  type HistoryItemQuery,
  type HistoryPageQuery,
} from "#shared/types/repository.ts";

export class HistoryReloadError extends Error {
  readonly code = "history.reload_required";
  constructor(reason: string) {
    super(reason);
    this.name = "HistoryReloadError";
  }
}

interface PagerOptions {
  database: DatabaseSync;
  open: (ref: RolloutRef, signal?: AbortSignal) => Promise<SeekableRollout>;
  epochAuthority?: HistoryEpochAuthority;
  native?: NativeHistoryService;
}
interface Job {
  family: string;
  controller: AbortController;
  subscribers: number;
  promise: Promise<HistoryPage | HistoryTurnWindow>;
  priority: number;
  state: "queued" | "running";
  run: () => Promise<void>;
}
interface IssuedBoundary {
  thread: string;
  epoch: string;
  physical: string;
  turn: string;
  item: string | null;
  direction: "before" | "after";
  limit: number;
}

/** Sparse evidence is a hint, only the receiving backend may establish a current semantic epoch */
export class HistoryPager {
  readonly #options: PagerOptions;
  readonly #raw: RolloutHistoryReader;
  readonly #jobs = new Map<string, Job>();
  #active: Job | null = null;
  readonly #issued = new Map<string, IssuedBoundary>();
  #closed = false;
  constructor(options: PagerOptions) {
    this.#options = options;
    const epochAuthority =
      options.epochAuthority ?? new HistoryEpochAuthority(historyEpochStorage(options.database));
    this.#raw = new RolloutHistoryReader({ open: options.open, epochAuthority });
    initializeHistoryIndexes(options.database);
  }
  read(
    ref: RolloutRef,
    known: readonly RolloutRef[],
    query: HistoryPageQuery,
    signal?: AbortSignal,
    sourceRevision?: string,
  ): Promise<HistoryPage> {
    const parsed = historyPageQuerySchema.parse(query);
    return this.#subscribe(ref, known, parsed, signal, sourceRevision).then((result) => {
      if (!("turns" in result)) {
        throw new Error("history.invalid_page");
      }
      return result;
    });
  }
  readRawEvidence(
    ref: RolloutRef,
    known: readonly RolloutRef[],
    query: HistoryPageQuery,
    signal?: AbortSignal,
    sourceRevision?: string,
  ): Promise<HistoryPage> {
    return this.#subscribe(
      ref,
      known,
      historyPageQuerySchema.parse(query),
      signal,
      sourceRevision,
      true,
    ).then((result) => {
      if (!("turns" in result)) {
        throw new Error("history.invalid_page");
      }
      return result;
    });
  }
  readItems(
    ref: RolloutRef,
    known: readonly RolloutRef[],
    query: HistoryItemQuery,
    signal?: AbortSignal,
    sourceRevision?: string,
  ): Promise<HistoryTurnWindow> {
    const parsed = historyItemQuerySchema.parse(query);
    return this.#subscribe(ref, known, parsed, signal, sourceRevision).then((result) => {
      if (!("turnId" in result)) {
        throw new Error("history.invalid_window");
      }
      return result;
    });
  }
  #subscribe(
    ref: RolloutRef,
    known: readonly RolloutRef[],
    query: HistoryPageQuery | HistoryItemQuery,
    signal?: AbortSignal,
    sourceRevision?: string,
    rawOnly = false,
  ): Promise<HistoryPage | HistoryTurnWindow> {
    signal?.throwIfAborted();
    if (this.#closed) {
      return Promise.reject(new Error("history.closed"));
    }
    const family = JSON.stringify([ref.codexHomeId, ref.stableThreadId]);
    const key = JSON.stringify([ref, known, query, sourceRevision, rawOnly]);
    let job = this.#jobs.get(key);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      let resolve!: (result: HistoryPage | HistoryTurnWindow) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<HistoryPage | HistoryTurnWindow>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      job = {
        family,
        controller,
        subscribers: 0,
        promise,
        state: "queued",
        priority:
          query.anchor.kind === "turn" || query.anchor.kind === "latest"
            ? 2
            : query.anchor.kind === "opening"
              ? 1
              : 0,
        run: async () => {
          try {
            resolve(await this.#read(ref, known, query, controller.signal, rawOnly));
          } catch (error) {
            reject(error);
          }
        },
      };
      this.#jobs.set(key, job);
      const active = job;
      void promise
        .finally(() => {
          if (this.#jobs.get(key) === active) {
            this.#jobs.delete(key);
          }
          if (this.#active === active) {
            this.#active = null;
          }
          this.#drain();
        })
        .catch(() => undefined);
    }
    const active = job;
    active.subscribers += 1;
    this.#drain();
    return new Promise((resolve, reject) => {
      let settled = false;
      const detach = () => {
        if (settled) {
          return false;
        }
        settled = true;
        signal?.removeEventListener("abort", aborted);
        active.subscribers -= 1;
        if (active.subscribers === 0) {
          active.controller.abort();
        }
        return true;
      };
      const aborted = () => {
        if (detach()) {
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        }
      };
      signal?.addEventListener("abort", aborted, { once: true });
      active.promise.then(
        (page) => {
          if (detach()) {
            resolve(structuredClone(page));
          }
          return undefined;
        },
        (error: unknown) => {
          if (detach()) {
            reject(error);
          }
        },
      );
    });
  }
  #drain(): void {
    if (this.#active) {
      return;
    }
    const next = [...this.#jobs.values()]
      .filter((job) => job.state === "queued")
      .toSorted((a, b) => b.priority - a.priority)[0];
    if (!next) {
      return;
    }
    this.#active = next;
    next.state = "running";
    void next.run();
  }
  async #read(
    ref: RolloutRef,
    known: readonly RolloutRef[],
    query: HistoryPageQuery | HistoryItemQuery,
    signal: AbortSignal,
    rawOnly = false,
  ): Promise<HistoryPage | HistoryTurnWindow> {
    signal.throwIfAborted();
    try {
      const lineage = await resolveSelectedRolloutLineage(ref, known, signal, {
        open: this.#options.open,
      });
      let result: HistoryPage | HistoryTurnWindow | null = null;
      const cursor = "cursor" in query.anchor ? query.anchor.cursor : null;
      const issued = cursor ? this.#issued.get(cursor) : undefined;
      if (
        issued &&
        (issued.thread !== ref.stableThreadId ||
          issued.direction !== query.anchor.kind ||
          ("turnId" in query && issued.turn !== query.turnId) ||
          "turnId" in query !== (issued.item !== null))
      ) {
        throw new HistoryReloadError("history.cursor_owner_mismatch");
      }
      if (!rawOnly && this.#options.native && !cursor?.startsWith("raw-v1-")) {
        const lease = await this.#options.open(lineage.segments.at(-1)!.ref, signal);
        try {
          await lease.read(0, Math.min(64 * 1024, lease.size), signal);
          const source = await lease.verify(signal);
          const native = await this.#options.native.read(lineage, source, query, signal);
          if (native.page && native.status === "verified-range") {
            result =
              "turnId" in query
                ? (native.page.turns.find((turn) => turn.turnId === query.turnId) ?? null)
                : native.page;
          }
        } finally {
          await lease.close();
        }
      }
      if (!result) {
        result =
          cursor && !cursor.startsWith("raw-v1-") && issued
            ? await this.#recover(lineage, query, issued, signal)
            : "turnId" in query
              ? await this.#raw.readItems(lineage, query, signal)
              : await this.#raw.read(lineage, query, signal);
      }
      const targetTurnId = query.anchor.kind === "turn" ? query.anchor.turnId : null;
      if (
        !("turnId" in query) &&
        targetTurnId !== null &&
        "turns" in result &&
        !result.stale &&
        !result.turns.some((turn) => turn.turnId === targetTurnId)
      ) {
        const target = await this.#raw.readItems(
          lineage,
          { turnId: targetTurnId, anchor: { kind: "opening" }, limit: 2 },
          signal,
        );
        result = {
          ...result,
          turns: [target],
          historyEpoch: target.historyEpoch,
          contentRevision: target.contentRevision,
          beforeCursor: null,
          afterCursor: null,
          coverage: target.coverage,
          preparation: target.itemsView === "full" ? "ready" : "partial",
        };
      }
      signal.throwIfAborted();
      const turns = "turns" in result ? result.turns : [result];
      for (const turn of turns) {
        turn.segmentOrder = lineage.segments.findIndex(
          (segment) => segment.ref.physicalRolloutId === turn.physicalRolloutId,
        );
      }
      const remember = (cursorValue: string | null, boundary: IssuedBoundary) => {
        if (!cursorValue || cursorValue.startsWith("raw-v1-")) {
          return;
        }
        this.#issued.set(cursorValue, boundary);
        if (this.#issued.size > 256) {
          this.#issued.delete(this.#issued.keys().next().value!);
        }
      };
      for (const turn of turns) {
        for (const direction of ["before", "after"] as const) {
          const item = direction === "before" ? turn.items[0] : turn.items.at(-1);
          if (item) {
            remember(direction === "before" ? turn.beforeCursor : turn.afterCursor, {
              thread: ref.stableThreadId,
              epoch: result.historyEpoch,
              physical: turn.physicalRolloutId,
              turn: turn.turnId,
              item: item.itemId,
              direction,
              limit: turn.items.length,
            });
          }
        }
      }
      if ("turns" in result) {
        for (const direction of ["before", "after"] as const) {
          const turn = direction === "before" ? turns[0] : turns.at(-1);
          if (turn) {
            remember(direction === "before" ? result.beforeCursor : result.afterCursor, {
              thread: ref.stableThreadId,
              epoch: result.historyEpoch,
              physical: turn.physicalRolloutId,
              turn: turn.turnId,
              item: null,
              direction,
              limit: turns.length,
            });
          }
        }
      }
      persistHistoryWindows(this.#options.database, ref.stableThreadId, result);
      return result;
    } catch (error) {
      signal.throwIfAborted();
      const reason = error instanceof Error ? error.message : String(error);
      if (
        /cursor|epoch_publication_superseded|source.changed|lineage_metadata_changed|rollout.superseded/iu.test(
          reason,
        )
      ) {
        throw new HistoryReloadError(reason);
      }
      if ("turnId" in query) {
        throw error;
      }
      return {
        threadId: ref.stableThreadId,
        metadataRevision: null,
        historyEpoch: randomUUID(),
        contentRevision: randomUUID(),
        turns: [],
        beforeCursor: null,
        afterCursor: null,
        coverage: {
          status: "unresolved",
          segments: [],
          gaps: [
            {
              physicalRolloutId: ref.physicalRolloutId ?? ref.sourcePath,
              turnId: null,
              reason,
              beforeOrdinal: null,
              afterOrdinal: null,
            },
          ],
        },
        preparation: "unavailable",
      };
    }
  }
  async #recover(
    lineage: ResolvedRolloutLineage,
    query: HistoryPageQuery | HistoryItemQuery,
    issued: IssuedBoundary,
    signal: AbortSignal,
  ): Promise<HistoryPage | HistoryTurnWindow> {
    if ("turnId" in query) {
      const recovered = await this.#raw.readItems(
        lineage,
        {
          turnId: issued.turn,
          anchor: { kind: issued.direction === "before" ? "latest" : "opening" },
          limit: Math.min(100, issued.limit),
        },
        signal,
      );
      const boundary = issued.direction === "before" ? recovered.items[0] : recovered.items.at(-1);
      if (
        recovered.historyEpoch !== issued.epoch ||
        recovered.physicalRolloutId !== issued.physical ||
        boundary?.itemId !== issued.item
      ) {
        throw new HistoryReloadError("history.cursor_boundary_unresolved");
      }
      const cursor = issued.direction === "before" ? recovered.beforeCursor : recovered.afterCursor;
      if (!cursor) {
        throw new HistoryReloadError("history.cursor_boundary_unresolved");
      }
      return this.#raw.readItems(
        lineage,
        { ...query, anchor: { kind: issued.direction, cursor } },
        signal,
      );
    }
    const recovered = await this.#raw.read(
      lineage,
      { anchor: { kind: "turn", turnId: issued.turn }, limit: 1 },
      signal,
    );
    const boundary = issued.direction === "before" ? recovered.turns[0] : recovered.turns.at(-1);
    if (
      recovered.stale ||
      recovered.historyEpoch !== issued.epoch ||
      boundary?.turnId !== issued.turn ||
      boundary.physicalRolloutId !== issued.physical
    ) {
      throw new HistoryReloadError("history.cursor_boundary_unresolved");
    }
    const cursor = issued.direction === "before" ? recovered.beforeCursor : recovered.afterCursor;
    if (!cursor) {
      throw new HistoryReloadError("history.cursor_boundary_unresolved");
    }
    return this.#raw.read(
      lineage,
      { ...query, anchor: { kind: issued.direction, cursor } },
      signal,
    );
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const job of this.#jobs.values()) {
      job.controller.abort();
    }
    await Promise.allSettled([...this.#jobs.values()].map((job) => job.promise));
  }
}
