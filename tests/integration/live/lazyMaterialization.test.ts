import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { catalogSession } from "../../../server/cache/catalogStore.ts";
import { getCachedSession } from "../../../server/cache/conversationStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import type { LoadedServerViewerConfig } from "../../../server/core/config.ts";
import { readStableJsonl } from "../../../server/ingestion/jsonlStream.ts";
import { InvalidationBus } from "../../../server/live/invalidationBus.ts";
import { LiveReconciler } from "../../../server/live/reconciler.ts";
import { LiveViewerRuntime } from "../../../server/live/viewerRuntime.ts";
import type { ViewerInvalidation } from "../../../shared/types/repository.ts";

const temporaryRoots: string[] = [];
const fixtureSessionId = "11111111-1111-4111-8111-111111111111";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let settle = (): void => {
    throw new Error("Deferred promise was resolved before initialization.");
  };
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("lazy live materialization", () => {
  it("starts from catalog metadata, pages at 20, and parses only an explicitly prepared session", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-lazy-live-"));
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
      Array.from({ length: 21 }, (_, index) => {
        const id = `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`;
        return writeFile(
          join(sessions, `session-${String(index).padStart(2, "0")}.jsonl`),
          fixture.replaceAll(fixtureSessionId, id),
          "utf8",
        );
      }),
    );
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
    const readJsonl = vi.fn<typeof readStableJsonl>(readStableJsonl);
    const runtime = await LiveViewerRuntime.start(config, {
      readJsonl,
      reconciliationIntervalMs: 60_000,
    });

    try {
      expect(readJsonl).not.toHaveBeenCalled();
      const page = await runtime.repository.listSessions({ scope: "active", limit: 20 });
      expect(page.items).toHaveLength(20);
      expect(page.total).toBe(21);
      expect(page.nextCursor).toBe("20");
      expect(page.items.every(({ materialization }) => materialization === "cold")).toBe(true);

      const id = page.items[0]?.summary.id;
      if (id === undefined) {
        throw new Error("Expected the first catalog page to contain a session.");
      }
      await expect(runtime.repository.prepareSessions([id])).resolves.toEqual([
        { id, state: "ready", error: null },
      ]);
      expect(readJsonl).toHaveBeenCalledOnce();
      await expect(runtime.repository.getSession(id)).resolves.toMatchObject({ id });
      expect(readJsonl).toHaveBeenCalledOnce();
      expect(runtime.database.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({
        count: 1,
      });
    } finally {
      await runtime.close();
    }
  });

  it("discards a materialization result when reconciliation advances its catalog revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-materialization-race-"));
    temporaryRoots.push(root);
    const codexHome = join(root, "codex-home");
    const sessions = join(codexHome, "sessions", "2026", "08", "20");
    const rollout = join(sessions, "session-race.jsonl");
    await Promise.all([
      mkdir(sessions, { recursive: true }),
      mkdir(join(codexHome, "archived_sessions"), { recursive: true }),
    ]);
    const revisionA = await readFile(
      join(process.cwd(), "tests", "fixtures", "rollouts", "modern.jsonl"),
      "utf8",
    );
    const revisionB = `${revisionA.trimEnd()}\n${[
      '{"timestamp":"2026-08-20T10:00:21.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-revision-b"}}',
      '{"timestamp":"2026-08-20T10:00:22.000Z","type":"event_msg","payload":{"type":"user_message","message":"Revision B","images":[],"local_images":[]}}',
      '{"timestamp":"2026-08-20T10:00:23.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-revision-b","last_agent_message":"Revision B complete"}}',
    ].join("\n")}\n`;
    await writeFile(rollout, revisionA, "utf8");
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    const events: ViewerInvalidation[] = [];
    bus.subscribe((event) => events.push(event));
    const firstReadCaptured = deferred();
    const releaseFirstRead = deferred();
    let readCount = 0;
    const reconciler = new LiveReconciler({
      bus,
      cacheDir: join(root, "cache"),
      codexHome,
      database,
      reconciliationIntervalMs: 60_000,
      watch: () => ({ ready: new Promise<void>(() => undefined), close: async () => undefined }),
      async readJsonl(path, options) {
        readCount += 1;
        const captured = await readStableJsonl(path, options);
        if (readCount !== 1) {
          return captured;
        }
        if (captured.read.status !== "stable") {
          throw new Error("Expected the first materialization read to be stable.");
        }
        firstReadCaptured.resolve();
        await releaseFirstRead.promise;
        const current = await stat(path, { bigint: true });
        return {
          ...captured,
          read: {
            ...captured.read,
            identity: { device: current.dev, inode: current.ino },
            size: Number(current.size),
            mtimeMs: Number(current.mtimeNs) / 1_000_000,
          },
        };
      },
    });

    try {
      await reconciler.start();
      const id = String(database.prepare("SELECT id FROM session_catalog").get()?.["id"]);
      const expectedRevisionA = `sha256:${createHash("sha256").update(revisionA).digest("hex")}`;
      const expectedRevisionB = `sha256:${createHash("sha256").update(revisionB).digest("hex")}`;
      const materialization = reconciler.prepareSessions([id]);
      await firstReadCaptured.promise;
      await writeFile(rollout, revisionB, "utf8");
      await reconciler.reconcileNow("advance-source-revision");
      const catalogRevisionB = catalogSession(database, id)?.sourceRevision;
      expect(catalogRevisionB).not.toBeNull();
      expect(catalogRevisionB).not.toBeUndefined();
      releaseFirstRead.resolve();

      await expect(materialization).resolves.toEqual([{ id, state: "ready", error: null }]);
      expect(readCount).toBe(2);
      expect(catalogSession(database, id)).toMatchObject({
        materialization: "ready",
        sourceRevision: catalogRevisionB,
      });
      const cached = getCachedSession(database, id);
      expect(cached?.summary.revision).toBe(expectedRevisionB);
      expect(
        cached?.turns.flatMap((turn) =>
          [turn.userMessage, ...(turn.steeringMessages ?? []), ...turn.assistantMessages]
            .filter((message) => message !== null)
            .map(({ sourceMarkdown }) => sourceMarkdown),
        ),
      ).toContain("Revision B");
      expect(events.some(({ revision }) => revision === expectedRevisionA)).toBe(false);
    } finally {
      releaseFirstRead.resolve();
      await reconciler.close();
      database.close();
    }
  });

  it("bounds retries when the catalog advances during both materialization attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-materialization-bounded-"));
    temporaryRoots.push(root);
    const codexHome = join(root, "codex-home");
    const sessions = join(codexHome, "sessions", "2026", "08", "20");
    const rollout = join(sessions, "session-changing.jsonl");
    await Promise.all([
      mkdir(sessions, { recursive: true }),
      mkdir(join(codexHome, "archived_sessions"), { recursive: true }),
    ]);
    const revisionA = await readFile(
      join(process.cwd(), "tests", "fixtures", "rollouts", "modern.jsonl"),
      "utf8",
    );
    const revisionB = `${revisionA.trimEnd()}\n{"timestamp":"2026-08-20T11:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"Revision B","images":[],"local_images":[]}}\n`;
    const revisionC = `${revisionB.trimEnd()}\n{"timestamp":"2026-08-20T11:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"Revision C","images":[],"local_images":[]}}\n`;
    await writeFile(rollout, revisionA, "utf8");
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    const events: ViewerInvalidation[] = [];
    bus.subscribe((event) => events.push(event));
    const capturedReads = [deferred(), deferred()] as const;
    const releasedReads = [deferred(), deferred()] as const;
    let readCount = 0;
    const reconciler = new LiveReconciler({
      bus,
      cacheDir: join(root, "cache"),
      codexHome,
      database,
      reconciliationIntervalMs: 60_000,
      watch: () => ({ ready: new Promise<void>(() => undefined), close: async () => undefined }),
      async readJsonl(path, options) {
        const readIndex = readCount;
        readCount += 1;
        const captured = await readStableJsonl(path, options);
        const capturedSignal = capturedReads.at(readIndex);
        const releaseSignal = releasedReads.at(readIndex);
        if (capturedSignal === undefined || releaseSignal === undefined) {
          throw new Error("Materialization exceeded its bounded two-read budget.");
        }
        if (captured.read.status !== "stable") {
          throw new Error("Expected each materialization read to be stable.");
        }
        capturedSignal.resolve();
        await releaseSignal.promise;
        const current = await stat(path, { bigint: true });
        return {
          ...captured,
          read: {
            ...captured.read,
            identity: { device: current.dev, inode: current.ino },
            size: Number(current.size),
            mtimeMs: Number(current.mtimeNs) / 1_000_000,
          },
        };
      },
    });

    try {
      await reconciler.start();
      const id = String(database.prepare("SELECT id FROM session_catalog").get()?.["id"]);
      const expectedRevisionA = `sha256:${createHash("sha256").update(revisionA).digest("hex")}`;
      const expectedRevisionB = `sha256:${createHash("sha256").update(revisionB).digest("hex")}`;
      const materialization = reconciler.prepareSessions([id]);
      await capturedReads[0].promise;
      await writeFile(rollout, revisionB, "utf8");
      await reconciler.reconcileNow("advance-to-b");
      releasedReads[0].resolve();
      await capturedReads[1].promise;
      await writeFile(rollout, revisionC, "utf8");
      await reconciler.reconcileNow("advance-to-c");
      const latestRevision = catalogSession(database, id)?.sourceRevision;
      releasedReads[1].resolve();

      await expect(materialization).resolves.toEqual([
        {
          id,
          state: "cold",
          error: "The conversation changed again during materialization; retry is required.",
        },
      ]);
      expect(readCount).toBe(2);
      expect(catalogSession(database, id)).toMatchObject({
        materialization: "cold",
        sourceRevision: latestRevision,
      });
      expect(getCachedSession(database, id)).toBeNull();
      expect(database.prepare("SELECT count(*) AS count FROM diagnostics").get()).toEqual({
        count: 0,
      });
      expect(
        events.some(
          ({ revision }) => revision === expectedRevisionA || revision === expectedRevisionB,
        ),
      ).toBe(false);
    } finally {
      for (const release of releasedReads) {
        release.resolve();
      }
      await reconciler.close();
      database.close();
    }
  });
});
