import { mkdir, mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  catalogSession,
  listCatalogSessions,
  listAllCatalogSessions,
} from "../../../server/cache/catalogStore.ts";
import { replaceCachedSession } from "../../../server/cache/conversationStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import { recoverCatalogSources } from "../../../server/ingestion/recoverCatalogSources.ts";
import { readSessionMetaPrefix } from "../../../server/ingestion/sessionMetaPrefix.ts";
import { watchSources } from "../../../server/ingestion/watchSources.ts";
import { InvalidationBus } from "../../../server/live/invalidationBus.ts";
import { LiveReconciler } from "../../../server/live/reconciler.ts";
import { cachedSource, normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";
import { createStateDatabase } from "../source-boundary/fixtures.ts";

const raw = (id: string) =>
  `${JSON.stringify({ type: "session_meta", payload: { id, timestamp: "2026-01-01T00:00:00Z", source: "cli" } })}\n`;

const recoveryIo = vi.hoisted(() => ({ path: "", bytes: 0, lengths: [] as number[] }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    async open(...args: Parameters<typeof fs.open>) {
      const handle = await fs.open(...args);
      if (String(args[0]) === recoveryIo.path) {
        handle.read = new Proxy(handle.read, {
          async apply(read, target, readArguments) {
            recoveryIo.lengths.push(Number(readArguments[2]));
            const result = await Reflect.apply(read, target, readArguments);
            recoveryIo.bytes += result.bytesRead;
            return result;
          },
        });
      }
      return handle;
    },
  };
});

