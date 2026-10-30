import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeStaticPayloads } from "#server/export/writeStaticPayloads.ts";
import { classifyCatalogThread } from "#server/metadata/threadClassification.ts";
import type { CatalogLibrary } from "#shared/types/library.ts";
import { StaticConversationRepository } from "~/repositories/static.ts";

import { normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("static v2 catalog writer/reader parity", () => {
  it("preserves nullable membership, colliding native IDs, identical roots, Section order and host identity", async () => {
    const generatedRoot = await mkdtemp(join(tmpdir(), "viewer-static-v2-"));
    roots.push(generatedRoot);
    const template = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: "C:/fixture.jsonl",
      scope: "active",
      revision: "v2",
      root: true,
    });
    const classification = classifyCatalogThread({ threadSource: "user" });
    const ids = ["recent", "native-none", "second", "section-chat", "hidden"];
    const conversations = ids.map((id) => ({
      ...structuredClone(template),
      summary: { ...template.summary, id, title: id, parentThreadId: null, childThreadIds: [] },
      classification:
        id === "hidden" ? classifyCatalogThread({ threadSource: "guardian" }) : classification,
    }));
    const catalog: CatalogLibrary = {
      projects: ["none", "other"].map((id) => ({
        id,
        name: id,
        rootPaths: ["C:/same"],
        hostId: "host-a",
        source: "native",
        position: null,
        recencyAt: null,
      })),
      threads: conversations.map((conversation, index) => ({
        id: conversation.summary.id,
        title: conversation.summary.title,
        scope: "active",
        projectId: index === 1 ? "none" : index === 2 ? "other" : null,
        hostId: "host-a",
        sectionId: index === 3 ? "none" : null,
        sectionPosition: null,
        pinned: false,
        recencyAt: index,
        classification: conversation.classification,
      })),
      sections: [
        { id: "none", name: "Custom", threadIds: ["section-chat"], projectIds: [], position: 0 },
      ],
      preferences: {
        scope: "active",
        chatSortMode: "manual",
        projectSortMode: "manual",
        projectOrder: ["other", "none"],
        pinnedOrder: [],
        projectThreadOrders: {},
      },
      diagnostics: [],
    };
    await writeStaticPayloads(conversations, { generatedRoot, catalog });
    const requested: string[] = [];
    const repository = new StaticConversationRepository(
      async (path) => {
        requested.push(path);
        return JSON.parse(await readFile(join(generatedRoot, path), "utf8")) as unknown;
      },
      async () => ({
        search: async (_query, options) => ({
          results: ids
            .filter(
              (id) =>
                typeof options.filters["session"] === "object" &&
                options.filters["session"].any.includes(id),
            )
            .map((id) => ({
              data: async () => ({
                meta: { sessionId: id, turnId: "turn", title: id },
                excerpt: "match",
              }),
            })),
        }),
      }),
    );
    const groups = await repository.listProjects();
    expect(groups.map(({ groupId }) => groupId)).toEqual([
      "project:other",
      "project:none",
      "section:none",
      "recents:none",
    ]);
    expect(
      groups
        .filter(({ sidebar }) => sidebar?.kind === "project")
        .map(({ hostId, rootPaths }) => ({ hostId, rootPaths })),
    ).toEqual([
      { hostId: "host-a", rootPaths: ["C:/same"] },
      { hostId: "host-a", rootPaths: ["C:/same"] },
    ]);
    expect(
      (await repository.listSessions({ scope: "active", groupId: "recents:none" })).items.map(
        ({ id, projectId }) => ({ id, projectId }),
      ),
    ).toEqual([{ id: "recent", projectId: null }]);
    expect(
      (await repository.listSessions({ scope: "active", groupId: "project:none" })).items.map(
        ({ id, projectId }) => ({ id, projectId }),
      ),
    ).toEqual([{ id: "native-none", projectId: "none" }]);
    expect(
      (await repository.listSessions({ scope: "active", groupId: "section:none" })).items.map(
        ({ id, projectId }) => ({ id, projectId }),
      ),
    ).toEqual([{ id: "section-chat", projectId: null }]);
    expect((await repository.listSessions({ scope: "active", query: "hidden" })).total).toBe(0);
    expect(
      requested.every(
        (path) => path === "/payloads/projects.json" || path === "/payloads/sessions/index.json",
      ),
    ).toBe(true);
    const index = JSON.parse(
      await readFile(join(generatedRoot, "payloads/sessions/index.json"), "utf8"),
    ) as { version: number; sessions: unknown[] };
    expect(index.version).toBe(2);
    expect(index.sessions[0]).not.toHaveProperty("turnCount");
    for (const [groupId, id] of [
      ["project:none", "native-none"],
      ["recents:none", "recent"],
      ["section:none", "section-chat"],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- Compare each typed scope with its own expected identity
      const hits = await repository.search({ scope: "active", query: "match", groupId });
      expect(hits.total).toBe(1);
      expect(hits.items.map((hit) => hit.sessionId)).toEqual([id]);
    }
    expect(
      (await repository.search({ scope: "active", query: "match" })).items.map(
        (hit) => hit.sessionId,
      ),
    ).not.toContain("hidden");
  });
});
