import { link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openCacheDatabase, withCacheTransaction } from "../../../server/cache/database.ts";
import { CACHE_SCHEMA_VERSION } from "../../../server/cache/schema.ts";

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
