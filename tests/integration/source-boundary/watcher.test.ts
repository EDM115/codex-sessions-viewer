import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverSources } from "../../../server/ingestion/discoverSources.ts";
import { stableRead } from "../../../server/ingestion/stableRead.ts";
import {
  watchSources,
  type SourceWatchBatch,
  type SourceWatcher,
} from "../../../server/ingestion/watchSources.ts";
import { readSessionIndex } from "../../../server/metadata/sessionIndex.ts";
import { snapshotStateDatabase } from "../../../server/metadata/stateSnapshot.ts";
import { createStateDatabase } from "./fixtures.ts";

const temporaryDirectories: string[] = [];
const fixtureDatabases = new Set<DatabaseSync>();
const sourceWatchers = new Set<SourceWatcher>();

async function createCodexHome(): Promise<string> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-viewer-watch-boundary-"));
  temporaryDirectories.push(fixtureRoot);
  const root = join(fixtureRoot, "codex-home");
  await Promise.all([
    mkdir(join(root, "sessions", "2026", "08", "13"), { recursive: true }),
    mkdir(join(root, "archived_sessions"), { recursive: true }),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all([...sourceWatchers].map((watcher) => watcher.close()));
  sourceWatchers.clear();
  for (const database of fixtureDatabases) {
    if (database.isOpen) {
      database.close();
    }
  }
  fixtureDatabases.clear();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("source watching", () => {
  it("debounces rollout changes and never reports unrelated Codex-home files", async () => {
    const codexHome = await createCodexHome();
    const rollout = join(codexHome, "sessions", "2026", "08", "13", "watched.jsonl");
    await writeFile(rollout, "initial\n", "utf8");
    const batches: SourceWatchBatch[] = [];
    const watcher = watchSources({
      codexHome,
      debounceMs: 40,
      onBatch(batch) {
        batches.push(batch);
      },
    });
    sourceWatchers.add(watcher);
    await watcher.ready;

    await appendFile(rollout, "first\nsecond\n", "utf8");
    await vi.waitFor(() => expect(batches).toHaveLength(1), { timeout: 2_000, interval: 20 });

    expect(batches[0]?.changes).toEqual([
      { kind: "changed", path: rollout, source: "rollout", scope: "active" },
    ]);
    await Promise.all([
      writeFile(join(codexHome, "auth.json"), '{"token":"secret"}', "utf8"),
      writeFile(join(codexHome, "unrelated.jsonl"), "{}\n", "utf8"),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(batches).toHaveLength(1);
  });
});

describe("concurrent source access", () => {
  it("allows a fixture writer to append continuously while every read-only boundary runs", async () => {
    const codexHome = await createCodexHome();
    const rollout = join(codexHome, "sessions", "2026", "08", "13", "concurrent.jsonl");
    const sessionIndex = join(codexHome, "session_index.jsonl");
    const sourceDatabase = join(codexHome, "state_5.sqlite");
    const sourceWal = `${sourceDatabase}-wal`;
    const snapshotRoot = join(codexHome, "..", "viewer-owned", "state-snapshots");
    const initialRollout = '{"index":0}\n';
    const initialIndex =
      '{"id":"thread-1","thread_name":"Initial","updated_at":"2026-08-13T09:00:00.000Z"}\n';
    await Promise.all([
      writeFile(rollout, initialRollout, "utf8"),
      writeFile(sessionIndex, initialIndex, "utf8"),
    ]);
    const stateWriter = createStateDatabase(sourceDatabase);
    fixtureDatabases.add(stateWriter);
    const [databaseBytesBefore, walBytesBefore, databaseStatsBefore, walStatsBefore] =
      await Promise.all([
        readFile(sourceDatabase),
        readFile(sourceWal),
        stat(sourceDatabase),
        stat(sourceWal),
      ]);
    const expectedRollout = [initialRollout];
    const expectedIndex = [initialIndex];
    const snapshotStatuses: string[] = [];

    async function appendFixtureLines(index: number): Promise<void> {
      if (index > 20) {
        return;
      }
      const rolloutLine = `${JSON.stringify({ index })}\n`;
      expectedRollout.push(rolloutLine);
      await appendFile(rollout, rolloutLine, "utf8");
      if (index % 5 === 0) {
        const indexLine = `${JSON.stringify({
          id: "thread-1",
          thread_name: `Name ${index}`,
          updated_at: `2026-08-13T09:${String(index).padStart(2, "0")}:00.000Z`,
        })}\n`;
        expectedIndex.push(indexLine);
        await appendFile(sessionIndex, indexLine, "utf8");
      }
      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
      return appendFixtureLines(index + 1);
    }

    async function runViewerPasses(pass: number): Promise<void> {
      if (pass > 5) {
        return;
      }
      const [, , , snapshot] = await Promise.all([
        discoverSources(codexHome),
        stableRead(rollout, { chunkSize: 7 }),
        readSessionIndex(sessionIndex),
        snapshotStateDatabase({ sourceDatabase, sourceWal, snapshotRoot }),
      ]);
      snapshotStatuses.push(snapshot.status);
      return runViewerPasses(pass + 1);
    }

    const writerStartedAt = Date.now();
    let writerDurationMs = Number.POSITIVE_INFINITY;
    const writer = appendFixtureLines(1).finally(() => {
      writerDurationMs = Date.now() - writerStartedAt;
    });
    await Promise.all([writer, runViewerPasses(1)]);

    const [databaseBytesAfter, walBytesAfter, databaseStatsAfter, walStatsAfter] =
      await Promise.all([
        readFile(sourceDatabase),
        readFile(sourceWal),
        stat(sourceDatabase),
        stat(sourceWal),
      ]);
    expect(writerDurationMs).toBeLessThan(5_000);
    expect(await readFile(rollout, "utf8")).toBe(expectedRollout.join(""));
    expect(await readFile(sessionIndex, "utf8")).toBe(expectedIndex.join(""));
    expect(databaseBytesAfter.equals(databaseBytesBefore)).toBe(true);
    expect(walBytesAfter.equals(walBytesBefore)).toBe(true);
    expect(databaseStatsAfter).toMatchObject({
      size: databaseStatsBefore.size,
      mtimeMs: databaseStatsBefore.mtimeMs,
    });
    expect(walStatsAfter).toMatchObject({
      size: walStatsBefore.size,
      mtimeMs: walStatsBefore.mtimeMs,
    });
    expect(snapshotStatuses).toEqual(["created", "created", "created", "created", "created"]);
  }, 10_000);
});
