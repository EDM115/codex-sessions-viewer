import { describe, expect, it } from "vitest";

import {
  catalogSession,
  listCatalogSessions,
  upsertCatalogSessions,
  type CatalogSessionInput,
} from "../../../server/cache/catalogStore.ts";
import { getCachedSession, replaceCachedSession } from "../../../server/cache/conversationStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import type { NormalizedSession } from "../../../server/normalization/normalizeSession.ts";
import { cachedSource, normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";

async function normalizedFixture(): Promise<NormalizedSession> {
  return normalizedRolloutFixture({
    name: "modern.jsonl",
    sourcePath: "C:\\codex\\sessions\\modern.jsonl",
    scope: "active",
    revision: "sha256:fixture-revision",
  });
}

function coldCatalogInput(
  session: NormalizedSession,
  sourceRevision: string,
  kind: CatalogSessionInput["kind"] = "root",
): CatalogSessionInput {
  const source = cachedSource(session);
  return {
    summary: { ...session.summary, revision: sourceRevision },
    kind,
    materialization: "cold",
    project: { id: "codex:viewer", name: "Viewer", source: "codex", hint: session.summary.cwd },
    parentThreadId: null,
    agentPath: null,
    agentNickname: null,
    agentDepth: null,
    childCount: 0,
    sourceSize: source.fingerprint.size,
    sourceMtimeMs: source.fingerprint.mtimeMs,
    sourceDevice: source.identity.device.toString(),
    sourceInode: source.identity.inode.toString(),
    sourceRevision,
    error: null,
  };
}

describe("cached conversations", () => {
  it("transactionally stores and restores a complete normalized session", async () => {
    const session = await normalizedFixture();
    const database = openCacheDatabase(":memory:");

    try {
      replaceCachedSession(database, {
        session,
        diagnostics: [],
        source: cachedSource(session),
      });

      expect(getCachedSession(database, session.summary.id)).toEqual(session);
      expect(database.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({
        count: 1,
      });
      expect(database.prepare("SELECT count(*) AS count FROM turns").get()).toEqual({ count: 2 });
      expect(database.prepare("SELECT count(*) AS count FROM messages").get()).toEqual({
        count: 4,
      });
      expect(database.prepare("SELECT count(*) AS count FROM raw_events").get()).toEqual({
        count: session.rawEvents.length,
      });
      expect(catalogSession(database, session.summary.id)).toMatchObject({
        materialization: "ready",
        summary: { revision: session.summary.revision },
      });
      expect(
        listCatalogSessions(database, {
          scope: "active",
          parentThreadId: "__root__",
        }).items[0]?.summary,
      ).toEqual({ ...session.summary, parentThreadId: null });
    } finally {
      database.close();
    }
  });

  it("preserves the last good revision when replacement fails midway", async () => {
    const session = await normalizedFixture();
    const database = openCacheDatabase(":memory:");

    try {
      const source = cachedSource(session);
      replaceCachedSession(database, { session, diagnostics: [], source });
      const duplicateMessageId = session.turns[0]?.assistantMessages[0]?.id;
      if (
        duplicateMessageId === undefined ||
        session.turns[1]?.assistantMessages[0] === undefined
      ) {
        throw new Error("Expected assistant messages in both fixture turns");
      }
      const broken: NormalizedSession = structuredClone(session);
      broken.summary.revision = "sha256:must-not-commit";
      const targetMessage = broken.turns[1]?.assistantMessages[0];
      if (targetMessage === undefined) {
        throw new Error("Expected the cloned fixture to preserve its second assistant message");
      }
      targetMessage.id = duplicateMessageId;

      expect(() =>
        replaceCachedSession(database, { session: broken, diagnostics: [], source }),
      ).toThrow("UNIQUE constraint failed");
      expect(getCachedSession(database, session.summary.id)).toEqual(session);
    } finally {
      database.close();
    }
  });

  it("commits all cache rows only against the expected catalog revision and path", async () => {
    const session = await normalizedFixture();
    const database = openCacheDatabase(":memory:");
    const source = cachedSource(session);
    const expectedRevision = "catalog:expected";

    try {
      upsertCatalogSessions(database, [coldCatalogInput(session, expectedRevision)]);
      expect(
        replaceCachedSession(database, {
          session,
          diagnostics: [],
          source,
          expectedCatalogSourceRevision: expectedRevision,
        }),
      ).toEqual({ status: "committed" });
      expect(getCachedSession(database, session.summary.id)).toEqual(session);
      expect(catalogSession(database, session.summary.id)).toMatchObject({
        materialization: "ready",
        sourceRevision: expectedRevision,
        summary: { revision: session.summary.revision },
      });
      expect(database.prepare("SELECT count(*) AS count FROM source_files").get()).toEqual({
        count: 1,
      });
      expect(database.prepare("SELECT count(*) AS count FROM messages").get()).toEqual({
        count: 4,
      });
    } finally {
      database.close();
    }
  });

  it("changes no cache or catalog rows for stale, moved, missing, or auxiliary catalog entries", async () => {
    const session = await normalizedFixture();
    const source = cachedSource(session);
    const cases = [
      {
        name: "stale revision",
        catalog: coldCatalogInput(session, "catalog:current"),
        expectedRevision: "catalog:stale",
      },
      {
        name: "moved source",
        catalog: coldCatalogInput(
          {
            ...session,
            summary: { ...session.summary, sourcePath: `${session.summary.sourcePath}.moved` },
          },
          "catalog:expected",
        ),
        expectedRevision: "catalog:expected",
      },
      { name: "missing catalog", catalog: null, expectedRevision: "catalog:expected" },
      {
        name: "auxiliary catalog",
        catalog: coldCatalogInput(session, "catalog:expected", "auxiliary"),
        expectedRevision: "catalog:expected",
      },
    ] as const;

    for (const scenario of cases) {
      const database = openCacheDatabase(":memory:");
      try {
        if (scenario.catalog !== null) {
          upsertCatalogSessions(database, [scenario.catalog]);
        }
        const catalogBefore = database
          .prepare("SELECT * FROM session_catalog WHERE id = ?")
          .get(session.summary.id);
        expect(
          replaceCachedSession(database, {
            session,
            diagnostics: [],
            source,
            expectedCatalogSourceRevision: scenario.expectedRevision,
          }),
        ).toEqual({ status: "stale-catalog" });
        expect(database.prepare("SELECT count(*) AS count FROM source_files").get()).toEqual({
          count: 0,
        });
        expect(database.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({
          count: 0,
        });
        expect(database.prepare("SELECT count(*) AS count FROM turns").get()).toEqual({ count: 0 });
        expect(database.prepare("SELECT count(*) AS count FROM messages").get()).toEqual({
          count: 0,
        });
        expect(database.prepare("SELECT count(*) AS count FROM diagnostics").get()).toEqual({
          count: 0,
        });
        expect(
          database.prepare("SELECT * FROM session_catalog WHERE id = ?").get(session.summary.id),
        ).toEqual(catalogBefore);
      } finally {
        database.close();
      }
    }

    const staticDatabase = openCacheDatabase(":memory:");
    try {
      expect(replaceCachedSession(staticDatabase, { session, diagnostics: [], source })).toEqual({
        status: "committed",
      });
      expect(getCachedSession(staticDatabase, session.summary.id)).toEqual(session);
    } finally {
      staticDatabase.close();
    }
  });

  it("isolates protocol-local turn and message IDs between sessions", async () => {
    const first = await normalizedFixture();
    const second = structuredClone(first);
    second.summary.id = "22222222-2222-4222-8222-222222222222";
    second.summary.sourcePath = "C:\\codex\\archived_sessions\\second.jsonl";
    second.summary.scope = "archived";
    second.summary.revision = "sha256:second";
    for (const turn of second.turns) {
      turn.sessionId = second.summary.id;
    }
    const database = openCacheDatabase(":memory:");

    try {
      replaceCachedSession(database, {
        session: first,
        diagnostics: [],
        source: cachedSource(first),
      });
      replaceCachedSession(database, {
        session: second,
        diagnostics: [],
        source: cachedSource(second, { hash: "b".repeat(64), inode: 3n }),
      });

      expect(getCachedSession(database, first.summary.id)).toEqual(first);
      expect(getCachedSession(database, second.summary.id)).toEqual(second);
      expect(database.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({
        count: 2,
      });
    } finally {
      database.close();
    }
  });
});
