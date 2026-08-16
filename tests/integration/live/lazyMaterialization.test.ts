import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { LoadedServerViewerConfig } from "../../../server/core/config.ts";
import { readStableJsonl } from "../../../server/ingestion/jsonlStream.ts";
import { LiveViewerRuntime } from "../../../server/live/viewerRuntime.ts";

const temporaryRoots: string[] = [];
const fixtureSessionId = "11111111-1111-4111-8111-111111111111";

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

      const id = page.items[0]!.summary.id;
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
});
