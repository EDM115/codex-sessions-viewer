import { describe, expect, it } from "vitest";

import { catalogSession, listCatalogSessions } from "../../../server/cache/catalogStore.ts";
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
