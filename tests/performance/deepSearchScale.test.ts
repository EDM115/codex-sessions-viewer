import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openCacheDatabase } from "../../server/cache/database.ts";
import type { StableJsonlReader } from "../../server/cache/sourceManifest.ts";
import { readStableJsonl } from "../../server/ingestion/jsonlStream.ts";
import { InvalidationBus } from "../../server/live/invalidationBus.ts";
import { LiveReconciler } from "../../server/live/reconciler.ts";
import type { SearchQuery, ViewerInvalidation } from "../../shared/types/repository.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function deepSearchHome(count: number): Promise<{ cacheDir: string; codexHome: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-viewer-deep-search-scale-"));
  temporaryRoots.push(root);
  const codexHome = join(root, "codex-home");
  const sessions = join(codexHome, "sessions", "2026", "08", "20");
  await Promise.all([
    mkdir(sessions, { recursive: true }),
    mkdir(join(codexHome, "archived_sessions"), { recursive: true }),
  ]);
  const fixture = await readFile(
    join(process.cwd(), "tests", "fixtures", "rollouts", "modern.jsonl"),
    "utf8",
  );
  const fixtureId = "11111111-1111-4111-8111-111111111111";
  await Promise.all(
    Array.from({ length: count }, (_, index) => {
      const id = `88888888-8888-4888-8888-${String(index).padStart(12, "0")}`;
      return writeFile(
        join(sessions, `session-${String(index).padStart(3, "0")}.jsonl`),
        fixture.replaceAll(fixtureId, id),
        "utf8",
      );
    }),
  );
  return { codexHome, cacheDir: join(root, "cache") };
}

describe("deep-search scale", () => {
  it("keeps exact result recounts constant while preserving every progress transition", async () => {
    const sessionCount = 24;
    const { codexHome, cacheDir } = await deepSearchHome(sessionCount);
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    const events: ViewerInvalidation[] = [];
    const countSearchResults = vi
      .fn<(database: DatabaseSync, query: SearchQuery) => number>()
      .mockReturnValueOnce(0)
      .mockReturnValue(sessionCount);
    const reconciler = new LiveReconciler({
      bus,
      cacheDir,
      codexHome,
      database,
      reconciliationIntervalMs: 60_000,
      countSearchResults,
      watch: () => ({ ready: new Promise<void>(() => undefined), close: async () => undefined }),
    });

    try {
      await reconciler.start();
      bus.subscribe((event) => events.push(event));
      const job = reconciler.startDeepSearch({ scope: "active", query: "parser" });
      await vi.waitFor(
        () => {
          expect(reconciler.getDeepSearch(job.id)).toMatchObject({
            state: "completed",
            total: sessionCount,
            completed: sessionCount,
            failed: 0,
            resultCount: sessionCount,
          });
        },
        { timeout: 10_000 },
      );

      expect(countSearchResults).toHaveBeenCalledTimes(2);
      expect(
        events.filter(({ type, ids }) => type === "search.updated" && ids.includes(job.id)),
      ).toHaveLength(sessionCount + 3);
    } finally {
      await reconciler.close();
      database.close();
    }
  }, 20_000);

  it("does not recount after cancellation stops the remaining sources", async () => {
    const { codexHome, cacheDir } = await deepSearchHome(3);
    const database = openCacheDatabase(":memory:");
    const countSearchResults = vi.fn<(database: DatabaseSync, query: SearchQuery) => number>(
      () => 0,
    );
    let releaseFirst!: () => void;
    let firstReadStarted!: () => void;
    const firstRead = new Promise<void>((resolve) => {
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
    const reconciler = new LiveReconciler({
      bus: new InvalidationBus(),
      cacheDir,
      codexHome,
      database,
      readJsonl,
      countSearchResults,
      reconciliationIntervalMs: 60_000,
      watch: () => ({ ready: new Promise<void>(() => undefined), close: async () => undefined }),
    });

    try {
      await reconciler.start();
      const job = reconciler.startDeepSearch({ scope: "active", query: "parser" });
      await firstRead;
      expect(reconciler.cancelDeepSearch(job.id)).toBe(true);
      releaseFirst();
      await vi.waitFor(() => expect(reconciler.getDeepSearch(job.id)?.state).toBe("cancelled"));
      expect(readJsonl).toHaveBeenCalledOnce();
      expect(countSearchResults).toHaveBeenCalledOnce();
    } finally {
      releaseFirst();
      await reconciler.close();
      database.close();
    }
  });

  it("reports initial and terminal count failures without guessing a completed result", async () => {
    const initialFixture = await deepSearchHome(1);
    const initialDatabase = openCacheDatabase(":memory:");
    const initialFailure = vi.fn<(database: DatabaseSync, query: SearchQuery) => number>(() => {
      throw new Error("Initial count failed");
    });
    const initial = new LiveReconciler({
      bus: new InvalidationBus(),
      ...initialFixture,
      database: initialDatabase,
      countSearchResults: initialFailure,
      reconciliationIntervalMs: 60_000,
      watch: () => ({ ready: new Promise<void>(() => undefined), close: async () => undefined }),
    });
    try {
      await initial.start();
      expect(initial.startDeepSearch({ scope: "active", query: "parser" })).toMatchObject({
        state: "failed",
        resultCount: 0,
        error: "Initial count failed",
      });
      expect(initialFailure).toHaveBeenCalledOnce();
    } finally {
      await initial.close();
      initialDatabase.close();
    }

    const terminalFixture = await deepSearchHome(1);
    const terminalDatabase = openCacheDatabase(":memory:");
    const terminalFailure = vi
      .fn<(database: DatabaseSync, query: SearchQuery) => number>()
      .mockReturnValueOnce(0)
      .mockImplementationOnce(() => {
        throw new Error("Terminal count failed");
      });
    const terminal = new LiveReconciler({
      bus: new InvalidationBus(),
      ...terminalFixture,
      database: terminalDatabase,
      countSearchResults: terminalFailure,
      reconciliationIntervalMs: 60_000,
      watch: () => ({ ready: new Promise<void>(() => undefined), close: async () => undefined }),
    });
    try {
      await terminal.start();
      const job = terminal.startDeepSearch({ scope: "active", query: "parser" });
      await vi.waitFor(() => {
        expect(terminal.getDeepSearch(job.id)).toMatchObject({
          state: "failed",
          resultCount: 0,
          error: "Terminal count failed",
        });
      });
      expect(terminalFailure).toHaveBeenCalledTimes(2);
    } finally {
      await terminal.close();
      terminalDatabase.close();
    }
  });
});
