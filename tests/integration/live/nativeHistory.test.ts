import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { openCacheDatabase } from "#server/cache/database.ts";
import { NativeHistoryService } from "#server/history/nativeHistoryService.ts";
import { validateSourceRanges } from "#server/ingestion/sourceGeneration.ts";
import {
  watchSources,
  type SourceWatchBatch,
  type WatchSourcesOptions,
} from "#server/ingestion/watchSources.ts";
import { InvalidationBus } from "#server/live/invalidationBus.ts";
import { LiveReconciler } from "#server/live/reconciler.ts";
import { LiveConversationRepository } from "#server/live/repository.ts";
import { HistorySnapshotManager } from "#server/metadata/historySnapshot.ts";
import type { ViewerInvalidation } from "#shared/types/repository.ts";

import { addTurn, fixtureLineage, historyFixture } from "../../fixtures/history/nativeHistory.ts";

describe("optional native history serving boundary", () => {
  it("continues an issued qualified item cursor after the service retires its original snapshot generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-service-cursor-"));
    const fixture = await historyFixture(root);
    const database = openCacheDatabase(":memory:");
    const manager = new HistorySnapshotManager(fixture);
    const service = new NativeHistoryService(database, manager);
    try {
      manager.requestRefresh();
      await manager.whenSettled();
      const old = manager.current()!;
      const source = (
        await validateSourceRanges(fixture.ref, [
          { start: 0, endExclusive: Buffer.byteLength(fixture.raw) },
        ])
      ).generation;
      const lineage = fixtureLineage(fixture.ref);
      const first = await service.read(lineage, source, {
        turnId: "turn",
        anchor: { kind: "latest" },
        limit: 1,
      });
      expect(first.status).toBe("verified-range");
      const cursor = first.page?.turns[0]?.beforeCursor;
      if (!cursor) {
        throw new Error("Expected issued item cursor");
      }
      const native = new DatabaseSync(fixture.sourceDatabase);
      addTurn(native, "unrelated", "other-turn", 1, null);
      native.close();
      service.invalidate();
      manager.requestRefresh();
      await manager.whenSettled();
      expect(manager.current()?.digest).not.toBe(old.digest);
      await expect(lstat(old.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      const continued = await service.read(lineage, source, {
        turnId: "turn",
        anchor: { kind: "before", cursor },
        limit: 1,
      });
      expect(continued.status).toBe("verified-range");
      expect(continued.historyEpoch).toBe(first.historyEpoch);
      expect(continued.page?.turns[0]?.items[0]?.item).toMatchObject({
        id: "user",
        text: "question",
      });
    } finally {
      await service.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("serves fallback while acquisition is gated, then verified native history without legacy materialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-service-"));
    const fixture = await historyFixture(root);
    const database = openCacheDatabase(":memory:");
    const manager = new HistorySnapshotManager(fixture);
    let refreshRequested = false;
    const service = new NativeHistoryService(database, {
      current: () => manager.current(),
      acquire: (snapshot) => manager.acquire(snapshot),
      requestRefresh() {
        refreshRequested = true;
      },
      invalidate: () => manager.invalidate(),
      close: () => manager.close(),
    });
    try {
      const source = (
        await validateSourceRanges(fixture.ref, [
          { start: 0, endExclusive: Buffer.byteLength(fixture.raw) },
        ])
      ).generation;
      const lineage = fixtureLineage(fixture.ref);
      const fallback = await service.read(lineage, source, { anchor: { kind: "latest" } });
      expect(fallback.status).toBe("unavailable");
      expect(fallback.page).toBeNull();
      expect(refreshRequested).toBe(true);
      manager.requestRefresh();
      await manager.whenSettled();
      const native = await service.read(lineage, source, { anchor: { kind: "latest" } });
      expect(native.status).toBe("verified-range");
      expect(native.page!.turns[0]?.items[1]?.item).toMatchObject({
        id: "answer",
        text: "answer A",
      });
      const pending = service.read(lineage, source, { anchor: { kind: "latest" } });
      service.invalidate();
      expect((await pending).status).toBe("stale");
      const cancellation = new AbortController();
      const cancelledRead = service.read(
        lineage,
        source,
        { anchor: { kind: "latest" } },
        cancellation.signal,
      );
      manager.requestRefresh();
      cancellation.abort();
      await expect(cancelledRead).rejects.toThrow(/abort/iu);
      await manager.whenSettled();
      expect(await readdir(join(fixture.snapshotRoot, "generations"))).toEqual([
        manager.current()!.generationId,
      ]);
      const closingRead = service.read(lineage, source, { anchor: { kind: "latest" } });
      const closing = service.close();
      await expect(closingRead).rejects.toThrow(/abort/iu);
      await closing;
    } finally {
      await service.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("observes history database/WAL metadata through the metadata-only watcher", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-history-watch-"));
    const batches: SourceWatchBatch[] = [];
    const watcher = watchSources({
      codexHome: root,
      metadataOnly: true,
      debounceMs: 0,
      onBatch(batch) {
        batches.push(batch);
      },
    });
    try {
      await watcher.ready;
      await writeFile(join(root, "thread_history_1.sqlite"), "db");
      await writeFile(join(root, "thread_history_1.sqlite-wal"), "wal");
      await vi.waitFor(
        () =>
          expect(batches.flatMap((batch) => batch.changes.map((change) => change.source))).toEqual(
            expect.arrayContaining(["history-database", "history-wal"]),
          ),
        { timeout: 2000 },
      );
    } finally {
      await watcher.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps catalog startup free of history acquisition and routes selected native reads through the repository without materialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "native-repository-"));
    const fixture = await historyFixture(root);
    const cacheDir = join(root, "cache");
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    const events: ViewerInvalidation[] = [];
    bus.subscribe((event) => events.push(event));
    let watchOptions: WatchSourcesOptions | undefined;
    const reconciler = new LiveReconciler({
      database,
      bus,
      codexHome: root,
      cacheDir,
      fetchFavicons: false,
      watch(options) {
        watchOptions = options;
        return { ready: Promise.resolve(), async close() {} };
      },
      async readJsonl() {
        throw new Error("Legacy materialization must not run for a native page");
      },
    });
    const repository = new LiveConversationRepository(database, bus, reconciler);
    try {
      await reconciler.start();
      await reconciler.whenRecoverySettled();
      await expect(lstat(join(cacheDir, "history-snapshots"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const source = (
        await validateSourceRanges(fixture.ref, [
          { start: 0, endExclusive: Buffer.byteLength(fixture.raw) },
        ])
      ).generation;
      const lineage = fixtureLineage(fixture.ref);
      expect(
        (await repository.readNativeHistory(lineage, source, { anchor: { kind: "latest" } }))
          .status,
      ).toBe("unavailable");
      await vi.waitFor(
        async () =>
          expect(
            (await repository.readNativeHistory(lineage, source, { anchor: { kind: "latest" } }))
              .status,
          ).toBe("verified-range"),
        { timeout: 3000 },
      );
      events.splice(0);
      await watchOptions!.onBatch({
        observedAt: new Date().toISOString(),
        changes: [{ kind: "changed", path: fixture.sourceWal, source: "history-wal" }],
      });
      expect(events).toEqual([
        expect.objectContaining({ type: "session.updated", ids: ["stable"] }),
      ]);
      expect(await repository.listSessions({ scope: "active" })).toMatchObject({ items: [] });
    } finally {
      await reconciler.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
