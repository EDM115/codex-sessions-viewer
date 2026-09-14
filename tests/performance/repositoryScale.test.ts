import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import { getCachedSession, replaceCachedSession } from "../../server/cache/conversationStore.ts";
import { openCacheDatabase } from "../../server/cache/database.ts";
import { createPagefindTurnRecords } from "../../server/export/buildPagefind.ts";
import { writeStaticPayloads } from "../../server/export/writeStaticPayloads.ts";
import { InvalidationBus } from "../../server/live/invalidationBus.ts";
import { LiveReconciler } from "../../server/live/reconciler.ts";
import { LiveConversationRepository } from "../../server/live/repository.ts";
import { cachedSource, normalizedRolloutFixture } from "../fixtures/cache/normalized.ts";
import { representativeLargeSession } from "./fixtures.ts";

const temporaryDirectories: string[] = [];

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function measure(iterations: number, operation: () => void): number {
  const durations: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    operation();
    durations.push(performance.now() - startedAt);
  }
  return median(durations);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("representative repository scale", () => {
  it("keeps static publication chunked and live target reads bounded for 500 turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-performance-"));
    temporaryDirectories.push(root);
    const source = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(root, "modern.jsonl"),
      scope: "active",
      revision: "sha256:scale-source",
    });
    const session = representativeLargeSession(source);
    const startedAt = performance.now();
    const database = openCacheDatabase(":memory:");
    try {
      replaceCachedSession(database, {
        session,
        diagnostics: [],
        source: cachedSource(session, { size: 8_000_000 }),
      });
      const staticResult = await writeStaticPayloads([session], {
        generatedRoot: root,
        chunkSize: 20,
      });
      const repository = new LiveConversationRepository(database, new InvalidationBus());
      const liveChunk = await repository.getTurns(session.summary.id, {
        targetTurnId: "scale-turn-487",
        limit: 20,
      });
      const staticChunk = JSON.parse(
        await readFile(
          join(root, "payloads", "sessions", session.summary.id, "turn-24.json"),
          "utf8",
        ),
      ) as { turns: Array<{ id: string }> };
      const payloadFiles = await readdir(join(root, "payloads", "sessions", session.summary.id));
      const searchRecords = createPagefindTurnRecords([session]);

      expect(staticResult).toMatchObject({ sessionCount: 1, turnChunkCount: 25 });
      expect(payloadFiles.filter((name) => name.startsWith("turn-"))).toHaveLength(25);
      expect(payloadFiles.filter((name) => name.startsWith("inspector-"))).toHaveLength(25);
      expect(liveChunk.turns).toHaveLength(20);
      expect(liveChunk.turns.map(({ id }) => id)).toEqual(staticChunk.turns.map(({ id }) => id));
      expect(liveChunk.turns[7]?.id).toBe("scale-turn-487");
      expect(searchRecords).toHaveLength(500);
      expect(performance.now() - startedAt).toBeLessThan(30_000);
    } finally {
      database.close();
    }
  }, 35_000);

  it("keeps the real warm live repository materially faster than full-session reconstruction", async () => {
    const source = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: "C:/fixtures/performance-bounded.jsonl",
      scope: "active",
      revision: "sha256:performance-bounded",
    });
    const session = representativeLargeSession(source);
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    const cacheDir = await mkdtemp(join(tmpdir(), "viewer-warm-benchmark-"));
    temporaryDirectories.push(cacheDir);
    const reconciler = new LiveReconciler({
      database,
      bus,
      cacheDir,
      codexHome: cacheDir,
      fetchFavicons: false,
    });
    const repository = new LiveConversationRepository(database, bus, reconciler);
    try {
      replaceCachedSession(database, {
        session,
        diagnostics: [],
        source: cachedSource(session, { size: 8_000_000 }),
      });
      for (let index = 0; index < 3; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- Warm each serial repository read before measuring latency.
        await repository.getTurns(session.summary.id, {
          targetTurnId: "scale-turn-487",
          limit: 20,
        });
        getCachedSession(database, session.summary.id);
      }
      const boundedTimes: number[] = [];
      for (let index = 0; index < 20; index += 1) {
        const started = performance.now();
        // oxlint-disable-next-line no-await-in-loop -- Sequential timing samples measure per-request latency.
        const chunk = await repository.getTurns(session.summary.id, {
          targetTurnId: "scale-turn-487",
          limit: 20,
        });
        if (chunk?.turns.length !== 20) {
          throw new Error("The bounded query returned the wrong chunk.");
        }
        boundedTimes.push(performance.now() - started);
      }
      const boundedMedianMs = median(boundedTimes);
      const fullMedianMs = measure(20, () => {
        const loaded = getCachedSession(database, session.summary.id);
        if (loaded?.turns.length !== 500) {
          throw new Error("The full-session baseline is incomplete.");
        }
      });

      expect(
        boundedMedianMs,
        `bounded ${boundedMedianMs.toFixed(3)} ms vs full ${fullMedianMs.toFixed(3)} ms`,
      ).toBeLessThan(fullMedianMs * 0.5);
    } finally {
      await reconciler.close();
      database.close();
    }
  });

  it("stores a large raw event once when several inspectors reference it", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-inspector-pool-"));
    temporaryDirectories.push(root);
    const session = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: join(root, "modern.jsonl"),
      scope: "active",
      revision: "sha256:inspector-pool",
    });
    const turn = session.turns[0]!;
    const rawEventId = "large-shared-event";
    const referencedEntities = [
      turn.userMessage,
      turn.assistantMessages[0],
      turn.activities[0],
    ].filter((entity) => entity !== null && entity !== undefined);
    expect(referencedEntities).toHaveLength(3);
    for (const entity of referencedEntities) {
      entity.rawEventIds = [rawEventId];
    }
    session.turns = [turn];
    session.summary.turnCount = 1;
    session.rawEvents = [
      {
        id: rawEventId,
        turnId: turn.id,
        type: "performance.fixture",
        timestamp: null,
        payload: { blob: `raw-event-marker-${"x".repeat(1_000_000)}` },
      },
    ];

    await writeStaticPayloads([session], { generatedRoot: root, chunkSize: 20 });
    const inspectorText = await readFile(
      join(root, "payloads", "sessions", session.summary.id, "inspector-0.json"),
      "utf8",
    );
    const inspector = JSON.parse(inspectorText) as {
      records: Array<{ eventIds: string[] }>;
      rawRecords: Record<string, unknown>;
    };

    expect(inspector.records.filter(({ eventIds }) => eventIds.includes(rawEventId))).toHaveLength(
      4,
    );
    expect(Object.keys(inspector.rawRecords)).toEqual([rawEventId]);
    expect(inspectorText.match(/raw-event-marker/gu)).toHaveLength(1);
    expect(inspectorText.length).toBeLessThan(1_250_000);
  });
});
