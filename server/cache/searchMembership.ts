import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { readCatalogLibrary } from "#server/cache/catalogStore.ts";
import { searchMembershipIds } from "#shared/library/searchMembership.ts";
import type { SearchQuery } from "#shared/types/repository.ts";

export function searchMembershipFilter(
  database: DatabaseSync,
  query: SearchQuery,
  alias: "s" | "c",
): { sql: string; values: SQLInputValue[] } {
  const library = readCatalogLibrary(database);
  if (library) {
    return {
      sql: `${alias}.id IN (SELECT value FROM json_each(?))`,
      values: [JSON.stringify(searchMembershipIds(library, query))],
    };
  }
  const clauses: string[] = [];
  const values: SQLInputValue[] = [];
  if (query.projectId !== undefined) {
    clauses.push(
      `EXISTS (SELECT 1 FROM session_catalog membership WHERE membership.id = ${alias}.id AND membership.project_id = ?)`,
    );
    values.push(query.projectId ?? "none");
  }
  // Legacy catalogs cannot resolve typed group collisions safely
  if (query.groupId !== undefined) {
    clauses.push("0");
  }
  if (query.parentThreadId !== undefined && query.parentThreadId !== "__root__") {
    clauses.push(`${alias}.parent_thread_id = ?`);
    values.push(query.parentThreadId);
  }
  return { sql: clauses.join(" AND ") || "1", values };
}
