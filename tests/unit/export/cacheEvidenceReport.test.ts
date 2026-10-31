import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { openCacheDatabase } from "#server/cache/database.ts";
import { inspectCacheEvidence } from "#server/export/cacheEvidenceReport.ts";

describe("saved cache diagnostic evidence", () => {
  it("handles absent and malformed optional fields without reporting a current source proof or leaking payloads", () => {
    const database = openCacheDatabase(":memory:");
    try {
      database.exec(
        "CREATE TABLE catalog_sidebar (id INTEGER PRIMARY KEY, payload_json TEXT NOT NULL)",
      );
      database.prepare("INSERT INTO catalog_sidebar VALUES (1, ?)").run(
        JSON.stringify({
          threads: [{ projectId: "missing", prompt: "private" }, null],
          projects: null,
        }),
      );
      database.prepare("INSERT INTO verified_history_projections VALUES (?, ?, ?, ?)").run(
        "a",
        "b",
        JSON.stringify({
          version: 2,
          dependencies: [
            null,
            {
              physicalRolloutId: "rollout",
              nextOrdinal: 27,
              endExclusive: 804,
              prompt: "private",
            },
          ],
        }),
        1,
      );
      expect(inspectCacheEvidence(database)).toMatchObject({
        authority: "saved-viewer-observations-not-current-source-validation",
        unresolvedProjectMappings: null,
        sections: { projectMappings: { availability: "partial" } },
        nativeProjection: {
          verifiedAssociations: 1,
          coveredDependencies: 1,
          missingLineage: 1,
          nextOrdinalMaximum: 27,
          nextByteMaximum: 804,
        },
        decodeReuse: "not-persisted-observe-selected-request",
      });
      expect(JSON.stringify(inspectCacheEvidence(database))).not.toContain("private");
      database.prepare("UPDATE catalog_sidebar SET payload_json = ?").run("malformed");
      expect(inspectCacheEvidence(database)).toMatchObject({
        unresolvedProjectMappings: null,
        sections: {
          projectMappings: { availability: "invalid", diagnostics: ["payload-invalid"] },
        },
      });
    } finally {
      database.close();
    }
  });
  it("distinguishes valid empty saved catalogs from absent or incomplete tables and aggregate fields", () => {
    const empty = openCacheDatabase(":memory:");
    const absent = new DatabaseSync(":memory:");
    try {
      empty.exec(
        "CREATE TABLE catalog_sidebar (id INTEGER PRIMARY KEY, payload_json TEXT NOT NULL)",
      );
      empty
        .prepare("INSERT INTO catalog_sidebar VALUES (1, ?)")
        .run(JSON.stringify({ threads: [], projects: [] }));
      expect(inspectCacheEvidence(empty)).toMatchObject({
        unresolvedProjectMappings: 0,
        sections: {
          projectMappings: { availability: "available", diagnostics: [] },
          catalog: { availability: "available" },
        },
      });
      const unavailable = inspectCacheEvidence(absent);
      expect(unavailable.unresolvedProjectMappings).toBeNull();
      expect(
        Object.values(unavailable.sections).every(
          ({ availability }) => availability === "unavailable",
        ),
      ).toBe(true);
      absent.exec(
        "CREATE TABLE catalog_sidebar (id INTEGER PRIMARY KEY); CREATE TABLE source_files (size INTEGER)",
      );
      expect(inspectCacheEvidence(absent)).toMatchObject({
        sections: {
          projectMappings: {
            availability: "unavailable",
            diagnostics: ["column-missing:payload_json"],
          },
          materializedGenerations: {
            availability: "unavailable",
            diagnostics: ["column-missing:parsed_bytes"],
          },
        },
      });
      empty
        .prepare("UPDATE catalog_sidebar SET payload_json = ?")
        .run(JSON.stringify({ threads: [], projects: null }));
      expect(inspectCacheEvidence(empty)).toMatchObject({
        unresolvedProjectMappings: null,
        sections: { projectMappings: { availability: "partial" } },
      });
      empty.prepare("UPDATE catalog_sidebar SET payload_json = ?").run(
        JSON.stringify({
          threads: [{ projectId: "missing" }, { projectId: null }],
          projects: [],
        }),
      );
      expect(inspectCacheEvidence(empty)).toMatchObject({
        unresolvedProjectMappings: 1,
        sections: { projectMappings: { availability: "available" } },
      });
      empty.exec("DELETE FROM catalog_sidebar");
      expect(inspectCacheEvidence(empty)).toMatchObject({
        unresolvedProjectMappings: null,
        sections: {
          projectMappings: { availability: "unavailable", diagnostics: ["row-missing"] },
        },
      });
    } finally {
      empty.close();
      absent.close();
    }
  });
});
