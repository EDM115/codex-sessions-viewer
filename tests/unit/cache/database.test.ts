import { link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  upsertCatalogSessions,
  catalogSession,
  writeCatalogLibrary,
} from "../../../server/cache/catalogStore.ts";
import { openCacheDatabase, withCacheTransaction } from "../../../server/cache/database.ts";
import { migrateCacheDatabase } from "../../../server/cache/migrations.ts";
import {
  CACHE_SCHEMA_VERSION,
  INITIAL_CACHE_SCHEMA_SQL,
  CATALOG_CACHE_SCHEMA_SQL,
  STRUCTURAL_EVIDENCE_SCHEMA_SQL,
  SOURCE_GENERATION_SCHEMA_SQL,
} from "../../../server/cache/schema.ts";
import { classifyCatalogThread } from "../../../server/metadata/threadClassification.ts";

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
  it("upgrades populated schema4 metadata and normalized storage without losing evidence, grouping or IDs", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(INITIAL_CACHE_SCHEMA_SQL);
      seedVersionOneSession(database);
      database.exec(CATALOG_CACHE_SCHEMA_SQL);
      database.exec(STRUCTURAL_EVIDENCE_SCHEMA_SQL);
      database.exec(SOURCE_GENERATION_SCHEMA_SQL);
      database.exec("PRAGMA user_version = 4");
      const classification = classifyCatalogThread({ threadSource: "user" });
      const evidence = {
        version: 2,
        origin: "rollout-prefix",
        status: "missing",
        parentThreadIdHint: null,
        meta: null,
        classification,
      };
      database
        .prepare("UPDATE session_catalog SET structural_evidence_json = ?")
        .run(JSON.stringify(evidence));
      writeCatalogLibrary(database, {
        projects: [
          {
            id: "native-project",
            name: "Native",
            rootPaths: ["C:/Work/viewer"],
            hostId: null,
            source: "native",
            position: 0,
            recencyAt: null,
          },
        ],
        threads: [
          {
            id: "session-v1",
            title: "Existing cached session",
            scope: "active",
            projectId: "native-project",
            hostId: null,
            sectionId: null,
            sectionPosition: null,
            pinned: false,
            recencyAt: 1,
            classification,
          },
        ],
        sections: [],
        preferences: {
          scope: "active",
          chatSortMode: "manual",
          projectSortMode: "manual",
          projectOrder: ["native-project"],
          pinnedOrder: [],
          projectThreadOrders: {},
        },
        diagnostics: [],
      });
      const tables = ["source_files", "sessions", "session_catalog", "catalog_sidebar"];
      const before = tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all());
      migrateCacheDatabase(database);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: CACHE_SCHEMA_VERSION,
      });
      expect(tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all())).toEqual(
        before,
      );
      const retained = catalogSession(database, "session-v1")!;
      expect(retained.structuralEvidence).toEqual(evidence);
      upsertCatalogSessions(database, [
        {
          ...retained,
          summary: {
            ...retained.summary,
            id: "db-only",
            sourcePath: null,
            createdAt: null,
            updatedAt: null,
          },
          materialization: "cold",
          sourceRevision: "metadata:db-only",
        },
      ]);
      expect(catalogSession(database, "db-only")?.summary).toMatchObject({
        id: "db-only",
        sourcePath: null,
        createdAt: null,
        updatedAt: null,
      });
      upsertCatalogSessions(database, [
        {
          ...retained,
          summary: { ...retained.summary, id: "distinct-thread-same-path" },
          sourceRevision: "metadata:distinct-thread",
        },
      ]);
      expect(catalogSession(database, "distinct-thread-same-path")?.summary.sourcePath).toBe(
        retained.summary.sourcePath,
      );
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
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

  it("retains version-one normalized sessions while marking old parser identities cold", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(INITIAL_CACHE_SCHEMA_SQL);
    database.exec("PRAGMA user_version = 1");
    seedVersionOneSession(database);
    database
      .prepare("INSERT INTO session_fts (session_id, title) VALUES (?, ?)")
      .run("session-v1", "old parser index");
    const insertTurn = database.prepare(
      "INSERT INTO turns (id, session_id, turn_index, started_at, completed_at, payload_json) VALUES (?, 'session-v1', ?, NULL, NULL, ?)",
    );
    insertTurn.run("valid-turn", 0, JSON.stringify({ finalAssistantMessageId: "final-choice" }));
    insertTurn.run("invalid-turn", 1, "{");

    try {
      migrateCacheDatabase(database);
      expect(database.prepare("SELECT count(*) AS count FROM session_fts").get()).toEqual({
        count: 0,
      });

      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: CACHE_SCHEMA_VERSION,
      });
      expect(
        database
          .prepare(
            "SELECT id, session_kind, materialization_state FROM session_catalog WHERE id = ?",
          )
          .get("session-v1"),
      ).toEqual({
        id: "session-v1",
        session_kind: "root",
        materialization_state: "cold",
      });
      expect(
        database
          .prepare("SELECT structural_evidence_json FROM session_catalog WHERE id = 'session-v1'")
          .get(),
      ).toEqual({ structural_evidence_json: null });
      expect(
        database
          .prepare(
            "SELECT id, rich_revision, final_assistant_message_id FROM turns ORDER BY turn_index",
          )
          .all(),
      ).toEqual([
        { id: "valid-turn", rich_revision: null, final_assistant_message_id: "final-choice" },
        { id: "invalid-turn", rich_revision: null, final_assistant_message_id: null },
      ]);
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
