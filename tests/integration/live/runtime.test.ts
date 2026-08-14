import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openCacheDatabase } from "../../../server/cache/database.ts";
import type { LoadedServerViewerConfig } from "../../../server/core/config.ts";
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
      const firstIds = runtime.database.prepare("SELECT id FROM sessions").all();
      expect(firstIds).toHaveLength(1);
      await runtime.updateSettings({
        codexHome: secondHome,
        port: 3_000,
        fetchFavicons: false,
      });
      expect(runtime.settings.codexHome).toBe(secondHome);
      expect(runtime.database.prepare("SELECT id FROM sessions").all()).toHaveLength(1);

      const preserved = openCacheDatabase(config.paths.cacheDatabase);
      try {
        expect(preserved.prepare("SELECT id FROM sessions").all()).toEqual(firstIds);
      } finally {
        preserved.close();
      }
    } finally {
      await runtime.close();
    }
  });
});
