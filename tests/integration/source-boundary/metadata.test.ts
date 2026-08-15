import { mkdir, stat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { readGlobalState } from "../../../server/metadata/globalState.ts";
import { readSessionIndex } from "../../../server/metadata/sessionIndex.ts";
import { snapshotStateDatabase } from "../../../server/metadata/stateSnapshot.ts";
import { createStateDatabase } from "./fixtures.ts";

const temporaryDirectories: string[] = [];
const fixtureDatabases = new Set<DatabaseSync>();

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-viewer-metadata-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
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

describe("session index metadata", () => {
  it("keeps later valid records, selects the latest name, and preserves a partial tail", async () => {
    const root = await createFixtureRoot();
    const path = join(root, "session_index.jsonl");
    await writeFile(
      path,
      [
        '{"id":"thread-1","thread_name":"Old name","updated_at":"2026-08-12T10:00:00.000Z"}',
        "{ invalid }",
        '{"id":"thread-2","thread_name":"Second","updated_at":"2026-08-12T11:00:00.000Z"}',
        '{"id":"thread-1","thread_name":"Latest name","updated_at":"2026-08-12T12:00:00.000Z"}',
        '{"id":"thread-1","thread_name":" ","updated_at":"2026-08-12T13:00:00.000Z"}',
        '{"id":"pending"',
      ].join("\n"),
      "utf8",
    );

    const result = await readSessionIndex(path);

    expect(result.entries).toEqual([
      { id: "thread-1", threadName: "Latest name", updatedAt: "2026-08-12T12:00:00.000Z" },
      { id: "thread-2", threadName: "Second", updatedAt: "2026-08-12T11:00:00.000Z" },
    ]);
    expect(result.pending.toString("utf8")).toBe('{"id":"pending"');
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["source.invalid_jsonl"]);
  });
});

describe("global state metadata", () => {
  it("projects only local project labels, roots, and pinned thread ids", async () => {
    const root = await createFixtureRoot();
    const path = join(root, ".codex-global-state.json");
    await writeFile(
      path,
      JSON.stringify({
        "local-projects": {
          "project-1": {
            id: "project-1",
            name: "Viewer",
            rootPaths: ["C:/repo"],
            createdAt: 100,
            updatedAt: 200,
          },
        },
        "pinned-thread-ids": ["thread-1"],
        auth: { accessToken: "must-not-leak" },
        "electron-persisted-atom-state": { private: true },
      }),
      "utf8",
    );

    const result = await readGlobalState(path);

    expect(result.metadata).toEqual({
      projects: [{ id: "project-1", name: "Viewer", rootPaths: ["C:/repo"] }],
      pinnedThreadIds: ["thread-1"],
    });
    expect(result.diagnostics).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result)).not.toContain("electron-persisted-atom-state");
  });
});

