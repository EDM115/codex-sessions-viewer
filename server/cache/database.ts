import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { migrateCacheDatabase } from "./migrations.ts";

export interface OpenCacheDatabaseOptions {
  rebuildOnMigrationFailure?: boolean | undefined;
}

function assertViewerDatabasePath(path: string): void {
  if (path !== ":memory:" && basename(path).toLowerCase() !== "viewer.sqlite") {
    throw new Error("Refusing to open a cache database that is not named viewer.sqlite.");
  }
  if (path === ":memory:") {
    return;
  }
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || stats.nlink > 1) {
      throw new Error("Refusing to open a linked viewer cache database.");
    }
    if (!stats.isFile()) {
      throw new Error("Refusing to open a viewer cache path that is not a regular file.");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function removeViewerDatabase(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    rmSync(candidate, { force: true });
  }
}

export function openCacheDatabase(
  path: string,
  options: OpenCacheDatabaseOptions = {},
): DatabaseSync {
  assertViewerDatabasePath(path);
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const database = new DatabaseSync(path, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
  if (path !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL;");
  }
  try {
    migrateCacheDatabase(database);
    return database;
  } catch (error) {
    database.close();
    if (!options.rebuildOnMigrationFailure || path === ":memory:") {
      throw error;
    }
    removeViewerDatabase(path);
    return openCacheDatabase(path);
  }
}

export function withCacheTransaction<T>(database: DatabaseSync, operation: () => T): T {
  if (database.isTransaction) {
    throw new Error("Nested viewer cache transactions are not supported.");
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}
