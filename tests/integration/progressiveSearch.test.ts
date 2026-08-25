import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openCacheDatabase } from "../../server/cache/database.ts";
import type { StableJsonlReader } from "../../server/cache/sourceManifest.ts";
import type { LoadedServerViewerConfig } from "../../server/core/config.ts";
import { readStableJsonl } from "../../server/ingestion/jsonlStream.ts";
import type { WatchSourcesOptions } from "../../server/ingestion/watchSources.ts";
import { InvalidationBus } from "../../server/live/invalidationBus.ts";
import { coalesceSourceWatchBatches, LiveReconciler } from "../../server/live/reconciler.ts";
import { LiveViewerRuntime } from "../../server/live/viewerRuntime.ts";
import type { ViewerInvalidation } from "../../shared/types/repository.ts";

const temporaryRoots: string[] = [];
const fixtureSessionId = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function startRuntime(
  count: number,
  readJsonl: StableJsonlReader = readStableJsonl,
  options: { withMetadata?: boolean; onError?: (error: unknown) => void } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "codex-viewer-progressive-search-"));
  temporaryRoots.push(root);
  const codexHome = join(root, "codex-home");
  const sessions = join(codexHome, "sessions", "2026", "08", "16");
  await Promise.all([
    mkdir(sessions, { recursive: true }),
    mkdir(join(codexHome, "archived_sessions"), { recursive: true }),
  ]);
  const fixture = await readFile(
    join(process.cwd(), "tests", "fixtures", "rollouts", "modern.jsonl"),
    "utf8",
  );
  await Promise.all(
    Array.from({ length: count }, (_, index) => {
      const id = `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`;
      return writeFile(
        join(sessions, `session-${String(index).padStart(2, "0")}.jsonl`),
        fixture.replaceAll(fixtureSessionId, id),
        "utf8",
      );
    }),
  );
  if (options.withMetadata) {
    await Promise.all([
      writeFile(
        join(codexHome, "session_index.jsonl"),
        `${JSON.stringify({
          id: "11111111-1111-4111-8111-000000000001",
          thread_name: "Indexed session title",
          updated_at: "2026-08-16T08:00:00.000Z",
        })}\n`,
        "utf8",
      ),
      writeFile(
        join(codexHome, ".codex-global-state.json"),
        JSON.stringify({
          "local-projects": {
            viewer: {
              id: "viewer",
              name: "Viewer",
              rootPaths: ["C:/work/viewer"],
              createdAt: 1,
              updatedAt: 2,
            },
          },
          "pinned-thread-ids": ["11111111-1111-4111-8111-000000000001"],
        }),
        "utf8",
      ),
      writeFile(join(codexHome, "state_5.sqlite"), "not a database", "utf8"),
    ]);
  }
  const cacheDir = join(root, "cache");
  const configDir = join(root, "config");
  const config: LoadedServerViewerConfig = {
    settings: { codexHome, port: 3_000, fetchFavicons: false },
    paths: {
      configDir,
      cacheDir,
      generatedDir: join(cacheDir, "generated"),
      configFile: join(configDir, "config.json"),
      cacheDatabase: join(cacheDir, "viewer.sqlite"),
    },
    codexHomeSource: "cli",
    onboardingRequired: false,
    diagnostics: [],
  };
  return LiveViewerRuntime.start(config, {
    readJsonl,
    reconciliationIntervalMs: 60_000,
    onError: options.onError,
  });
}

