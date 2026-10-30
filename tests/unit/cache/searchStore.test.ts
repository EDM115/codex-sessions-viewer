import { describe, expect, it } from "vitest";

import { listCatalogProjects, listCatalogSessions } from "#server/cache/catalogStore.ts";
import { replaceCachedSession } from "#server/cache/conversationStore.ts";
import { openCacheDatabase } from "#server/cache/database.ts";
import { countCachedSearchResults, searchCachedSessions } from "#server/cache/searchStore.ts";
import {
  classifyCatalogThread,
  cachedThreadClassification,
} from "#server/metadata/threadClassification.ts";
import { createViewerDiagnostic } from "#shared/types/diagnostics.ts";
import { searchResponseSchema } from "#shared/types/repository.ts";

import { cachedSource, normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";

describe("cached full-text search", () => {
  it("uses supported persisted-envelope policy for JavaScript, SQL lists, project counts and search", async () => {
    const session = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: "C:/fixtures/envelope.jsonl",
      scope: "active",
      revision: "envelope",
    });
    session.summary.parentThreadId = null;
    session.rawEvents = [
      {
        id: "meta",
        type: "session_meta",
        turnId: null,
        timestamp: null,
        payload: {
          type: "session_meta",
          payload: { id: session.summary.id, source: "cli", thread_source: "user" },
        },
      },
    ];
    const database = openCacheDatabase(":memory:");
    try {
      replaceCachedSession(database, { session, diagnostics: [], source: cachedSource(session) });
      const base = {
        version: 2,
        origin: "rollout-prefix",
        status: "missing",
        parentThreadIdHint: null,
        meta: null,
      };
      const cases: Array<[unknown, boolean]> = [
        [null, true],
        [{ ...base, version: 1 }, true],
        [
          {
            ...base,
            version: 999,
            classification: classifyCatalogThread({ threadSource: "user" }),
          },
          false,
        ],
        [{ ...base, status: "invalid" }, false],
        [base, false],
      ];
      for (const [evidence, visible] of cases) {
        database
          .prepare("UPDATE session_catalog SET structural_evidence_json = ? WHERE id = ?")
          .run(evidence === null ? null : JSON.stringify(evidence), session.summary.id);
        expect(cachedThreadClassification(evidence, "root").visibility).toBe(
          visible ? "user-root" : "unresolved",
        );
        expect(listCatalogSessions(database, { scope: "active" }).total).toBe(visible ? 1 : 0);
        expect(
          listCatalogProjects(database).reduce((sum, project) => sum + project.activeCount, 0),
        ).toBe(visible ? 1 : 0);
        expect(countCachedSearchResults(database, { scope: "active", query: "Build parser" })).toBe(
          visible ? 1 : 0,
        );
      }
    } finally {
      database.close();
    }
  });
  it("excludes structural helpers from already materialized search while retaining users with helper model names", async () => {
    const database = openCacheDatabase(":memory:");
    try {
      for (const [index, threadSource] of [
        "user",
        "security_scan",
        "guardian_review",
        "custom-role",
      ].entries()) {
        // oxlint-disable-next-line no-await-in-loop -- Each fixture is independently written into the same SQLite store before the next one
        const session = await normalizedRolloutFixture({
          name: "modern.jsonl",
          sourcePath: `C:/fixtures/${index}.jsonl`,
          scope: "active",
          revision: `revision-${index}`,
        });
        session.summary.id = `session-${index}`;
        session.summary.models = ["codex-auto-review"];
        session.summary.parentThreadId = null;
        session.rawEvents = [
          {
            id: `meta-${index}`,
            turnId: null,
            type: "session_meta",
            timestamp: null,
            payload: {
              type: "session_meta",
              payload: { id: session.summary.id, thread_source: threadSource, source: "cli" },
            },
          },
        ];
        replaceCachedSession(database, {
          session,
          diagnostics: [],
          source: cachedSource(session, { inode: BigInt(index + 1) }),
        });
      }
      expect(
        searchCachedSessions(database, { scope: "active", query: "Build parser" }).items.map(
          (hit) => hit.sessionId,
        ),
      ).toEqual(["session-0"]);
      expect(database.prepare("SELECT count(*) AS count FROM sessions").get()?.["count"]).toBe(4);
    } finally {
      database.close();
    }
  });
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
    active.turns[0]!.steeringMessages = [
      {
        ...active.turns[0]!.userMessage!,
        id: "message-steering-search",
        sourceMarkdown: "Please include the Windows boundary.",
        body: {
          type: "document",
          children: [{ type: "text", text: "Please include the Windows boundary." }],
        },
      },
    ];
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
        "Windows boundary",
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
      const projectId = database
        .prepare("SELECT project_id FROM session_catalog WHERE id = ?")
        .get(active.summary.id)?.["project_id"];
      expect(typeof projectId).toBe("string");
      for (const [query, expected] of [
        [{ scope: "active", query: "Build parser" }, 1],
        [{ scope: "archived", query: "Legacy prompt" }, 1],
        [{ scope: "active", query: "Build parser", projectId: String(projectId) }, 1],
        [{ scope: "active", query: "Build parser", model: "gpt-exact-1" }, 1],
        [{ scope: "active", query: "Build parser", model: "missing-model" }, 0],
        [{ scope: "active", query: "Build parser", cwd: "C:\\work\\viewer" }, 1],
        [{ scope: "active", query: "Build parser", cwd: "C:\\other" }, 0],
        [{ scope: "active", query: "Build parser", tool: "filesystem.read_file" }, 1],
        [{ scope: "active", query: "Build parser", hasMedia: true }, 1],
        [{ scope: "active", query: "Build parser", hasMedia: false }, 0],
        [{ scope: "active", query: " " }, 0],
      ] as const) {
        expect(countCachedSearchResults(database, query)).toBe(expected);
      }
      expect(
        countCachedSearchResults(database, {
          scope: "active",
          query: "parser",
          projectId: "missing-project",
        }),
      ).toBe(0);
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
    active.turns[0]!.userMessage!.sourceMarkdown = "copperarch before replacement";

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

      active.turns[0]!.userMessage!.sourceMarkdown = "indigoquartz after replacement";
      replaceCachedSession(database, {
        session: active,
        diagnostics: [],
        source: cachedSource(active, { hash: "c".repeat(64), size: 8_192 }),
      });

      expect(
        searchCachedSessions(database, { scope: "active", query: "copperarch" }).items,
      ).toEqual([]);
      expect(
        searchCachedSessions(database, { scope: "active", query: "indigoquartz" }).items,
      ).toEqual([
        expect.objectContaining({ sessionId: active.summary.id, turnId: active.turns[0]!.id }),
      ]);
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
