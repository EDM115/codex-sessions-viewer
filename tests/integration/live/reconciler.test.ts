import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  catalogSession,
  listCatalogProjects,
  listCatalogSessions,
} from "../../../server/cache/catalogStore.ts";
import { getCachedSession } from "../../../server/cache/conversationStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import { discoverSources } from "../../../server/ingestion/discoverSources.ts";
import { readStableJsonl } from "../../../server/ingestion/jsonlStream.ts";
import { readSessionMetaPrefix } from "../../../server/ingestion/sessionMetaPrefix.ts";
import type { WatchSourcesOptions } from "../../../server/ingestion/watchSources.ts";
import { InvalidationBus } from "../../../server/live/invalidationBus.ts";
import { coalesceSourceWatchBatches, LiveReconciler } from "../../../server/live/reconciler.ts";
import { readSessionIndex } from "../../../server/metadata/sessionIndex.ts";
import type { ViewerInvalidation } from "../../../shared/types/repository.ts";

const temporaryRoots: string[] = [];

async function fixture(): Promise<string> {
  return readFile(join(process.cwd(), "tests", "fixtures", "rollouts", "modern.jsonl"), "utf8");
}

async function createCodexHome(): Promise<{
  codexHome: string;
  rollout: string;
  cacheDir: string;
}> {
  const directory = join(process.cwd(), ".tmp", "task2-tests");
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(join(directory, "codex-viewer-live-"));
  temporaryRoots.push(root);
  const codexHome = join(root, "codex-home");
  const rollout = join(codexHome, "sessions", "2026", "08", "14", "modern.jsonl");
  await Promise.all([
    mkdir(join(codexHome, "sessions", "2026", "08", "14"), { recursive: true }),
    mkdir(join(codexHome, "archived_sessions"), { recursive: true }),
  ]);
  await writeFile(rollout, await fixture(), "utf8");
  return { codexHome, rollout, cacheDir: join(root, "viewer-cache") };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("live reconciliation", () => {
  it("publishes grouping changes alongside a renamed row and another folder's same-count manual order", async () => {
    const { codexHome, cacheDir } = await createCodexHome();
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    const events: ViewerInvalidation[] = [];
    const globalPath = join(codexHome, ".codex-global-state.json");
    const indexPath = join(codexHome, "session_index.jsonl");
    const state = {
      "local-projects": { b: { id: "b", name: "B", rootPaths: [] } },
      "thread-project-assignments": {
        "row-b": { projectKind: "local", projectId: "b" },
        "row-c": { projectKind: "local", projectId: "b" },
      },
      "sidebar-project-thread-orders": { b: { threadIds: ["row-b", "row-c"] } },
      "electron-persisted-atom-state": {
        "flat-project-sidebar-preferences-v1": { chatSortMode: "manual" },
      },
    };
    await Promise.all(
      ["row-b", "row-c"].map((id) =>
        writeFile(
          join(codexHome, "sessions", `${id}.jsonl`),
          JSON.stringify({
            type: "session_meta",
            payload: { id, thread_source: "user", source: "cli" },
          }) + "\n",
        ),
      ),
    );
    await writeFile(globalPath, JSON.stringify(state));
    let watcherOptions!: WatchSourcesOptions;
    const reconciler = new LiveReconciler({
      codexHome,
      cacheDir,
      database,
      bus,
      watch(options) {
        watcherOptions = options;
        return { ready: new Promise<void>(() => undefined), close: async () => undefined };
      },
    });
    try {
      await reconciler.start();
      bus.subscribe((event) => events.push(event));
      const id = "11111111-1111-4111-8111-111111111111";
      expect(
        listCatalogSessions(database, { scope: "active", projectId: "b" }).items.map(
          (item) => item.summary.id,
        ),
      ).toEqual(["row-b", "row-c"]);
      state["sidebar-project-thread-orders"].b.threadIds = ["row-c", "row-b"];
      await writeFile(globalPath, JSON.stringify(state));
      await writeFile(
        indexPath,
        JSON.stringify({ id, thread_name: "Renamed A", updated_at: "2026-10-27T00:00:00.000Z" }) +
          "\n",
      );
      await watcherOptions.onBatch({
        observedAt: "2026-10-27T00:00:00.000Z",
        changes: [
          { source: "global-state", path: globalPath, kind: "changed" },
          { source: "session-index", path: indexPath, kind: "added" },
        ],
      });
      await vi.waitFor(() =>
        expect(events).toContainEqual({
          type: "library.updated",
          ids: [id],
          groupsChanged: true,
          revision: expect.any(String),
        }),
      );
      expect(catalogSession(database, id)?.summary.title).toBe("Renamed A");
      expect(
        listCatalogSessions(database, { scope: "active", projectId: "b" }).items.map(
          (item) => item.summary.id,
        ),
      ).toEqual(["row-c", "row-b"]);
    } finally {
      await reconciler.close();
      database.close();
    }
  });
  it("announces saved-project-only changes and stays quiet when grouping metadata is unchanged", async () => {
    const { codexHome, cacheDir } = await createCodexHome();
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    const events: ViewerInvalidation[] = [];
    let watcherOptions!: WatchSourcesOptions;
    const reconciler = new LiveReconciler({
      codexHome,
      cacheDir,
      database,
      bus,
      watch(options) {
        watcherOptions = options;
        return { ready: new Promise<void>(() => undefined), close: async () => undefined };
      },
    });
    try {
      await reconciler.start();
      bus.subscribe((event) => events.push(event));
      const path = join(codexHome, ".codex-global-state.json");
      await writeFile(
        path,
        JSON.stringify({
          "local-projects": { saved: { id: "saved", name: "Empty saved", rootPaths: [] } },
        }),
      );
      await watcherOptions.onBatch({
        observedAt: "2026-10-27T00:00:00.000Z",
        changes: [{ source: "global-state", path, kind: "added" }],
      });
      await vi.waitFor(() =>
        expect(events).toContainEqual({
          type: "library.updated",
          ids: [],
          groupsChanged: true,
          revision: expect.any(String),
        }),
      );
      expect(listCatalogProjects(database)).toContainEqual(
        expect.objectContaining({
          id: "saved",
          name: "Empty saved",
          activeCount: 0,
          archivedCount: 0,
        }),
      );
      events.splice(0);
      const before = database.prepare("SELECT total_changes() AS count").get()?.["count"];
      await watcherOptions.onBatch({
        observedAt: "2026-10-27T00:00:01.000Z",
        changes: [{ source: "global-state", path, kind: "changed" }],
      });
      await reconciler.reconcileNow("unchanged-grouping");
      expect(database.prepare("SELECT total_changes() AS count").get()?.["count"]).toBe(before);
      expect(events.filter((event) => event.type === "library.updated")).toEqual([]);
    } finally {
      await reconciler.close();
      database.close();
    }
  });
  it("revalidates a persisted ready conversation on open after a preserved-stat rewrite", async () => {
    const { codexHome, rollout, cacheDir } = await createCodexHome();
    const database = openCacheDatabase(":memory:");
    const reconciler = new LiveReconciler({
      codexHome,
      cacheDir,
      database,
      bus: new InvalidationBus(),
      watch: () => ({ ready: Promise.resolve(), close: async () => undefined }),
    });
    try {
      await reconciler.start();
      const id = "11111111-1111-4111-8111-111111111111";
      await reconciler.ensureMaterialized(id);
      const before = await stat(rollout);
      await writeFile(rollout, (await fixture()).replace("Build the parser", "Build NEW parser"));
      await utimes(rollout, before.atime, before.mtime);
      await reconciler.ensureMaterialized(id);
      expect(getCachedSession(database, id)?.summary.preview).toBe("Build NEW parser");
    } finally {
      await reconciler.close();
      database.close();
    }
  });
  it("coalesces repeated pending source changes to their latest observation", () => {
    expect(
      coalesceSourceWatchBatches([
        {
          changes: [
            { source: "rollout", scope: "active", path: "C:/sessions/a.jsonl", kind: "changed" },
          ],
          observedAt: "2026-08-14T10:00:00.000Z",
        },
        {
          changes: [
            { source: "rollout", scope: "active", path: "C:/sessions/a.jsonl", kind: "removed" },
            { source: "session-index", path: "C:/session_index.jsonl", kind: "changed" },
          ],
          observedAt: "2026-08-14T10:00:01.000Z",
        },
      ]),
    ).toEqual({
      changes: [
        { source: "rollout", scope: "active", path: "C:/sessions/a.jsonl", kind: "removed" },
        { source: "session-index", path: "C:/session_index.jsonl", kind: "changed" },
      ],
      observedAt: "2026-08-14T10:00:01.000Z",
    });
  });

  it("publishes the metadata catalog without waiting for the watcher initial scan", async () => {
    const { codexHome, cacheDir } = await createCodexHome();
    const database = openCacheDatabase(":memory:");
    const closeWatcher = vi.fn(async () => undefined);
    const reconciler = new LiveReconciler({
      bus: new InvalidationBus(),
      cacheDir,
      codexHome,
      database,
      reconciliationIntervalMs: 60_000,
      watch: () => ({ ready: new Promise<void>(() => undefined), close: closeWatcher }),
    });

    try {
      await expect(reconciler.start()).resolves.toBeUndefined();
      expect(database.prepare("SELECT count(*) AS count FROM session_catalog").get()).toEqual({
        count: 1,
      });
    } finally {
      await reconciler.close();
      database.close();
    }
    expect(closeWatcher).toHaveBeenCalledOnce();
  });

  it("updates only the appended session and publishes its changed turn IDs", async () => {
    const { codexHome, rollout, cacheDir } = await createCodexHome();
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    const events: ViewerInvalidation[] = [];
    const readOffsets: number[] = [];
    const reconciler = new LiveReconciler({
      bus,
      cacheDir,
      codexHome,
      database,
      debounceMs: 25,
      reconciliationIntervalMs: 60_000,
      async readJsonl(path, options) {
        readOffsets.push(options.start ?? 0);
        return readStableJsonl(path, options);
      },
    });

    try {
      await reconciler.start();
      const row = database.prepare("SELECT id FROM session_catalog").get();
      const sessionId = String(row?.["id"]);
      expect(database.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({
        count: 0,
      });
      await expect(reconciler.prepareSessions([sessionId])).resolves.toEqual([
        { id: sessionId, state: "ready", error: null },
      ]);
      const before = getCachedSession(database, sessionId);
      bus.subscribe((event) => events.push(event));

      await appendFile(
        rollout,
        [
          '{"timestamp":"2026-08-14T10:00:21.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-live"}}',
          '{"timestamp":"2026-08-14T10:00:22.000Z","type":"event_msg","payload":{"type":"user_message","message":"Live append","images":[],"local_images":[]}}',
          '{"timestamp":"2026-08-14T10:00:23.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-live","last_agent_message":"Done"}}',
        ].join("\n") + "\n",
        "utf8",
      );

      await vi.waitFor(
        () => {
          expect(getCachedSession(database, sessionId)?.summary.turnCount).toBe(
            (before?.summary.turnCount ?? 0) + 1,
          );
          expect(events).toContainEqual(
            expect.objectContaining({
              type: "session.updated",
              ids: expect.arrayContaining([sessionId]),
            }),
          );
        },
        { timeout: 3_000, interval: 25 },
      );
      const sessionEvent = events.find(({ type }) => type === "session.updated");
      expect(sessionEvent?.ids).toContain(getCachedSession(database, sessionId)?.turns.at(-1)?.id);
      expect(readOffsets).toEqual([0, Buffer.byteLength(await fixture())]);
    } finally {
      await reconciler.close();
      database.close();
    }
  });

  it("uses fingerprints during reconciliation instead of rereading unchanged transcripts", async () => {
    const { codexHome, cacheDir } = await createCodexHome();
    const database = openCacheDatabase(":memory:");
    const readJsonl = vi.fn<typeof readStableJsonl>(readStableJsonl);
    const reconciler = new LiveReconciler({
      bus: new InvalidationBus(),
      cacheDir,
      codexHome,
      database,
      readJsonl,
      reconciliationIntervalMs: 60_000,
    });

    try {
      await reconciler.start();
      expect(readJsonl).not.toHaveBeenCalled();
      await reconciler.reconcileNow("test");
      expect(readJsonl).not.toHaveBeenCalled();
      const id = String(database.prepare("SELECT id FROM session_catalog").get()?.["id"]);
      await expect(reconciler.prepareSessions([id])).resolves.toEqual([
        { id, state: "ready", error: null },
      ]);
      expect(readJsonl).toHaveBeenCalledOnce();
      await reconciler.reconcileNow("unchanged");
      expect(readJsonl).toHaveBeenCalledOnce();
    } finally {
      await reconciler.close();
      database.close();
    }
  });

  it("consumes rollout and metadata watcher details without broad discovery, prefix reads, or invalidations", async () => {
    const { codexHome, rollout, cacheDir } = await createCodexHome();
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    const events: ViewerInvalidation[] = [];
    const discover = vi.fn(discoverSources);
    const readPrefix = vi.fn(readSessionMetaPrefix);
    const readIndex = vi.fn(readSessionIndex);
    let watcherOptions!: WatchSourcesOptions;
    const reconciler = new LiveReconciler({
      bus,
      cacheDir,
      codexHome,
      database,
      reconciliationIntervalMs: 60_000,
      discover,
      readPrefix,
      readSessionIndex: readIndex,
      watch(options) {
        watcherOptions = options;
        return { ready: new Promise<void>(() => undefined), close: async () => undefined };
      },
    });

    try {
      await reconciler.start();
      const id = String(database.prepare("SELECT id FROM session_catalog").get()?.["id"]);
      bus.subscribe((event) => events.push(event));

      await reconciler.reconcileNow("unchanged");
      expect(readPrefix).toHaveBeenCalledOnce();
      expect(events.filter(({ type }) => type === "library.updated")).toEqual([]);
      const discoveryCallsBeforeBatches = discover.mock.calls.length;

      await appendFile(rollout, "\n", "utf8");
      await watcherOptions.onBatch({
        observedAt: "2026-08-20T10:00:00.000Z",
        changes: [{ source: "rollout", scope: "active", path: rollout, kind: "changed" }],
      });
      await vi.waitFor(() => {
        expect(events).toContainEqual({
          type: "library.updated",
          ids: [id],
          revision: expect.any(String),
        });
      });
      expect(discover).toHaveBeenCalledTimes(discoveryCallsBeforeBatches);
      expect(readPrefix).toHaveBeenCalledTimes(2);

      events.splice(0);
      const sessionIndexPath = join(codexHome, "session_index.jsonl");
      await writeFile(
        sessionIndexPath,
        `${JSON.stringify({
          id,
          thread_name: "Renamed from watcher metadata",
          updated_at: "2026-08-20T10:00:01.000Z",
        })}\n`,
        "utf8",
      );
      await watcherOptions.onBatch({
        observedAt: "2026-08-20T10:00:01.000Z",
        changes: [{ source: "session-index", path: sessionIndexPath, kind: "added" }],
      });
      await vi.waitFor(() => {
        expect(database.prepare("SELECT title FROM session_catalog WHERE id = ?").get(id)).toEqual({
          title: "Renamed from watcher metadata",
        });
      });
      expect(discover).toHaveBeenCalledTimes(discoveryCallsBeforeBatches);
      expect(readPrefix).toHaveBeenCalledTimes(2);
      expect(readIndex).toHaveBeenCalledOnce();
      expect(events).toEqual([
        { type: "library.updated", ids: [id], groupsChanged: true, revision: expect.any(String) },
        {
          type: "diagnostic.updated",
          ids: ["metadata.snapshot_invalid:viewer"],
          revision: expect.any(String),
        },
      ]);
      expect(catalogSession(database, id)?.structuralEvidence?.classification).toMatchObject({
        visibility: "delegated-child",
        parentThreadId: "00000000-0000-4000-8000-000000000001",
      });

      events.splice(0);
      await rm(rollout);
      await watcherOptions.onBatch({
        observedAt: "2026-08-20T10:00:02.000Z",
        changes: [{ source: "rollout", scope: "active", path: rollout, kind: "removed" }],
      });
      await vi.waitFor(() => {
        expect(database.prepare("SELECT count(*) AS count FROM session_catalog").get()).toEqual({
          count: 1,
        });
        expect(database.prepare("SELECT error FROM session_catalog WHERE id = ?").get(id)).toEqual({
          error: "Rollout source is temporarily unavailable, awaiting a stable representation.",
        });
      });
      expect(discover).toHaveBeenCalledTimes(discoveryCallsBeforeBatches);
      expect(readPrefix).toHaveBeenCalledTimes(2);
      expect(events).toEqual([
        { type: "library.updated", ids: [id], revision: expect.any(String) },
        {
          type: "diagnostic.updated",
          ids: ["metadata.snapshot_invalid:viewer"],
          revision: expect.any(String),
        },
      ]);
      expect(catalogSession(database, id)?.structuralEvidence?.classification).toMatchObject({
        visibility: "delegated-child",
        parentThreadId: "00000000-0000-4000-8000-000000000001",
      });
    } finally {
      await reconciler.close();
      database.close();
    }
  });

  it("verifies a content-identical touch through the source manifest without catalog invalidation", async () => {
    const { codexHome, rollout, cacheDir } = await createCodexHome();
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    const events: ViewerInvalidation[] = [];
    const readPrefix = vi.fn(readSessionMetaPrefix);
    let watcherOptions!: WatchSourcesOptions;
    const reconciler = new LiveReconciler({
      bus,
      cacheDir,
      codexHome,
      database,
      reconciliationIntervalMs: 60_000,
      readPrefix,
      watch(options) {
        watcherOptions = options;
        return { ready: new Promise<void>(() => undefined), close: async () => undefined };
      },
    });

    try {
      await reconciler.start();
      const id = String(database.prepare("SELECT id FROM session_catalog").get()?.["id"]);
      await expect(reconciler.prepareSessions([id])).resolves.toEqual([
        { id, state: "ready", error: null },
      ]);
      bus.subscribe((event) => events.push(event));
      const before = await stat(rollout);
      await utimes(rollout, before.atime, new Date(before.mtimeMs + 5_000));

      await watcherOptions.onBatch({
        observedAt: "2026-08-20T10:00:02.000Z",
        changes: [{ source: "rollout", scope: "active", path: rollout, kind: "changed" }],
      });
      await reconciler.reconcileNow("after-identical-touch");

      expect(readPrefix).toHaveBeenCalledOnce();
      expect(events.filter(({ type }) => type === "library.updated")).toEqual([]);
      const manifestMtime = database
        .prepare("SELECT mtime_ms FROM source_files WHERE path = ?")
        .get(rollout)?.["mtime_ms"];
      expect(typeof manifestMtime).toBe("number");
      expect(Math.abs(Number(manifestMtime) - (before.mtimeMs + 5_000))).toBeLessThan(2);
    } finally {
      await reconciler.close();
      database.close();
    }
  });
});
