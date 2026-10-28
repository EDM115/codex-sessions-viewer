import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import { LiveReconciler } from "../../server/live/reconciler.ts";
import { LiveViewerRuntime } from "../../server/live/viewerRuntime.ts";
import { createStateDatabase } from "../integration/source-boundary/fixtures.ts";

const rolloutIo = vi.hoisted(() => ({
  operations: [] as string[],
  watches: [] as string[],
  decodes: 0,
}));
const rolloutPath = (path: unknown) =>
  /[\\/](?:sessions|archived_sessions)(?:[\\/]|$)/u.test(String(path));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return Object.fromEntries(
    Object.entries(fs).map(([name, value]) => [
      name,
      ["readdir", "opendir", "stat", "lstat", "open", "readFile"].includes(name) &&
      typeof value === "function"
        ? (...args: unknown[]) => {
            if (rolloutPath(args[0])) {
              rolloutIo.operations.push(`${name}:${String(args[0])}`);
            }
            return Reflect.apply(value, fs, args);
          }
        : value,
    ]),
  );
});
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    watch: (...args: unknown[]) => {
      if (rolloutPath(args[0])) {
        rolloutIo.watches.push(String(args[0]));
      }
      return Reflect.apply(fs.watch, fs, args);
    },
  };
});
vi.mock("node:zlib", async (original) => {
  const zlib = await original<typeof import("node:zlib")>();
  return {
    ...zlib,
    createZstdDecompress: (...args: unknown[]) => {
      rolloutIo.decodes += 1;
      return Reflect.apply(zlib.createZstdDecompress, zlib, args);
    },
  };
});

describe("live metadata catalog startup scale", () => {
  it("publishes 500 metadata-only entries through the real runtime without observing or preparing any rollout", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-metadata-performance-"));
    const home = join(root, "home");
    const cacheDir = join(root, "cache");
    await mkdir(join(home, "sessions", "deep", "archive"), { recursive: true });
    const large = await open(join(home, "sessions", "deep", "archive", "unopened.jsonl.zst"), "w");
    await large.truncate(64 * 1024 * 1024);
    await large.close();
    const state = createStateDatabase(join(home, "state_5.sqlite"));
    const seed = state.prepare("SELECT * FROM threads LIMIT 1").get()!;
    state.exec("DELETE FROM threads");
    const columns = Object.keys(seed);
    const insert = state.prepare(
      `INSERT INTO threads (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    );
    for (let index = 0; index < 500; index += 1) {
      const row = {
        ...seed,
        id: `thread-${String(index).padStart(4, "0")}`,
        name: `Metadata title ${index}`,
        rollout_path: `sessions/rollout-${index}.jsonl`,
        archived: index % 5 === 0 ? 1 : 0,
      };
      insert.run(...columns.map((column) => row[column as keyof typeof row]));
    }
    state.close();
    rolloutIo.operations = [];
    rolloutIo.watches = [];
    rolloutIo.decodes = 0;
    const prepare = vi.spyOn(LiveReconciler.prototype, "prepareSessions");
    const readJsonl =
      vi.fn<typeof import("../../server/ingestion/jsonlStream.ts").readStableJsonl>();
    const started = performance.now();
    const runtime = await LiveViewerRuntime.start(
      {
        settings: { codexHome: home, port: 3000, fetchFavicons: false },
        paths: {
          cacheDir,
          configDir: join(root, "config"),
          configFile: join(root, "config", "config.json"),
          generatedDir: join(cacheDir, "generated"),
          cacheDatabase: join(cacheDir, "viewer.sqlite"),
        },
        codexHomeSource: "cli",
        onboardingRequired: false,
        diagnostics: [],
      },
      { readJsonl, reconciliationIntervalMs: 60_000 },
    );
    const catalogReadyMs = performance.now() - started;
    try {
      expect(runtime.status).toMatchObject({
        state: "ready",
        catalogSource: "fresh",
        recoveryState: "idle",
      });
      expect(rolloutIo.operations).toEqual([]);
      expect(rolloutIo.watches).toEqual([]);
      expect(
        runtime.database.prepare("SELECT count(*) AS count FROM session_catalog").get(),
      ).toEqual({ count: 500 });
      const groups = await runtime.repository.listProjects();
      await Promise.all(
        (["active", "archived"] as const).map(async (scope) => {
          const page = await runtime.repository.listSessions({ scope, limit: 20 });
          expect(page.total).toBe(scope === "active" ? 400 : 100);
          expect(page.items).toHaveLength(20);
          expect(
            page.items.every((entry) => !("summary" in entry) && !("materialization" in entry)),
          ).toBe(true);
          await Promise.all(
            groups.map((group) =>
              runtime.repository.listSessions({ scope, groupId: group.groupId, limit: 20 }),
            ),
          );
        }),
      );
      expect(rolloutIo.operations).toEqual([]);
      expect(rolloutIo.watches).toEqual([]);
      expect(rolloutIo.decodes).toBe(0);
      expect(readJsonl).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(runtime.database.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({
        count: 0,
      });
      expect(catalogReadyMs).toBeLessThan(5000);
      console.log(
        JSON.stringify({
          metadataEntries: 500,
          catalogReadyMs: Math.round(catalogReadyMs),
          rolloutIo: 0,
          rolloutWatches: 0,
          decodes: 0,
          normalizedSessions: 0,
          prepareRequests: 0,
        }),
      );
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
