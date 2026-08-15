import { describe, expect, it } from "vitest";

import { replaceCachedSession } from "../../../server/cache/conversationStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import {
  getCachedInspector,
  getCachedSessionSummary,
  getCachedTurnChunk,
  getCachedTurnNavigator,
  listCachedSessions,
} from "../../../server/cache/repositoryStore.ts";
import { cachedSource, normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";
import { representativeLargeSession } from "../../performance/fixtures.ts";

async function cachedFixture(turnCount?: number) {
  const source = await normalizedRolloutFixture({
    name: "modern.jsonl",
    sourcePath: "C:/fixtures/repository-store.jsonl",
    scope: "active",
    revision: "sha256:repository-store",
  });
  const session = turnCount === undefined ? source : representativeLargeSession(source, turnCount);
  session.summary.cwd = "C:/work_100%\\viewer";
  session.summary.models = ["gpt-test"];
  session.summary.toolCounts = { shell: 2 };
  session.summary.hasMedia = true;
  const database = openCacheDatabase(":memory:");
  replaceCachedSession(database, {
    session,
    diagnostics: [],
    source: cachedSource(session),
  });
  return { database, session };
}

describe("bounded cache repository", () => {
  it("applies every session filter and cursor boundary without loading conversation rows", async () => {
    const { database, session } = await cachedFixture();
    try {
      for (const query of [
        { scope: "active" as const, query: session.summary.title.slice(0, 5) },
        { scope: "active" as const, model: "gpt-test" },
        { scope: "active" as const, cwd: "C:/work_100%\\viewer" },
        { scope: "active" as const, tool: "shell" },
        { scope: "active" as const, hasMedia: true },
      ]) {
        expect(listCachedSessions(database, query)).toMatchObject({
          items: [{ id: session.summary.id }],
          nextCursor: null,
          total: 1,
        });
      }
      for (const query of [
        { scope: "archived" as const },
        { scope: "active" as const, query: "work_100%\\viewer" },
        { scope: "active" as const, model: "missing" },
        { scope: "active" as const, cwd: "C:/missing" },
        { scope: "active" as const, tool: "missing" },
        { scope: "active" as const, hasMedia: false },
        { scope: "active" as const, query: "   " },
      ]) {
        const page = listCachedSessions(database, query);
        expect(page.total).toBe(query.query?.trim() === "" ? 1 : 0);
      }
      expect(getCachedSessionSummary(database, session.summary.id)).toEqual(session.summary);
      expect(getCachedSessionSummary(database, "missing-session")).toBeNull();
      expect(() => listCachedSessions(database, { scope: "active", cursor: "invalid" })).toThrow(
        "Invalid repository cursor",
      );
      expect(() =>
        listCachedSessions(database, { scope: "active", cursor: "9".repeat(400) }),
      ).toThrow("Invalid repository cursor");
    } finally {
      database.close();
    }
  });

  it("builds navigator previews and every prose bucket from message columns", async () => {
    const { database, session } = await cachedFixture(5);
    try {
      const lengths = [100, 500, 1_500, 4_000];
      for (const [index, length] of lengths.entries()) {
        const turn = session.turns[index]!;
        turn.userMessage!.sourceMarkdown = `${"p".repeat(length)}\n prompt`;
        turn.assistantMessages[0]!.sourceMarkdown = " response";
      }
      const emptyTurn = session.turns[4]!;
      emptyTurn.userMessage = null;
      emptyTurn.assistantMessages = [];
      emptyTurn.startedAt = null;
      replaceCachedSession(database, {
        session,
        diagnostics: [],
        source: cachedSource(session),
      });

      const navigator = getCachedTurnNavigator(database, session.summary.id)!;
      expect(navigator.map(({ proseLengthBucket }) => proseLengthBucket)).toEqual([1, 2, 3, 4, 1]);
      expect(navigator[0]).toMatchObject({
        userMessageId: session.turns[0]!.userMessage!.id,
        promptPreview: `${"p".repeat(100)} prompt`,
        assistantPreview: "response",
      });
      expect(navigator[3]!.promptPreview).toMatch(/…$/u);
      expect(navigator[4]!).toMatchObject({
        userMessageId: null,
        promptPreview: "",
        assistantPreview: "",
        createdAt: null,
      });
      expect(getCachedTurnNavigator(database, "missing-session")).toBeNull();
    } finally {
      database.close();
    }
  });

  it("handles target, cursor, and empty-session turn chunk boundaries", async () => {
    const { database, session } = await cachedFixture(41);
    try {
      expect(getCachedTurnChunk(database, "missing-session", {})).toBeNull();
      expect(
        getCachedTurnChunk(database, session.summary.id, { targetTurnId: "missing-turn" }),
      ).toBeNull();
      expect(
        getCachedTurnChunk(database, session.summary.id, { cursor: "99", limit: 20 }),
      ).toBeNull();
      expect(
        getCachedTurnChunk(database, session.summary.id, { cursor: "1", limit: 20 }),
      ).toMatchObject({
        previousCursor: "0",
        nextCursor: "2",
        turns: session.turns.slice(20, 40),
      });
      expect(
        getCachedTurnChunk(database, session.summary.id, { cursor: "2", limit: 20 }),
      ).toMatchObject({
        previousCursor: "1",
        nextCursor: null,
        turns: session.turns.slice(40),
      });
      database.prepare("DELETE FROM turns WHERE session_id = ?").run(session.summary.id);
      database.prepare("UPDATE sessions SET turn_count = 0 WHERE id = ?").run(session.summary.id);
      expect(getCachedTurnChunk(database, session.summary.id, { cursor: "37" })).toMatchObject({
        turns: [],
        previousCursor: "36",
        nextCursor: null,
      });
    } finally {
      database.close();
    }
  });

  it("returns all inspector target kinds and ignores raw-event IDs absent from the cache", async () => {
    const { database, session } = await cachedFixture();
    try {
      const turn = session.turns[0]!;
      const message = turn.assistantMessages[0]!;
      const tool = turn.activities.find(({ kind }) => kind === "tool");
      const nonTool = turn.activities.find(({ kind }) => kind !== "tool");
      expect(tool).toBeDefined();
      expect(nonTool).toBeDefined();
      expect(
        getCachedInspector(database, session.summary.id, { type: "turn", id: turn.id }),
      ).toMatchObject({
        target: { type: "turn", id: turn.id },
        timeToFirstTokenMs: turn.timeToFirstTokenMs,
      });
      expect(
        getCachedInspector(database, session.summary.id, { type: "message", id: message.id }),
      ).toMatchObject({
        target: { type: "message", id: message.id },
        phase: message.phase,
      });
      expect(
        getCachedInspector(database, session.summary.id, { type: "activity", id: tool!.id }),
      ).toMatchObject({
        target: { type: "activity", id: tool!.id },
        timeToFirstTokenMs: null,
        completedAt: tool!.kind === "tool" ? tool.completedAt : null,
      });
      expect(
        getCachedInspector(database, session.summary.id, { type: "activity", id: nonTool!.id }),
      ).toMatchObject({
        target: { type: "activity", id: nonTool!.id },
        completedAt: null,
        durationMs: null,
      });
      expect(
        getCachedInspector(database, session.summary.id, { type: "turn", id: "missing" }),
      ).toBeNull();
      expect(
        getCachedInspector(database, session.summary.id, { type: "message", id: "missing" }),
      ).toBeNull();
      expect(
        getCachedInspector(database, session.summary.id, { type: "activity", id: "missing" }),
      ).toBeNull();

      message.rawEventIds.push("missing-raw-event");
      database
        .prepare("UPDATE turns SET payload_json = ? WHERE session_id = ? AND id = ?")
        .run(JSON.stringify(turn), session.summary.id, turn.id);
      const inspector = getCachedInspector(database, session.summary.id, {
        type: "message",
        id: message.id,
      });
      expect(inspector?.eventIds).toContain("missing-raw-event");
      expect(inspector?.rawRecords).toHaveLength(message.rawEventIds.length - 1);

      turn.assistantMessages = turn.assistantMessages.filter(({ id }) => id !== message.id);
      database
        .prepare("UPDATE turns SET payload_json = ? WHERE session_id = ? AND id = ?")
        .run(JSON.stringify(turn), session.summary.id, turn.id);
      expect(
        getCachedInspector(database, session.summary.id, { type: "message", id: message.id }),
      ).toBeNull();
    } finally {
      database.close();
    }
  });

  it("fails closed when bounded cache columns have invalid SQLite types or JSON", async () => {
    const { database, session } = await cachedFixture();
    try {
      database
        .prepare("UPDATE sessions SET summary_json = 'not-json' WHERE id = ?")
        .run(session.summary.id);
      expect(() => getCachedSessionSummary(database, session.summary.id)).toThrow(SyntaxError);

      database
        .prepare("UPDATE sessions SET summary_json = ? WHERE id = ?")
        .run(JSON.stringify(session.summary), session.summary.id);
      database
        .prepare(
          "UPDATE turns SET payload_json = 'not-json' WHERE session_id = ? AND turn_index = 0",
        )
        .run(session.summary.id);
      expect(() => getCachedTurnChunk(database, session.summary.id, {})).toThrow(SyntaxError);
    } finally {
      database.close();
    }
  });
});
