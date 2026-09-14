import { performance } from "node:perf_hooks";

import { describe, expect, it, vi } from "vitest";

import { openCacheDatabase } from "../../server/cache/database.ts";
import type { SessionMetaPrefixResult } from "../../server/ingestion/sessionMetaPrefix.ts";
import { refreshLiveCatalog } from "../../server/live/catalogBuilder.ts";

function sessionId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function prefix(index: number, bytesRead: number): SessionMetaPrefixResult {
  return {
    status: "found",
    meta: {
      id: sessionId(index),
      parentThreadId: null,
      timestamp: "2026-08-16T10:00:00.000Z",
      cwd: "C:\\Projects\\viewer",
      source: null,
      modelProvider: "openai",
      git: null,
    },
    parentThreadIdHint: null,
    bytesRead,
    observation: {
      device: 1n,
      inode: BigInt(index + 1),
      size: 8_000_000n + BigInt(index),
      mtimeNs: 1_776_336_000_000_000_000n + BigInt(index),
      ctimeNs: 1_776_336_000_000_000_000n,
      regular: true,
      symbolicLink: false,
    },
    diagnostics: [],
  };
}

describe("live catalog startup scale", () => {
  it("catalogs 500 large rollouts from bounded prefixes without normalizing transcripts", async () => {
    const database = openCacheDatabase(":memory:");
    const rollouts = Array.from({ length: 500 }, (_, index) => ({
      path: `C:\\Codex\\sessions\\rollout-${index}.jsonl`,
      scope: index % 5 === 0 ? ("archived" as const) : ("active" as const),
    }));
    let concurrentReads = 0;
    let maxConcurrentReads = 0;
    const revisions = Array.from({ length: 500 }, (_, index) => BigInt(index));
    const observedPrefix = (index: number) => {
      const result = prefix(index, 0);
      result.observation.mtimeNs += revisions[index] ?? 0n;
      return result;
    };
    const readPrefix = vi.fn<(path: string, maxBytes: number) => Promise<SessionMetaPrefixResult>>(
      async (path, maxBytes) => {
        concurrentReads += 1;
        maxConcurrentReads = Math.max(maxConcurrentReads, concurrentReads);
        await Promise.resolve();
        concurrentReads -= 1;
        const index = Number(path.match(/rollout-(\d+)\.jsonl$/u)?.[1]);
        const result = observedPrefix(index);
        result.bytesRead = maxBytes;
        return result;
      },
    );
    const observeSource = vi.fn(async (path: string) => {
      const index = Number(path.match(/rollout-(\d+)\.jsonl$/u)?.[1]);
      return observedPrefix(index).observation;
    });
    const startedAt = performance.now();

    try {
      const result = await refreshLiveCatalog({
        database,
        discovery: {
          rollouts,
          metadata: {
            sessionIndex: null,
            globalState: null,
            stateDatabase: null,
            stateWal: null,
          },
          diagnostics: [],
        },
        sessionIndexEntries: [],
        globalState: { projects: [], pinnedThreadIds: [] },
        stateSnapshot: null,
        readPrefix,
        observeSource,
      });

      expect(result.rows).toHaveLength(500);
      expect(result.bytesRead).toBe(500 * 4_096);
      expect(readPrefix).toHaveBeenCalledTimes(500);
      expect(readPrefix.mock.calls.every(([, maxBytes]) => maxBytes === 4_096)).toBe(true);
      expect(maxConcurrentReads).toBeLessThanOrEqual(32);
      expect(database.prepare("SELECT count(*) AS count FROM session_catalog").get()).toEqual({
        count: 500,
      });
      expect(database.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({
        count: 0,
      });
      expect(performance.now() - startedAt).toBeLessThan(5_000);

      const changesBefore = database.prepare("SELECT total_changes() AS changes").get()?.[
        "changes"
      ];
      readPrefix.mockClear();
      observeSource.mockClear();
      const unchanged = await refreshLiveCatalog({
        database,
        discovery: {
          rollouts,
          metadata: {
            sessionIndex: null,
            globalState: null,
            stateDatabase: null,
            stateWal: null,
          },
          diagnostics: [],
        },
        sessionIndexEntries: [],
        globalState: { projects: [], pinnedThreadIds: [] },
        stateSnapshot: null,
        readPrefix,
        observeSource,
      });
      expect(unchanged.changedIds).toEqual([]);
      expect(unchanged.bytesRead).toBe(0);
      expect(readPrefix).not.toHaveBeenCalled();
      expect(observeSource).toHaveBeenCalledTimes(500);
      expect(database.prepare("SELECT total_changes() AS changes").get()?.["changes"]).toBe(
        changesBefore,
      );

      revisions[217] = 10_000n;
      readPrefix.mockClear();
      observeSource.mockClear();
      const oneChanged = await refreshLiveCatalog({
        database,
        discovery: {
          rollouts,
          metadata: {
            sessionIndex: null,
            globalState: null,
            stateDatabase: null,
            stateWal: null,
          },
          diagnostics: [],
        },
        sessionIndexEntries: [],
        globalState: { projects: [], pinnedThreadIds: [] },
        stateSnapshot: null,
        readPrefix,
        observeSource,
      });
      expect(oneChanged.changedIds).toEqual([sessionId(217)]);
      expect(readPrefix).toHaveBeenCalledOnce();
      expect(oneChanged.bytesRead).toBe(4_096);
    } finally {
      database.close();
    }
  });
});
