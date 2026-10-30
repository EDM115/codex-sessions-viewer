import { describe, expect, it } from "vitest";

import { writeCatalogLibrary } from "#server/cache/catalogStore.ts";
import { replaceCachedSession } from "#server/cache/conversationStore.ts";
import { openCacheDatabase } from "#server/cache/database.ts";
import { searchCachedSessions } from "#server/cache/searchStore.ts";
import { InvalidationBus } from "#server/live/invalidationBus.ts";
import { LiveReconciler } from "#server/live/reconciler.ts";
import { classifyCatalogThread } from "#server/metadata/threadClassification.ts";
import type { CatalogLibrary } from "#shared/types/library.ts";

import { cachedSource, normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";

describe("content search typed catalog membership", () => {
  it("keeps native none, projectless and Section none distinct in hits and deliberate indexing", async () => {
    const database = openCacheDatabase(":memory:");
    const template = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: "C:/fixtures/search.jsonl",
      scope: "active",
      revision: "search",
      root: true,
    });
    const ids = ["recent", "native-none", "section-chat", "child", "internal"];
    const catalog: CatalogLibrary = {
      projects: [
        {
          id: "none",
          name: "Native",
          rootPaths: [],
          hostId: null,
          source: "native",
          position: null,
          recencyAt: null,
        },
      ],
      threads: ids.map((id) => ({
        id,
        title: id,
        scope: "active",
        projectId: id === "native-none" ? "none" : null,
        hostId: null,
        sectionId: id === "section-chat" ? "none" : null,
        sectionPosition: null,
        pinned: false,
        recencyAt: null,
        classification: classifyCatalogThread(
          id === "internal"
            ? { threadSource: "guardian" }
            : id === "child"
              ? { source: { subagent: { thread_spawn: { parent_thread_id: "recent" } } } }
              : { threadSource: "user" },
        ),
      })),
      sections: [
        { id: "none", name: "Section", threadIds: ["section-chat"], projectIds: [], position: 0 },
      ],
      preferences: {
        scope: "active",
        chatSortMode: "manual",
        projectSortMode: "manual",
        projectOrder: [],
        pinnedOrder: [],
        projectThreadOrders: {},
      },
      diagnostics: [],
    };
    const reconciler = new LiveReconciler({
      database,
      bus: new InvalidationBus(),
      codexHome: "C:/fixtures",
      cacheDir: "C:/fixtures",
      fetchFavicons: false,
    });
    try {
      for (const id of ids) {
        const session = structuredClone(template);
        session.summary.id = id;
        session.summary.sourcePath = `C:/fixtures/${id}.jsonl`;
        session.summary.parentThreadId = id === "child" ? "recent" : null;
        replaceCachedSession(database, { session, diagnostics: [], source: cachedSource(session) });
        const classification = catalog.threads.find((thread) => thread.id === id)!.classification;
        database
          .prepare("UPDATE session_catalog SET structural_evidence_json = ? WHERE id = ?")
          .run(
            JSON.stringify({
              version: 2,
              origin: "native-metadata",
              status: "missing",
              classification,
              meta: null,
              parentThreadIdHint: classification.parentThreadId,
            }),
            id,
          );
      }
      writeCatalogLibrary(database, catalog);
      for (const [filter, expected] of [
        [{ projectId: "none" }, ["native-none"]],
        [{ projectId: null }, ["recent", "section-chat", "child"]],
        [{ groupId: "recents:none" }, ["recent"]],
        [{ groupId: "section:none" }, ["section-chat"]],
        [{ groupId: "project:none" }, ["native-none"]],
        [{ groupId: "section:missing" }, []],
        [{ parentThreadId: "recent" }, ["child"]],
      ] as const) {
        const query = { scope: "active" as const, query: "Build parser", ...filter };
        const hits = searchCachedSessions(database, query);
        expect([...new Set(hits.items.map((hit) => hit.sessionId))].sort()).toEqual(
          [...expected].sort(),
        );
        database.exec("UPDATE session_catalog SET materialization_state = 'cold'");
        const job = reconciler.startDeepSearch(query);
        reconciler.cancelDeepSearch(job.id);
        expect(job.total).toBe(expected.length);
        database.exec("UPDATE session_catalog SET materialization_state = 'ready'");
      }
    } finally {
      await reconciler.close();
      database.close();
    }
  });
});