describe("bounded metadata-free recovery", () => {
  it.each(["compressed", "capped"] as const)(
    "keeps retained %s structure visible when recovery has no new declaration",
    async (representation) => {
      const root = await mkdtemp(join(tmpdir(), "viewer-retained-recovery-"));
      const home = join(root, "home");
      await mkdir(join(home, "sessions"), { recursive: true });
      const id = "11111111-1111-4111-8111-111111111111";
      const path = join(
        home,
        "sessions",
        `rollout-2026-10-01T00-00-00-${id}.jsonl${representation === "compressed" ? ".zst" : ""}`,
      );
      await writeFile(
        path,
        representation === "compressed"
          ? "compressed bytes are not decoded for recovery"
          : " ".repeat(12000) + raw(id),
      );
      const database = openCacheDatabase(":memory:");
      const session = await normalizedRolloutFixture({
        name: "modern.jsonl",
        sourcePath: path,
        scope: "active",
        revision: "sha256:retained",
        root: true,
      });
      replaceCachedSession(database, { session, source: cachedSource(session), diagnostics: [] });
      const reconciler = new LiveReconciler({
        database,
        codexHome: home,
        cacheDir: join(root, "cache"),
        bus: new InvalidationBus(),
        reconciliationIntervalMs: 60000,
      });
      try {
        await reconciler.start();
        expect(listCatalogSessions(database, { scope: "active" }).total).toBe(1);
        await reconciler.whenRecoverySettled();
        expect(
          listCatalogSessions(database, { scope: "active" }).items.map((entry) => entry.id),
        ).toEqual([id]);
        expect(catalogSession(database, id)?.structuralEvidence).toMatchObject({
          freshness: "retained-unvalidated",
          classification: { visibility: "user-root" },
        });
      } finally {
        await reconciler.close();
        database.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("retains an oversized first record as unresolved rather than promoting its filename to a user root", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-catalog-recovery-large-meta-"));
    const home = join(root, "home");
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(
      join(home, "sessions", "large.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { base_instructions: "x".repeat(12_000), id: "hidden-helper", source: { subagent: "review" } } })}\n`,
    );
    const database = openCacheDatabase(":memory:");
    const readJsonl =
      vi.fn<typeof import("../../../server/ingestion/jsonlStream.ts").readStableJsonl>();
    const reconciler = new LiveReconciler({
      database,
      codexHome: home,
      cacheDir: join(root, "cache"),
      bus: new InvalidationBus(),
      readJsonl,
      reconciliationIntervalMs: 60_000,
    });
    try {
      await reconciler.start();
      await reconciler.whenRecoverySettled();
      expect(listCatalogSessions(database, { scope: "active" }).items).toEqual([]);
      expect(listAllCatalogSessions(database)).toEqual([
        expect.objectContaining({
          structuralEvidence: expect.objectContaining({
            classification: expect.objectContaining({
              visibility: "unresolved",
              reasons: expect.arrayContaining(["recovery-structure-not-loaded"]),
            }),
          }),
        }),
      ]);
      expect(readJsonl).not.toHaveBeenCalled();
    } finally {
      await reconciler.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("publishes index rows first and merges actual discovery in bounded batches without body materialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-catalog-recovery-"));
    const home = join(root, "home");
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(
      join(home, "session_index.jsonl"),
      '{"id":"index-only","thread_name":"Indexed first","updated_at":"2026-01-01T00:00:00Z"}\n',
    );
    await Promise.all(
      Array.from({ length: 33 }, (_, index) =>
        writeFile(join(home, "sessions", `raw-${index}.jsonl`), raw(`raw-${index}`)),
      ),
    );
    const database = openCacheDatabase(":memory:");
    const readPrefix = vi.fn<typeof readSessionMetaPrefix>(readSessionMetaPrefix);
    const readJsonl =
      vi.fn<typeof import("../../../server/ingestion/jsonlStream.ts").readStableJsonl>();
    const batches: number[] = [];
    const publishedTotals: number[] = [];
    const bus = new InvalidationBus();
    bus.subscribe((event) => {
      if (event.type === "library.updated") {
        publishedTotals.push(listCatalogSessions(database, { scope: "active" }).total);
      }
    });
    const reconciler = new LiveReconciler({
      database,
      codexHome: home,
      cacheDir: join(root, "cache"),
      bus,
      readPrefix,
      readJsonl,
      reconciliationIntervalMs: 60_000,
      async *recoverSources(path, signal) {
        for await (const batch of recoverCatalogSources(path, signal)) {
          batches.push(batch.length);
          yield batch;
        }
      },
    });
    try {
      await reconciler.start();
      expect(
        listCatalogSessions(database, { scope: "active" }).items.map((entry) => entry.id),
      ).toEqual(["index-only"]);
      expect(reconciler.catalogStatus).toEqual({
        catalogSource: "recovery",
        recoveryState: "running",
      });
      expect(readPrefix).not.toHaveBeenCalled();
      await reconciler.whenRecoverySettled();
      expect(batches).toEqual([16, 16, 1]);
      expect(publishedTotals).toEqual([17, 33, 34, 34]);
      expect(readPrefix).toHaveBeenCalledTimes(33);
      expect(
        readPrefix.mock.calls.every(
          ([, bytes, options]) => bytes === 4096 && options?.firstRecordMaxBytes === 4096,
        ),
      ).toBe(true);
      expect(readJsonl).not.toHaveBeenCalled();
      expect(database.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({
        count: 0,
      });
      expect(reconciler.catalogStatus.recoveryState).toBe("complete");
    } finally {
      await reconciler.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels an in-flight recovery prefix when real metadata watching finds a new native catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-catalog-recovery-fence-"));
    const home = join(root, "home");
    await mkdir(join(home, "sessions"), { recursive: true });
    const sourcePath = join(home, "sessions", "late-raw.jsonl");
    const retainedId = "11111111-1111-4111-8111-111111111111";
    await writeFile(sourcePath, raw(retainedId) + " ".repeat(256 * 1024));
    const database = openCacheDatabase(":memory:");
    const session = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath,
      scope: "active",
      revision: "sha256:retained",
      root: true,
    });
    const info = await stat(sourcePath, { bigint: true });
    const source = cachedSource(session, { size: Number(info.size), inode: info.ino });
    source.identity.device = info.dev;
    source.fingerprint.mtimeMs = Number(info.mtimeNs) / 1000000 - 10000;
    replaceCachedSession(database, { session, source, diagnostics: [] });
    recoveryIo.path = sourcePath;
    recoveryIo.bytes = 0;
    recoveryIo.lengths = [];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const metadataObserved = Promise.withResolvers<void>();
    const published = Promise.withResolvers<void>();
    const errors: unknown[] = [];
    const bus = new InvalidationBus();
    bus.subscribe((event) => {
      if (event.type === "library.updated" && event.ids.includes("thread-1")) {
        published.resolve();
      }
    });
    const reconciler = new LiveReconciler({
      database,
      codexHome: home,
      cacheDir: join(root, "cache"),
      bus,
      debounceMs: 0,
      reconciliationIntervalMs: 60_000,
      onError: (error) => errors.push(error),
      async readPrefix(...args) {
        const result = await readSessionMetaPrefix(...args);
        entered.resolve();
        await release.promise;
        return result;
      },
      watch(options) {
        return watchSources({
          ...options,
          onBatch(batch) {
            const result = options.onBatch(batch);
            metadataObserved.resolve();
            return result;
          },
        });
      },
    });
    try {
      await reconciler.start();
      await entered.promise;
      createStateDatabase(join(home, "state_5.sqlite")).close();
      await metadataObserved.promise;
      release.resolve();
      await published.promise;
      await reconciler.whenRecoverySettled();
      expect(
        listCatalogSessions(database, { scope: "active" }).items.map((entry) => entry.id),
      ).toEqual(expect.arrayContaining(["thread-1", retainedId]));
      expect(recoveryIo.bytes).toBe(4096);
      expect(recoveryIo.lengths).toEqual([4096]);
      expect(reconciler.catalogStatus).toEqual({ catalogSource: "fresh", recoveryState: "idle" });
      expect(errors).toEqual([]);
    } finally {
      recoveryIo.path = "";
      release.resolve();
      await reconciler.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
