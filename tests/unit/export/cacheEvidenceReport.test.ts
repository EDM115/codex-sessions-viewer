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
        unresolvedProjectMappings: 1,
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
      expect(inspectCacheEvidence(database).unresolvedProjectMappings).toBe(0);
    } finally {
      database.close();
    }
  });
});
