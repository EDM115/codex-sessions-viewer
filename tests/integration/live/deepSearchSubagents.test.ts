import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { openCacheDatabase } from "../../../server/cache/database.ts";
import { InvalidationBus } from "../../../server/live/invalidationBus.ts";
import { LiveReconciler } from "../../../server/live/reconciler.ts";
import { LiveConversationRepository } from "../../../server/live/repository.ts";

describe("deep search child discovery", () => {
  it("indexes a cold child-only match, preserves parent navigation and excludes guardian sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-child-search-"));
    const sessions = join(root, "sessions");
    await mkdir(sessions);
    const rootId = "11111111-1111-4111-8111-111111111111";
    const childId = "22222222-2222-4222-8222-222222222222";
    const guardianId = "33333333-3333-4333-8333-333333333333";
    const scanId = "44444444-4444-4444-8444-444444444444";
    const unknownId = "55555555-5555-4555-8555-555555555555";
    const timestamp = "2026-09-14T10:00:00.000Z";
    const rollout = (id: string, source: unknown, prompt: string, threadSource?: string) =>
      [
        {
          type: "session_meta",
          payload: {
            id,
            timestamp,
            source,
            thread_source: threadSource,
            name: null,
            has_user_event: 0,
          },
        },
        { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: `${id}-turn` } },
        { timestamp, type: "event_msg", payload: { type: "user_message", message: prompt } },
        { timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: `${id}-turn` } },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n";
    await Promise.all([
      writeFile(join(sessions, "root.jsonl"), rollout(rootId, "cli", "Ordinary parent", "user")),
      writeFile(
        join(sessions, "scan.jsonl"),
        rollout(scanId, "cli", "UniquelyDiscoverableChildTerm", "security_scan"),
      ),
      writeFile(
        join(sessions, "unknown.jsonl"),
        rollout(unknownId, "cli", "UniquelyDiscoverableChildTerm", "custom-role"),
      ),
      writeFile(
        join(sessions, "child.jsonl"),
        rollout(
          childId,
          { subagent: { thread_spawn: { parent_thread_id: rootId } } },
          "UniquelyDiscoverableChildTerm",
        ),
      ),
      writeFile(
        join(sessions, "guardian.jsonl"),
        rollout(
          guardianId,
          { subagent: { other: "guardian", parent_thread_id: rootId } },
          "UniquelyDiscoverableChildTerm",
        ),
      ),
    ]);
    const database = openCacheDatabase(":memory:");
    const bus = new InvalidationBus();
    const reconciler = new LiveReconciler({
      database,
      bus,
      codexHome: root,
      cacheDir: root,
      fetchFavicons: false,
      watch: () => ({ ready: new Promise<void>(() => {}), close: async () => {} }),
    });
    const repository = new LiveConversationRepository(database, bus, reconciler);
    const query = {
      scope: "active" as const,
      query: "UniquelyDiscoverableChildTerm",
      parentThreadId: "__root__",
    };
    try {
      await reconciler.start();
      await reconciler.whenRecoverySettled();
      expect(
        (await repository.listSessions({ scope: "active", parentThreadId: "__root__" })).items.map(
          (item) => item.id,
        ),
      ).toEqual([rootId]);
      expect((await repository.search(query)).total).toBe(0);
      const started = await repository.startDeepSearch(query);
      expect(started.total).toBe(2);
      await vi.waitFor(async () => {
        expect(await repository.getDeepSearch(started.id)).toMatchObject({
          state: "completed",
          completed: 2,
          failed: 0,
          resultCount: 1,
        });
      });
      const found = await repository.search(query);
      expect(found).toMatchObject({
        total: 1,
        items: [{ sessionId: childId, parentThreadId: rootId, turnId: `${childId}-turn` }],
      });
      expect(await repository.getSession(childId)).toMatchObject({ parentThreadId: rootId });
      expect(
        (await repository.getTurns(childId, { targetTurnId: found.items[0]!.turnId, limit: 1 }))
          .turns[0]?.userMessage?.sourceMarkdown,
      ).toBe("UniquelyDiscoverableChildTerm");
      expect(
        database.prepare("SELECT 1 FROM sessions WHERE id = ?").get(guardianId),
      ).toBeUndefined();
      expect(repository.getClassification(unknownId)).toMatchObject({
        classification: { visibility: "unresolved" },
      });
      await expect(repository.getSession(unknownId)).resolves.toMatchObject({ id: unknownId });
      expect((await repository.search(query)).items.map((hit) => hit.sessionId)).toEqual([childId]);
      expect(
        (await repository.listProjects()).reduce((sum, project) => sum + project.activeCount, 0),
      ).toBe(1);
    } finally {
      await reconciler.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
