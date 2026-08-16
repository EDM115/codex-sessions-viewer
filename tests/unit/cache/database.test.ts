import { link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openCacheDatabase, withCacheTransaction } from "../../../server/cache/database.ts";
import { migrateCacheDatabase } from "../../../server/cache/migrations.ts";
import { CACHE_SCHEMA_VERSION, INITIAL_CACHE_SCHEMA_SQL } from "../../../server/cache/schema.ts";

function seedVersionOneSession(database: DatabaseSync): void {
  const summary = {
    id: "session-v1",
    title: "Existing cached session",
    scope: "active",
    sourcePath: "C:\\codex\\sessions\\session-v1.jsonl",
    createdAt: "2026-08-13T08:00:00.000Z",
    updatedAt: "2026-08-13T08:30:00.000Z",
    cwd: "C:\\Work\\viewer",
    gitBranch: "main",
    gitSha: null,
    gitOriginUrl: null,
    models: ["gpt-5.6"],
    reasoningEfforts: ["high"],
    turnCount: 2,
    assistantMessageCount: 2,
    toolCallCount: 1,
    toolCounts: { exec_command: 1 },
    preview: "existing cache",
    pinned: false,
    sectionName: null,
    parentThreadId: null,
    childThreadIds: [],
    hasMedia: false,
    diagnosticCount: 0,
    revision: "sha256:v1",
  };
  database
    .prepare(`
      INSERT INTO source_files (
        path, session_id, scope, size, mtime_ms, device, inode, sha256, parsed_bytes,
        parser_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      summary.sourcePath,
      summary.id,
      summary.scope,
      100,
      1_786_550_400_000,
      "1",
      "2",
      "a".repeat(64),
      100,
      1,
      summary.updatedAt,
    );
  database
    .prepare(`
      INSERT INTO sessions (
        id, title, scope, source_path, created_at, updated_at, cwd, git_branch, git_sha,
        git_origin_url, models_json, reasoning_efforts_json, turn_count,
        assistant_message_count, tool_call_count, tool_counts_json, preview, pinned,
        section_name, parent_thread_id, child_thread_ids_json, has_media, diagnostic_count,
        revision, summary_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      summary.id,
      summary.title,
      summary.scope,
      summary.sourcePath,
      summary.createdAt,
      summary.updatedAt,
      summary.cwd,
      summary.gitBranch,
      summary.gitSha,
      summary.gitOriginUrl,
      JSON.stringify(summary.models),
      JSON.stringify(summary.reasoningEfforts),
      summary.turnCount,
      summary.assistantMessageCount,
      summary.toolCallCount,
      JSON.stringify(summary.toolCounts),
      summary.preview,
      0,
      summary.sectionName,
      summary.parentThreadId,
      JSON.stringify(summary.childThreadIds),
      0,
      summary.diagnosticCount,
      summary.revision,
      JSON.stringify(summary),
    );
}

describe("viewer cache database", () => {
  it("creates the versioned cache schema with foreign keys and FTS5 enabled", () => {
    const database = openCacheDatabase(":memory:");

    try {
      const objects = database
        .prepare(
          "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();

      expect(objects).toEqual(
        expect.arrayContaining(
          [
            "activities",
            "assets",
            "diagnostics",
            "favicons",
            "messages",
            "raw_events",
            "session_catalog",
            "session_fts",
            "sessions",
            "source_files",
            "turns",
          ].map((name) => expect.objectContaining({ name })),
        ),
      );
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: CACHE_SCHEMA_VERSION,
      });
      expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(
        database.prepare("SELECT sql FROM sqlite_master WHERE name = 'session_fts'").get(),
      ).toEqual(expect.objectContaining({ sql: expect.stringContaining("fts5") }));
    } finally {
      database.close();
    }
  });

  it("migrates version-one normalized sessions into ready catalog rows", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(INITIAL_CACHE_SCHEMA_SQL);
    database.exec("PRAGMA user_version = 1");
    seedVersionOneSession(database);

    try {
      migrateCacheDatabase(database);

      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      expect(
        database
          .prepare(
            "SELECT id, session_kind, materialization_state FROM session_catalog WHERE id = ?",
          )
          .get("session-v1"),
      ).toEqual({
        id: "session-v1",
        session_kind: "root",
        materialization_state: "ready",
      });
      expect(() =>
        database
          .prepare(`
            INSERT INTO session_catalog (
              id, source_path, scope, project_id, project_name, project_source,
              session_kind, materialization_state, title, created_at, updated_at,
              child_count, source_size, source_mtime_ms, source_revision, summary_json
            ) VALUES (?, ?, 'active', 'none', 'No project', 'none', 'auxiliary', ?, ?, ?, ?, 0, 0, 0, ?, ?)
          `)
          .run(
            "invalid-state",
            "C:\\codex\\invalid-state.jsonl",
            "warming",
            "Invalid",
            "2026-08-13T08:00:00.000Z",
            "2026-08-13T08:00:00.000Z",
            "revision",
            "{}",
          ),
      ).toThrow("CHECK constraint failed");
    } finally {
      database.close();
    }
  });

  it("rolls back every write when a cache transaction fails", () => {
    const database = openCacheDatabase(":memory:");

    try {
      expect(() =>
        withCacheTransaction(database, () => {
          database
            .prepare("INSERT INTO assets (id, status) VALUES ('asset-rollback', 'missing')")
            .run();
          throw new Error("synthetic transaction failure");
        }),
      ).toThrow("synthetic transaction failure");
      expect(database.prepare("SELECT count(*) AS count FROM assets").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("rebuilds only an explicitly named viewer cache and leaves source files untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-cache-migration-"));
    const viewerPath = join(root, "viewer.sqlite");
    const sourcePath = join(root, "rollout.jsonl");
    const source = '{"type":"session_meta","payload":{"id":"session-1"}}\n';
    await writeFile(sourcePath, source, "utf8");
    const sourceBefore = await stat(sourcePath);
    const incompatible = new DatabaseSync(viewerPath);
    incompatible.exec("CREATE TABLE stale (value TEXT); PRAGMA user_version = 999;");
    incompatible.close();

    try {
      const rebuilt = openCacheDatabase(viewerPath, { rebuildOnMigrationFailure: true });
      try {
        expect(rebuilt.prepare("PRAGMA user_version").get()).toEqual({
          user_version: CACHE_SCHEMA_VERSION,
        });
        expect(rebuilt.prepare("SELECT name FROM sqlite_master WHERE name = 'stale'").get()).toBe(
          undefined,
        );
      } finally {
        rebuilt.close();
      }
      const sourceAfter = await stat(sourcePath);
      expect(await readFile(sourcePath, "utf8")).toBe(source);
      expect(sourceAfter).toMatchObject({ size: sourceBefore.size, mtimeMs: sourceBefore.mtimeMs });

      const codexDatabasePath = join(root, "state_5.sqlite");
      const codexDatabase = new DatabaseSync(codexDatabasePath);
      codexDatabase.exec("CREATE TABLE source_state (value TEXT); PRAGMA user_version = 999;");
      codexDatabase.close();
      await expect(
        Promise.resolve().then(() =>
          openCacheDatabase(codexDatabasePath, { rebuildOnMigrationFailure: true }),
        ),
      ).rejects.toThrow("Refusing to open a cache database that is not named viewer.sqlite");
      const unchangedCodexDatabase = new DatabaseSync(codexDatabasePath, { readOnly: true });
      try {
        expect(
          unchangedCodexDatabase
            .prepare("SELECT name FROM sqlite_master WHERE name = 'source_state'")
            .get(),
        ).toEqual({ name: "source_state" });
      } finally {
        unchangedCodexDatabase.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a linked viewer cache before SQLite can mutate its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-cache-link-"));
    const codexDatabasePath = join(root, "state_5.sqlite");
    const viewerPath = join(root, "viewer.sqlite");
    const codexDatabase = new DatabaseSync(codexDatabasePath);
    codexDatabase.exec("CREATE TABLE source_state (value TEXT); PRAGMA user_version = 999;");
    codexDatabase.close();
    await link(codexDatabasePath, viewerPath);

    try {
      expect(() => openCacheDatabase(viewerPath, { rebuildOnMigrationFailure: true })).toThrow(
        "Refusing to open a linked viewer cache database",
      );
      const unchanged = new DatabaseSync(codexDatabasePath, { readOnly: true });
      try {
        expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({ user_version: 999 });
        expect(
          unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'source_state'").get(),
        ).toEqual({ name: "source_state" });
      } finally {
        unchanged.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
