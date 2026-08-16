import type { DatabaseSync } from "node:sqlite";

import {
  CACHE_SCHEMA_VERSION,
  CATALOG_CACHE_SCHEMA_SQL,
  INITIAL_CACHE_SCHEMA_SQL,
} from "./schema.ts";

interface CacheMigration {
  version: number;
  sql: string;
}

const migrations: readonly CacheMigration[] = [
  { version: 1, sql: INITIAL_CACHE_SCHEMA_SQL },
  { version: 2, sql: CATALOG_CACHE_SCHEMA_SQL },
];

function userVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get();
  const value = row?.["user_version"];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("The viewer cache has an invalid schema version.");
  }
  return value;
}

export function migrateCacheDatabase(database: DatabaseSync): void {
  const current = userVersion(database);
  if (current > CACHE_SCHEMA_VERSION) {
    throw new Error(
      `Viewer cache schema ${current} is newer than supported schema ${CACHE_SCHEMA_VERSION}.`,
    );
  }

  for (const migration of migrations) {
    if (migration.version <= current) {
      continue;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) {
        database.exec("ROLLBACK");
      }
      throw error;
    }
  }
}