describe("state database snapshots", () => {
  it("validates and queries an app-owned byte snapshot without changing the source", async () => {
    const root = await createFixtureRoot();
    const sourceDatabase = join(root, "state_5.sqlite");
    const sourceWal = `${sourceDatabase}-wal`;
    const snapshotRoot = join(root, "viewer-cache", "state-snapshots");
    const writer = createStateDatabase(sourceDatabase);
    fixtureDatabases.add(writer);
    const beforeDatabase = await stat(sourceDatabase);
    const beforeWal = await stat(sourceWal);

    const result = await snapshotStateDatabase({ sourceDatabase, sourceWal, snapshotRoot });

    const afterDatabase = await stat(sourceDatabase);
    const afterWal = await stat(sourceWal);
    writer.close();
    expect(result.status).toBe("created");
    expect(result.generationPath).toContain(snapshotRoot);
    expect(result.metadata).toEqual({
      threads: [
        {
          id: "thread-1",
          rolloutPath: "sessions/rollout-thread-1.jsonl",
          createdAt: 100,
          updatedAt: 200,
          source: "vscode",
          modelProvider: "openai",
          cwd: "C:/repo",
          title: "Fallback title",
          tokensUsed: 1234,
          archived: false,
          archivedAt: null,
          gitSha: "abc123",
          gitBranch: "main",
          gitOriginUrl: "https://example.test/repo.git",
          firstUserMessage: "First prompt",
          model: "gpt-test",
          reasoningEffort: "high",
          name: "Chosen name",
          pinned: true,
          sectionId: "section-1",
        },
      ],
      sections: [{ id: "section-1", name: "Viewer" }],
      spawnEdges: [{ parentThreadId: "thread-1", childThreadId: "thread-2", status: "closed" }],
    });
    expect(result.diagnostics).toEqual([]);
    expect(afterDatabase).toMatchObject({
      size: beforeDatabase.size,
      mtimeMs: beforeDatabase.mtimeMs,
    });
    expect(afterWal).toMatchObject({ size: beforeWal.size, mtimeMs: beforeWal.mtimeMs });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("retains the last validated generation when a new snapshot is corrupt", async () => {
    const root = await createFixtureRoot();
    const sourceDatabase = join(root, "state_5.sqlite");
    const sourceWal = `${sourceDatabase}-wal`;
    const snapshotRoot = join(root, "viewer-cache", "state-snapshots");
    const writer = createStateDatabase(sourceDatabase);
    fixtureDatabases.add(writer);
    const first = await snapshotStateDatabase({ sourceDatabase, sourceWal, snapshotRoot });
    writer.close();
    await Promise.all([
      writeFile(sourceDatabase, "not a database", "utf8"),
      rm(sourceWal, { force: true }),
    ]);

    const second = await snapshotStateDatabase({ sourceDatabase, sourceWal, snapshotRoot });

    expect(first.status).toBe("created");
    expect(second.status).toBe("retained");
    expect(second.generationPath).toBe(first.generationPath);
    expect(second.metadata?.threads[0]?.name).toBe("Chosen name");
    expect(second.diagnostics.map(({ code }) => code)).toEqual(["metadata.snapshot_invalid"]);
    expect(JSON.parse(await readFile(join(snapshotRoot, "current.json"), "utf8"))).toEqual({
      generationPath: first.generationPath,
    });
  });

  it("creates a validated snapshot when the optional WAL is absent", async () => {
    const root = await createFixtureRoot();
    const sourceDatabase = join(root, "state_5.sqlite");
    const sourceWal = `${sourceDatabase}-wal`;
    const snapshotRoot = join(root, "viewer-cache", "state-snapshots");
    const writer = createStateDatabase(sourceDatabase);
    writer.close();
    await rm(sourceWal, { force: true });

    const result = await snapshotStateDatabase({ sourceDatabase, sourceWal, snapshotRoot });

    expect(result).toMatchObject({ status: "created", diagnostics: [] });
    expect(result.metadata?.threads).toHaveLength(1);
  });

  it.each(["missing", "directory"])(
    "returns an unavailable diagnostic for a %s source database",
    async (variant) => {
      const root = await createFixtureRoot();
      const sourceDatabase = join(root, "state_5.sqlite");
      const snapshotRoot = join(root, "viewer-cache", "state-snapshots");
      if (variant === "directory") {
        await mkdir(sourceDatabase);
      }

      const result = await snapshotStateDatabase({
        sourceDatabase,
        sourceWal: `${sourceDatabase}-wal`,
        snapshotRoot,
      });

      expect(result).toMatchObject({
        status: "unavailable",
        generationPath: null,
        metadata: null,
        diagnostics: [expect.objectContaining({ code: "metadata.snapshot_invalid" })],
      });
    },
  );

  it("refuses a retained generation path outside the viewer-owned snapshot root", async () => {
    const root = await createFixtureRoot();
    const sourceDatabase = join(root, "state_5.sqlite");
    const snapshotRoot = join(root, "viewer-cache", "state-snapshots");
    await writeFile(sourceDatabase, "not a database", "utf8");
    await mkdir(snapshotRoot, { recursive: true });
    await writeFile(
      join(snapshotRoot, "current.json"),
      `${JSON.stringify({ generationPath: root })}\n`,
    );

    const result = await snapshotStateDatabase({
      sourceDatabase,
      sourceWal: `${sourceDatabase}-wal`,
      snapshotRoot,
    });

    expect(result).toMatchObject({ status: "unavailable", generationPath: null, metadata: null });
  });
});
