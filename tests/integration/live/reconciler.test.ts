import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getCachedSession } from "../../../server/cache/conversationStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import { readStableJsonl } from "../../../server/ingestion/jsonlStream.ts";
import { InvalidationBus } from "../../../server/live/invalidationBus.ts";
import { coalesceSourceWatchBatches, LiveReconciler } from "../../../server/live/reconciler.ts";
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
  const root = await mkdtemp(join(tmpdir(), "codex-viewer-live-"));
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
      expect(readOffsets).toEqual([0, 0]);
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
});