describe("progressive live search", () => {
  it("coalesces watcher changes by source and normalized path", () => {
    expect(coalesceSourceWatchBatches([])).toBeNull();
    expect(
      coalesceSourceWatchBatches([
        {
          observedAt: "2026-08-16T08:00:00.000Z",
          changes: [
            {
              source: "rollout",
              kind: "added",
              path: "C:/sessions/one.jsonl",
              scope: "active",
            },
            { source: "global-state", kind: "changed", path: "C:/state.json" },
          ],
        },
        {
          observedAt: "2026-08-16T08:00:01.000Z",
          changes: [
            {
              source: "rollout",
              kind: "changed",
              path: "C:/sessions/one.jsonl",
              scope: "active",
            },
          ],
        },
      ]),
    ).toEqual({
      observedAt: "2026-08-16T08:00:01.000Z",
      changes: [
        {
          source: "rollout",
          kind: "changed",
          path: "C:/sessions/one.jsonl",
          scope: "active",
        },
        { source: "global-state", kind: "changed", path: "C:/state.json" },
      ],
    });
  });

  it("loads optional metadata without making an invalid state snapshot authoritative", async () => {
    const runtime = await startRuntime(1, readStableJsonl, { withMetadata: true });

    try {
      await expect(
        runtime.repository.listSessions({ scope: "active", limit: 20 }),
      ).resolves.toMatchObject({
        items: [
          expect.objectContaining({
            summary: expect.objectContaining({ title: "Indexed session title", pinned: true }),
          }),
        ],
        total: 1,
      });
    } finally {
      await runtime.close();
    }
  });

  it("searches ready transcripts exactly and materializes cold roots only after explicit deep search", async () => {
    const readJsonl = vi.fn<StableJsonlReader>(readStableJsonl);
    const runtime = await startRuntime(3, readJsonl);
    const events: ViewerInvalidation[] = [];
    const unsubscribe = runtime.repository.subscribe((event) => events.push(event));

    try {
      const catalog = await runtime.repository.listSessions({
        scope: "active",
        limit: 20,
      });
      expect(catalog.total).toBe(3);
      expect(readJsonl).not.toHaveBeenCalled();

      const readyId = catalog.items[0]?.summary.id;
      if (readyId === undefined) {
        throw new Error("Expected the first catalog page to contain a session.");
      }
      await runtime.repository.prepareSessions([readyId]);
      expect(readJsonl).toHaveBeenCalledOnce();
      await expect(
        runtime.repository.search({ scope: "active", query: "parser", limit: 20 }),
      ).resolves.toMatchObject({ total: 1 });
      expect(readJsonl).toHaveBeenCalledOnce();

      const started = await runtime.repository.startDeepSearch({
        scope: "active",
        query: "parser",
      });
      expect(started).toMatchObject({ state: "queued", total: 2, completed: 0, failed: 0 });
      await vi.waitFor(async () => {
        await expect(runtime.repository.getDeepSearch(started.id)).resolves.toMatchObject({
          state: "completed",
          total: 2,
          completed: 2,
          failed: 0,
          resultCount: 3,
        });
      });
      expect(readJsonl).toHaveBeenCalledTimes(3);
      expect(
        events.filter(({ type, ids }) => type === "search.updated" && ids.includes(started.id))
          .length,
      ).toBeGreaterThanOrEqual(4);
    } finally {
      unsubscribe();
      await runtime.close();
    }
  });

  it("cancels the remaining owner work without starting another cold source", async () => {
    let releaseFirst!: () => void;
    let firstReadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstReadStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const readJsonl = vi.fn<StableJsonlReader>(async (path, options) => {
      if (readJsonl.mock.calls.length === 1) {
        firstReadStarted();
        await gate;
      }
      return readStableJsonl(path, options);
    });
    const runtime = await startRuntime(3, readJsonl);

    try {
      const job = await runtime.repository.startDeepSearch({ scope: "active", query: "parser" });
      await started;
      await runtime.repository.cancelDeepSearch(job.id);
      releaseFirst();
      await vi.waitFor(async () => {
        await expect(runtime.repository.getDeepSearch(job.id)).resolves.toMatchObject({
          state: "cancelled",
        });
      });
      await vi.waitFor(() => expect(readJsonl).toHaveBeenCalledOnce());
      expect(readJsonl).toHaveBeenCalledOnce();
    } finally {
      releaseFirst();
      await runtime.close();
    }
  });

  it("counts failed materializations without preventing later cold sessions", async () => {
    const readJsonl = vi.fn<StableJsonlReader>(async (path, options) => {
      if (path.endsWith("session-00.jsonl")) {
        throw new Error("Synthetic materialization failure");
      }
      return readStableJsonl(path, options);
    });
    const runtime = await startRuntime(2, readJsonl);

    try {
      const started = await runtime.repository.startDeepSearch({
        scope: "active",
        query: "parser",
      });
      await vi.waitFor(async () => {
        await expect(runtime.repository.getDeepSearch(started.id)).resolves.toMatchObject({
          state: "completed",
          total: 2,
          completed: 1,
          failed: 1,
          resultCount: 1,
        });
      });
      expect(readJsonl).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.close();
    }
  });

  it("completes immediately after every root is ready and rejects unknown jobs", async () => {
    const runtime = await startRuntime(1);

    try {
      const catalog = await runtime.repository.listSessions({ scope: "active", limit: 20 });
      const id = catalog.items[0]?.summary.id;
      if (id === undefined) {
        throw new Error("Expected one catalog session.");
      }
      await expect(
        runtime.repository.prepareSessions([id, id, "missing-session"]),
      ).resolves.toEqual([
        { id, state: "ready", error: null },
        { id, state: "ready", error: null },
        { id: "missing-session", state: "failed", error: "Conversation not found." },
      ]);

      await expect(
        runtime.repository.startDeepSearch({ scope: "active", query: "parser" }),
      ).resolves.toMatchObject({
        state: "completed",
        total: 0,
        completed: 0,
        failed: 0,
        resultCount: 1,
      });
      await expect(runtime.repository.getDeepSearch("missing-job")).rejects.toThrow(
        "Deep-search job not found",
      );
      await expect(runtime.repository.cancelDeepSearch("missing-job")).rejects.toThrow(
        "Deep-search job not found",
      );
    } finally {
      await runtime.close();
    }
  });

  it("reuses unchanged source manifests but refuses a missing normalized cache row", async () => {
    const readJsonl = vi.fn<StableJsonlReader>(readStableJsonl);
    const runtime = await startRuntime(1, readJsonl);

    try {
      const catalog = await runtime.repository.listSessions({ scope: "active", limit: 20 });
      const id = catalog.items[0]?.summary.id;
      if (id === undefined) {
        throw new Error("Expected one catalog session.");
      }
      await expect(runtime.repository.prepareSessions([id])).resolves.toEqual([
        { id, state: "ready", error: null },
      ]);
      runtime.database
        .prepare("UPDATE session_catalog SET materialization_state = 'queued' WHERE id = ?")
        .run(id);
      await expect(runtime.repository.prepareSessions([id])).resolves.toEqual([
        { id, state: "ready", error: null },
      ]);
      expect(readJsonl).toHaveBeenCalledOnce();

      runtime.database.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      runtime.database
        .prepare("UPDATE session_catalog SET materialization_state = 'cold' WHERE id = ?")
        .run(id);
      await expect(runtime.repository.prepareSessions([id])).resolves.toEqual([
        {
          id,
          state: "failed",
          error: "The source was unchanged but no normalized conversation is available.",
        },
      ]);
      expect(readJsonl).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
    }
  });

  it("refuses a rollout that changes to a different session identity before materialization", async () => {
    const runtime = await startRuntime(1);

    try {
      const catalog = await runtime.repository.listSessions({ scope: "active", limit: 20 });
      const selected = catalog.items[0];
      if (selected === undefined) {
        throw new Error("Expected one catalog session.");
      }
      const replacementId = "22222222-2222-4222-8222-222222222222";
      const fixture = await readFile(selected.summary.sourcePath, "utf8");
      await writeFile(
        selected.summary.sourcePath,
        fixture.replaceAll(selected.summary.id, replacementId),
        "utf8",
      );

      await expect(runtime.repository.prepareSessions([selected.summary.id])).resolves.toEqual([
        {
          id: selected.summary.id,
          state: "failed",
          error:
            "The viewer could not update this session cache; the last good cached revision was retained.",
        },
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("bounds lifecycle operations across duplicate starts and repeated closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-reconciler-lifecycle-"));
    temporaryRoots.push(root);
    const codexHome = join(root, "codex-home");
    await Promise.all([
      mkdir(join(codexHome, "sessions"), { recursive: true }),
      mkdir(join(codexHome, "archived_sessions"), { recursive: true }),
    ]);
    const database = openCacheDatabase(join(root, "viewer.sqlite"));
    const closeWatcher = vi.fn<() => Promise<void>>(async () => undefined);
    const onError = vi.fn<(error: unknown) => void>();
    let watcherOptions!: WatchSourcesOptions;
    const reconciler = new LiveReconciler({
      bus: new InvalidationBus(),
      cacheDir: join(root, "cache"),
      codexHome,
      database,
      debounceMs: 5,
      reconciliationIntervalMs: 60_000,
      fetchFavicons: false,
      watch: (options) => {
        watcherOptions = options;
        return { ready: Promise.resolve(), close: closeWatcher };
      },
      onError,
    });

    try {
      expect(reconciler.codexHome).toBe(codexHome);
      expect(reconciler.faviconOrigin("missing")).toBeNull();
      expect(reconciler.getDeepSearch("missing")).toBeNull();
      expect(reconciler.cancelDeepSearch("missing")).toBe(false);
      await reconciler.start();
      await watcherOptions.onBatch({
        observedAt: "2026-08-16T08:00:02.000Z",
        changes: [
          {
            source: "rollout",
            kind: "changed",
            path: join(codexHome, "sessions", "changed.jsonl"),
            scope: "active",
          },
        ],
      });
      watcherOptions.onError?.(new Error("Synthetic watcher error"));
      await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
      await expect(reconciler.start()).rejects.toThrow(
        "The live reconciler has already been started.",
      );
      await reconciler.reconcileNow("test");
      await expect(reconciler.ensureMaterialized("missing-session")).rejects.toThrow(
        "Conversation not found.",
      );
      await reconciler.close();
      await reconciler.close();
      await expect(reconciler.reconcileNow("closed")).resolves.toBeUndefined();
      await expect(reconciler.start()).rejects.toThrow(
        "The live reconciler has already been started.",
      );
      expect(closeWatcher).toHaveBeenCalledOnce();

      const closedBeforeStart = new LiveReconciler({
        bus: new InvalidationBus(),
        cacheDir: join(root, "second-cache"),
        codexHome,
        database,
        reconciliationIntervalMs: 60_000,
        fetchFavicons: false,
        watch: () => ({ ready: Promise.resolve(), close: async () => undefined }),
      });
      await closedBeforeStart.close();
      await expect(closedBeforeStart.start()).rejects.toThrow(
        "A closed live reconciler cannot be restarted.",
      );
    } finally {
      await reconciler.close();
      database.close();
    }
  });

  it("rejects reconciliation intervals below the bounded recovery minimum", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-reconciler-lifecycle-"));
    temporaryRoots.push(root);
    const database = openCacheDatabase(join(root, "viewer.sqlite"));
    try {
      const origin = "https://example.test";
      database.prepare("INSERT INTO favicons (origin, status) VALUES (?, 'missing')").run(origin);
      const defaults = new LiveReconciler({
        bus: new InvalidationBus(),
        cacheDir: join(root, "default-cache"),
        codexHome: root,
        database,
      });
      expect(defaults.faviconOrigin(Buffer.from(origin).toString("base64url"))).toBe(origin);
      await defaults.close();
      expect(
        () =>
          new LiveReconciler({
            bus: new InvalidationBus(),
            cacheDir: join(root, "cache"),
            codexHome: root,
            database,
            reconciliationIntervalMs: 999,
          }),
      ).toThrow("reconciliationIntervalMs must be a safe integer of at least 1000");
    } finally {
      database.close();
    }
  });
});
