import { describe, expect, it } from "vitest";

import { replaceCachedSession } from "../../../server/cache/conversationStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import { searchCachedSessions } from "../../../server/cache/searchStore.ts";
import { createViewerDiagnostic } from "../../../shared/types/diagnostics.ts";
import { searchResponseSchema } from "../../../shared/types/repository.ts";
import { cachedSource, normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";

describe("cached full-text search", () => {
  it("indexes normalized transcript content and applies structured filters", async () => {
    const active = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: "C:\\codex\\sessions\\modern.jsonl",
      scope: "active",
      revision: "sha256:active",
    });
    const archived = await normalizedRolloutFixture({
      name: "legacy.jsonl",
      sourcePath: "C:\\codex\\archived_sessions\\legacy.jsonl",
      scope: "archived",
      revision: "sha256:archived",
    });
    const diagnostic = createViewerDiagnostic({
      code: "source.invalid_jsonl",
      severity: "warning",
      area: "source",
      message: "Constellation recovery skipped one malformed record.",
      path: active.summary.sourcePath,
      sessionId: active.summary.id,
      createdAt: "2026-01-01T10:00:21.000Z",
      details: { line: 21 },
    });
    const database = openCacheDatabase(":memory:");

    try {
      replaceCachedSession(database, {
        session: active,
        diagnostics: [diagnostic],
        source: cachedSource(active),
      });
      replaceCachedSession(database, {
        session: archived,
        diagnostics: [],
        source: cachedSource(archived, { hash: "b".repeat(64), inode: 3n }),
      });

      for (const query of [
        "Build parser",
        "parser ready",
        "event shapes",
        "filesystem read_file",
        "README.md",
        "diagram.png",
        "feature parser",
        "Constellation",
      ]) {
        const result = searchResponseSchema.parse(
          searchCachedSessions(database, { scope: "active", query }),
        );
        expect(result.items).toEqual([
          expect.objectContaining({
            sessionId: active.summary.id,
            turnId: active.turns[0]!.id,
            scope: "active",
            title: active.summary.title,
          }),
        ]);
        expect(result.items[0]!.excerpt.length).toBeGreaterThan(0);
      }

      expect(
        searchCachedSessions(database, { scope: "archived", query: "Legacy prompt" }).items,
      ).toEqual([expect.objectContaining({ sessionId: archived.summary.id, scope: "archived" })]);
      expect(
        searchCachedSessions(database, { scope: "active", query: "Legacy prompt" }).items,
      ).toEqual([]);
      expect(
        searchCachedSessions(database, {
          scope: "active",
          query: "parser",
          model: "gpt-exact-1",
          cwd: "C:\\work\\viewer",
          tool: "filesystem.read_file",
          hasMedia: true,
        }).items,
      ).toHaveLength(1);
      expect(
        searchCachedSessions(database, {
          scope: "active",
          query: "parser",
          tool: "filesystem.write_file",
        }).items,
      ).toEqual([]);
      expect(
        searchCachedSessions(database, {
          scope: "active",
          query: "parser",
          hasMedia: false,
        }).items,
      ).toEqual([]);
      expect(searchCachedSessions(database, { scope: "active", query: " " })).toEqual({
        items: [],
        nextCursor: null,
        total: 0,
      });
      expect(() => searchCachedSessions(database, { scope: "active", query: '"' })).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("replaces only the affected session's FTS rows", async () => {
    const active = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: "C:\\codex\\sessions\\modern.jsonl",
      scope: "active",
      revision: "sha256:active",
    });
    const archived = await normalizedRolloutFixture({
      name: "legacy.jsonl",
      sourcePath: "C:\\codex\\archived_sessions\\legacy.jsonl",
      scope: "archived",
      revision: "sha256:archived",
    });
    const database = openCacheDatabase(":memory:");

    try {
      replaceCachedSession(database, {
        session: active,
        diagnostics: [],
        source: cachedSource(active),
      });
      replaceCachedSession(database, {
        session: archived,
        diagnostics: [],
        source: cachedSource(archived, { hash: "b".repeat(64), inode: 3n }),
      });
      const archivedBefore = database
        .prepare("SELECT rowid, * FROM session_fts WHERE session_id = ? ORDER BY rowid")
        .all(archived.summary.id);

      replaceCachedSession(database, {
        session: active,
        diagnostics: [],
        source: cachedSource(active, { hash: "c".repeat(64), size: 8_192 }),
      });

      expect(
        database
          .prepare("SELECT count(*) AS count FROM session_fts WHERE session_id = ?")
          .get(active.summary.id),
      ).toEqual({ count: active.turns.length });
      expect(
        database
          .prepare("SELECT rowid, * FROM session_fts WHERE session_id = ? ORDER BY rowid")
          .all(archived.summary.id),
      ).toEqual(archivedBefore);
    } finally {
      database.close();
    }
  });
});
