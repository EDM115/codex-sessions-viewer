import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { StableJsonlReader } from "../../server/cache/sourceManifest.ts";
import type { LoadedServerViewerConfig } from "../../server/core/config.ts";
import { readStableJsonl } from "../../server/ingestion/jsonlStream.ts";
import { LiveViewerRuntime } from "../../server/live/viewerRuntime.ts";
import type { ViewerInvalidation } from "../../shared/types/repository.ts";

const temporaryRoots: string[] = [];
const fixtureSessionId = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function startRuntime(count: number, readJsonl: StableJsonlReader = readStableJsonl) {
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
  return LiveViewerRuntime.start(config, { readJsonl, reconciliationIntervalMs: 60_000 });
}

describe("progressive live search", () => {
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
});
