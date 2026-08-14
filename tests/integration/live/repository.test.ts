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
import {
  inspectorRecordSchema,
  turnChunkSchema,
  turnNavigatorResponseSchema,
} from "../../../shared/types/repository.ts";
import { cachedSource, normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";

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
      const staticNavigator = z
        .strictObject({
          sessionId: z.string(),
          revision: z.string(),
          chunkSize: z.int().positive(),
          items: turnNavigatorResponseSchema,
        })
        .parse(navigatorJson);
      const staticTurns = turnChunkSchema.parse(turnsJson);
      const staticInspectors = z
        .strictObject({
          sessionId: z.string(),
          revision: z.string(),
          records: z.array(inspectorRecordSchema),
        })
        .parse(inspectorsJson);
      const firstTurn = session.turns[0]!;

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
    } finally {
      database.close();
    }
  });
});
