import { describe, expect, it } from "vitest";

import { classifyCatalogThread } from "../../../server/metadata/threadClassification.ts";
import { buildSidebarGroups } from "../../../shared/library/sidebarGroups.ts";
import type { CatalogLibrary, CatalogSidebarThread } from "../../../shared/types/library.ts";

function row(
  id: string,
  projectId: string | null,
  overrides: Partial<CatalogSidebarThread> = {},
): CatalogSidebarThread {
  return {
    id,
    title: id,
    projectId,
    hostId: "local",
    sectionId: null,
    sectionPosition: null,
    pinned: false,
    recencyAt: 1,
    scope: "active",
    classification: classifyCatalogThread({ threadSource: "user" }),
    ...overrides,
  };
}
function catalog(): CatalogLibrary {
  return {
    projects: [
      {
        id: "a",
        name: "A",
        rootPaths: ["C:/Work"],
        hostId: null,
        source: "native",
        position: 2,
        recencyAt: null,
      },
      {
        id: "b",
        name: "B",
        rootPaths: ["C:/Work"],
        hostId: null,
        source: "native",
        position: 1,
        recencyAt: null,
      },
      {
        id: "empty",
        name: "Empty",
        rootPaths: [],
        hostId: null,
        source: "native",
        position: 3,
        recencyAt: null,
      },
    ],
    threads: [
      row("a1", "a"),
      row("a2", "a", { recencyAt: 100 }),
      row("recent", null),
      row("child", "a", {
        classification: classifyCatalogThread({
          source: { subagent: { thread_spawn: { parent_thread_id: "a1" } } },
        }),
      }),
      row("internal", null, {
        classification: classifyCatalogThread({ threadSource: "guardian" }),
      }),
      row("archived", null, { scope: "archived" }),
    ],
    sections: [],
    preferences: {
      scope: "active",
      projectOrder: [],
      projectSortMode: "manual",
      chatSortMode: "manual",
      pinnedOrder: [],
      projectThreadOrders: { a: ["a1"] },
    },
    diagnostics: [],
  };
}
describe("buildSidebarGroups", () => {
  it("preserves saved empty projects, native order and projectless-only Recents without duplicates", () => {
    const source = catalog();
    const groups = buildSidebarGroups(source, source.preferences);
    expect(groups.map((group) => [group.id, group.threadIds])).toEqual([
      ["b", []],
      ["a", ["a1", "a2"]],
      ["empty", []],
      ["none", ["recent"]],
    ]);
    expect(groups.flatMap((group) => group.threadIds)).toEqual(["a1", "a2", "recent"]);
  });
  it("keeps explicit pin order ahead of selected recency and uses stable ID ties", () => {
    const source = catalog();
    source.threads.push(
      row("z", null, { pinned: true }),
      row("y", null, { pinned: true }),
      row("tie-b", null),
      row("tie-a", null),
    );
    source.preferences.pinnedOrder = ["z", "y"];
    source.preferences.chatSortMode = "updated_at";
    expect(
      buildSidebarGroups(source, source.preferences).find((group) => group.id === "a")?.threadIds,
    ).toEqual(["a2", "a1"]);
    expect(buildSidebarGroups(source, source.preferences).at(-1)?.threadIds).toEqual([
      "z",
      "y",
      "recent",
      "tie-a",
      "tie-b",
    ]);
    source.preferences.scope = "archived";
    expect(buildSidebarGroups(source, source.preferences).at(-1)?.threadIds).toEqual(["archived"]);
  });
  it("places section projects and direct roots once while preserving membership, suppressing empty Pinned", () => {
    const source = catalog();
    source.sections = [
      { id: "empty-pin", name: "Pinned", threadIds: [], projectIds: [], position: 0 },
      {
        id: "review",
        name: "Review",
        threadIds: ["a2", "recent", "internal"],
        projectIds: ["b"],
        position: 1,
      },
    ];
    const groups = buildSidebarGroups(source, source.preferences);
    expect(groups.map((group) => group.id)).toEqual(["a", "empty", "review", "b", "none"]);
    expect(groups.find((group) => group.id === "a")?.threadIds).toEqual(["a1"]);
    expect(groups.find((group) => group.id === "review")).toMatchObject({
      threadIds: ["a2", "recent"],
      projectIds: ["b"],
    });
    expect(groups.find((group) => group.id === "b")?.sectionId).toBe("review");
    expect(source.threads.find((thread) => thread.id === "a2")?.projectId).toBe("a");
    expect(new Set(groups.flatMap((group) => group.threadIds)).size).toBe(3);
  });
});
