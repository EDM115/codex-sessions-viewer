import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openCacheDatabase } from "../../../server/cache/database.ts";
import { CACHE_PARSER_VERSION } from "../../../server/cache/sourceManifest.ts";
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

  it("shares deferred catalog startup across concurrent cold session reads", async () => {
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
    const readyRuntime = async () => {
      if (runtime.status.state === "preparing") {
        await runtime.startInitialReconciliation();
      }
      return runtime;
    };

    try {
      const [session, navigator] = await Promise.all([
        readyRuntime().then((ready) =>
          ready.repository.getSession("11111111-1111-4111-8111-111111111111"),
        ),
        readyRuntime().then((ready) =>
          ready.repository.getTurnNavigator("11111111-1111-4111-8111-111111111111"),
        ),
      ]);
      expect(session.id).toBe("11111111-1111-4111-8111-111111111111");
      expect(navigator).not.toHaveLength(0);
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
    try {
      await firstRuntime.repository.getSession("11111111-1111-4111-8111-111111111111");
      expect(firstRuntime.database.prepare("SELECT COUNT(*) AS count FROM turns").get()).toEqual({
        count: 2,
      });
    } finally {
      await firstRuntime.close();
    }
    const cache = openCacheDatabase(config.paths.cacheDatabase);
    try {
      cache.prepare("UPDATE turns SET payload_json = '{}'").run();
    } finally {
      cache.close();
    }
    const readJsonl = vi.fn<typeof readStableJsonl>(readStableJsonl);
    const runtime = await LiveViewerRuntime.start(config, {
      initialReconciliation: "deferred",
      reconciliationIntervalMs: 60_000,
      readJsonl,
    });

    try {
      await expect(runtime.startInitialReconciliation()).resolves.toBeUndefined();
      expect(runtime.status).toEqual({ state: "ready", message: null });
      expect(readJsonl).not.toHaveBeenCalled();
      expect(
        runtime.database.prepare("SELECT payload_json FROM turns ORDER BY turn_index").all(),
      ).toEqual([{ payload_json: "{}" }, { payload_json: "{}" }]);
      await expect(
        runtime.repository.listSessions({ scope: "active", limit: 10 }),
      ).resolves.toMatchObject({ total: 1 });
    } finally {
      await runtime.close();
    }
  });

  it("invalidates ready catalog rows when cached parser output is from an older version", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-live-runtime-"));
    temporaryRoots.push(root);
    const codexHome = await createHome(root, "modern.jsonl");
    const configDir = join(root, "config");
    const cacheDir = join(root, "cache");
    const sessionId = "11111111-1111-4111-8111-111111111111";
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
    try {
      await expect(firstRuntime.repository.getSession(sessionId)).resolves.toMatchObject({
        id: sessionId,
      });
    } finally {
      await firstRuntime.close();
    }

    const cache = openCacheDatabase(config.paths.cacheDatabase);
    try {
      cache
        .prepare("UPDATE source_files SET parser_version = ? WHERE session_id = ?")
        .run(CACHE_PARSER_VERSION - 1, sessionId);
      cache
        .prepare("UPDATE session_catalog SET source_revision = ? WHERE id = ?")
        .run(`catalog:${CACHE_PARSER_VERSION - 1}:stale`, sessionId);
      cache.prepare("UPDATE turns SET payload_json = '{}' WHERE session_id = ?").run(sessionId);
    } finally {
      cache.close();
    }

    const runtime = await LiveViewerRuntime.start(config, {
      initialReconciliation: "deferred",
      reconciliationIntervalMs: 60_000,
    });
    try {
      await runtime.startInitialReconciliation();
      expect(
        runtime.database
          .prepare(
            "SELECT materialization_state, source_revision FROM session_catalog WHERE id = ?",
          )
          .get(sessionId),
      ).toMatchObject({
        materialization_state: "cold",
        source_revision: expect.stringMatching(`^catalog:${CACHE_PARSER_VERSION}:`),
      });
      await expect(runtime.repository.getSession(sessionId)).resolves.toMatchObject({
        id: sessionId,
      });
      expect(
        runtime.database
          .prepare("SELECT parser_version FROM source_files WHERE session_id = ?")
          .get(sessionId),
      ).toMatchObject({ parser_version: CACHE_PARSER_VERSION });
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
      expect(firstIds).toEqual([{ id: "11111111-1111-4111-8111-111111111111" }]);
      await runtime.updateSettings({
        codexHome: secondHome,
        port: 3_000,
        fetchFavicons: false,
      });
      expect(runtime.settings.codexHome).toBe(secondHome);
      expect(runtime.database.prepare("SELECT id FROM session_catalog").all()).toEqual([
        { id: "33333333-3333-4333-8333-333333333333" },
      ]);

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
