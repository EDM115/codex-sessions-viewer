import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openCacheDatabase } from "../../../server/cache/database.ts";
import type { LoadedServerViewerConfig } from "../../../server/core/config.ts";
import { readStableJsonl } from "../../../server/ingestion/jsonlStream.ts";
import { LiveViewerRuntime } from "../../../server/live/viewerRuntime.ts";

const temporaryRoots: string[] = [];

async function createHome(root: string, fixture: "legacy.jsonl" | "modern.jsonl"): Promise<string> {
  const home = join(root, fixture.replace(".jsonl", "-home"));
  const sessions = join(home, "sessions", "2026", "08", "14");
  await Promise.all([
    mkdir(sessions, { recursive: true }),
    mkdir(join(home, "archived_sessions"), { recursive: true }),
  ]);
  await writeFile(
    join(sessions, fixture),
    await readFile(join(process.cwd(), "tests", "fixtures", "rollouts", fixture)),
  );
  return home;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("live Codex-home switching", () => {
  it("can defer initial reconciliation until the live page shell has been served", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-live-runtime-"));
    temporaryRoots.push(root);
    const codexHome = await createHome(root, "modern.jsonl");
    const configDir = join(root, "config");
    const cacheDir = join(root, "cache");
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
    const runtime = await LiveViewerRuntime.start(config, {
      initialReconciliation: "deferred",
      reconciliationIntervalMs: 60_000,
    });

    try {
      expect(runtime.status).toEqual({ state: "preparing", message: null });
      await expect(
        runtime.repository.listSessions({ scope: "active", limit: 10 }),
      ).resolves.toMatchObject({ items: [], total: 0 });
      await runtime.startInitialReconciliation();
      expect(runtime.status).toEqual({ state: "ready", message: null });
      await expect(
        runtime.repository.listSessions({ scope: "active", limit: 10 }),
      ).resolves.toMatchObject({ total: 1 });
    } finally {
      await runtime.close();
    }
  });

  it("returns a queryable runtime while initial reconciliation continues in the background", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-live-runtime-"));
    temporaryRoots.push(root);
    const codexHome = await createHome(root, "modern.jsonl");
    const configDir = join(root, "config");
    const cacheDir = join(root, "cache");
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
      initialReconciliation: "background",
      reconciliationIntervalMs: 60_000,
      readJsonl,
    });

    try {
      await expect(
        runtime.repository.listSessions({ scope: "active", limit: 10 }),
      ).resolves.toMatchObject({ items: expect.any(Array), total: expect.any(Number) });

      await runtime.whenReady();
      expect(runtime.status).toEqual({ state: "ready", message: null });
      expect(readJsonl).not.toHaveBeenCalled();
      await expect(
        runtime.repository.listSessions({ scope: "active", limit: 10 }),
      ).resolves.toMatchObject({ total: 1 });
    } finally {
      await runtime.close();
    }
  });

  it("does not materialize unchanged cached conversations during startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-live-runtime-"));
    temporaryRoots.push(root);
    const codexHome = await createHome(root, "modern.jsonl");
    const configDir = join(root, "config");
    const cacheDir = join(root, "cache");
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
    const firstRuntime = await LiveViewerRuntime.start(config, {
      reconciliationIntervalMs: 60_000,
    });
    await firstRuntime.close();
    const cache = openCacheDatabase(config.paths.cacheDatabase);
    try {
      cache.prepare("UPDATE turns SET payload_json = '{}'").run();
    } finally {
      cache.close();
    }
    const runtime = await LiveViewerRuntime.start(config, {
      initialReconciliation: "deferred",
      reconciliationIntervalMs: 60_000,
    });

    try {
      await expect(runtime.startInitialReconciliation()).resolves.toBeUndefined();
      expect(runtime.status).toEqual({ state: "ready", message: null });
      await expect(
        runtime.repository.listSessions({ scope: "active", limit: 10 }),
      ).resolves.toMatchObject({ total: 1 });
    } finally {
      await runtime.close();
    }
  });

  it("prepares the new context separately and preserves the previous cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-live-runtime-"));
    temporaryRoots.push(root);
    const [firstHome, secondHome] = await Promise.all([
      createHome(root, "modern.jsonl"),
      createHome(root, "legacy.jsonl"),
    ]);
    const configDir = join(root, "config");
    const cacheDir = join(root, "cache");
    const config: LoadedServerViewerConfig = {
      settings: { codexHome: firstHome, port: 3_000, fetchFavicons: false },
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
    const runtime = await LiveViewerRuntime.start(config, { reconciliationIntervalMs: 60_000 });

    try {
      const firstIds = runtime.database.prepare("SELECT id FROM session_catalog").all();
      expect(firstIds).toHaveLength(1);
      await runtime.updateSettings({
        codexHome: secondHome,
        port: 3_000,
        fetchFavicons: false,
      });
      expect(runtime.settings.codexHome).toBe(secondHome);
      expect(runtime.database.prepare("SELECT id FROM session_catalog").all()).toHaveLength(1);

      const preserved = openCacheDatabase(config.paths.cacheDatabase);
      try {
        expect(preserved.prepare("SELECT id FROM session_catalog").all()).toEqual(firstIds);
      } finally {
        preserved.close();
      }
    } finally {
      await runtime.close();
    }
  });
});
