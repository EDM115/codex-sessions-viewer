import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod";

import { replaceCachedSession } from "../../../server/cache/conversationStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import { writeStaticPayloads } from "../../../server/export/writeStaticPayloads.ts";
import { InvalidationBus } from "../../../server/live/invalidationBus.ts";
import { LiveConversationRepository } from "../../../server/live/repository.ts";
import { conversationSummarySchema } from "../../../shared/types/conversation.ts";
import { viewerDiagnosticSchema } from "../../../shared/types/diagnostics.ts";
import { turnChunkSchema } from "../../../shared/types/repository.ts";
import {
  hydrateStaticInspectorRecords,
  staticInspectorChunkSchema,
  staticNavigatorPayloadSchema,
} from "../../../shared/types/staticPayloads.ts";
import { cachedSource, normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";
import { representativeLargeSession } from "../../performance/fixtures.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

describe("live repository payloads", () => {
  it("matches the static repository contracts for the same normalized session", async () => {
    const generatedRoot = await mkdtemp(join(tmpdir(), "codex-viewer-live-repository-"));
    temporaryRoots.push(generatedRoot);
    const session = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(generatedRoot, "modern.jsonl"),
      scope: "active",
      revision: "sha256:fixture",
    });
    const database = openCacheDatabase(":memory:");
    try {
      replaceCachedSession(database, {
        session,
        diagnostics: [],
        source: cachedSource(session),
      });
      await writeStaticPayloads([session], { generatedRoot, chunkSize: 20 });
      const repository = new LiveConversationRepository(database, new InvalidationBus());
      const sessionRoot = join(generatedRoot, "payloads", "sessions", session.summary.id);
      const [summaryJson, navigatorJson, turnsJson, inspectorsJson] = await Promise.all([
        json(join(sessionRoot, "summary.json")),
        json(join(sessionRoot, "navigator.json")),
        json(join(sessionRoot, "turn-0.json")),
        json(join(sessionRoot, "inspector-0.json")),
      ]);
      const staticSummary = z
        .strictObject({
          summary: conversationSummarySchema,
          diagnostics: z.array(viewerDiagnosticSchema),
        })
        .parse(summaryJson);
      const staticNavigator = staticNavigatorPayloadSchema.parse(navigatorJson);
      const staticTurns = turnChunkSchema.parse(turnsJson);
      const staticInspectorChunk = staticInspectorChunkSchema.parse(inspectorsJson);
      const staticInspectors = {
        sessionId: staticInspectorChunk.sessionId,
        revision: staticInspectorChunk.revision,
        records: hydrateStaticInspectorRecords(staticInspectorChunk),
      };
      const firstTurn = session.turns[0]!;
      const assistantMessage = firstTurn.assistantMessages.at(-1);
      if (assistantMessage === undefined) {
        throw new Error("Expected the fixture's first turn to contain an assistant message.");
      }

      await expect(repository.getSession(session.summary.id)).resolves.toEqual(
        staticSummary.summary,
      );
      await expect(repository.getTurnNavigator(session.summary.id)).resolves.toEqual(
        staticNavigator.items,
      );
      await expect(
        repository.getTurns(session.summary.id, { cursor: "0", limit: 20 }),
      ).resolves.toEqual(staticTurns);
      await expect(
        repository.getInspector(session.summary.id, { type: "turn", id: firstTurn.id }),
      ).resolves.toEqual(
        staticInspectors.records.find(
          ({ target }: { target: { type: string; id: string } }) =>
            target.type === "turn" && target.id === firstTurn.id,
        ),
      );
      const messageInspector = await repository.getInspector(session.summary.id, {
        type: "message",
        id: assistantMessage.id,
      });
      expect(messageInspector).toMatchObject({
        target: { type: "message", id: assistantMessage.id },
        phase: assistantMessage.phase,
        durationMs: firstTurn.durationMs,
        timeToFirstTokenMs: firstTurn.timeToFirstTokenMs,
        tokenDelta: firstTurn.tokenDelta,
        eventIds: assistantMessage.rawEventIds,
      });
      expect(
        messageInspector.rawRecords.map((record) =>
          typeof record === "object" && record !== null && "id" in record ? record["id"] : null,
        ),
      ).toEqual(assistantMessage.rawEventIds);
      expect(messageInspector).toEqual(
        staticInspectors.records.find(
          ({ target }) => target.type === "message" && target.id === assistantMessage.id,
        ),
      );
    } finally {
      database.close();
    }
  });

  it("reads only the requested live rows instead of reconstructing unrelated turns", async () => {
    const source = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: "C:/fixtures/bounded-live.jsonl",
      scope: "active",
      revision: "sha256:bounded-source",
    });
    const session = representativeLargeSession(source, 41);
    const database = openCacheDatabase(":memory:");
    try {
      replaceCachedSession(database, {
        session,
        diagnostics: [],
        source: cachedSource(session),
      });
      database
        .prepare("UPDATE turns SET payload_json = ? WHERE session_id = ? AND turn_index = ?")
        .run("unrelated invalid JSON", session.summary.id, 40);
      const repository = new LiveConversationRepository(database, new InvalidationBus());
      const firstTurn = session.turns[0]!;
      const messageId = firstTurn.assistantMessages[0]!.id;

      await expect(
        repository.getTurns(session.summary.id, { cursor: "0", limit: 20 }),
      ).resolves.toMatchObject({
        turns: session.turns.slice(0, 20),
        previousCursor: null,
        nextCursor: "1",
      });
      await expect(repository.getTurnNavigator(session.summary.id)).resolves.toHaveLength(41);
      await expect(
        repository.getInspector(session.summary.id, { type: "message", id: messageId }),
      ).resolves.toMatchObject({ target: { type: "message", id: messageId } });
      await expect(
        repository.getTurns(session.summary.id, { cursor: "2", limit: 20 }),
      ).rejects.toThrow("JSON");
    } finally {
      database.close();
    }
  });
});
