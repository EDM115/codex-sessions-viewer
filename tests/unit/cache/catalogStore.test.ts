import { describe, expect, it } from "vitest";

import {
  catalogMaterializedSessionIds,
  catalogSession,
  listCatalogProjects,
  listCatalogSessions,
  markCatalogSessionReady,
  removeCatalogSource,
  setCatalogMaterialization,
  upsertCatalogSessions,
  writeCatalogLibrary,
  type CatalogSessionInput,
} from "../../../server/cache/catalogStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import { classifyCatalogThread } from "../../../server/metadata/threadClassification.ts";
import type { ConversationSummary } from "../../../shared/types/conversation.ts";

function summary(id: string, options: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `Session ${id}`,
    scope: "active",
    sourcePath: `C:\\codex\\sessions\\${id}.jsonl`,
    createdAt: "2026-08-13T08:00:00.000Z",
    updatedAt: "2026-08-13T08:30:00.000Z",
    cwd: "C:\\Work\\viewer",
    gitBranch: "main",
    gitSha: null,
    gitOriginUrl: null,
    models: [],
    reasoningEfforts: [],
    turnCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    toolCounts: {},
    preview: "",
    pinned: false,
    sectionName: null,
    parentThreadId: null,
    childThreadIds: [],
    hasMedia: false,
    diagnosticCount: 0,
    revision: `catalog:${id}`,
    ...options,
  };
}

function catalogInput(id: string, options: Partial<CatalogSessionInput> = {}): CatalogSessionInput {
  const { summary: summaryOverride, ...inputOverrides } = options;
  const value = { ...summary(id), ...summaryOverride };
  return {
    kind: "root",
    materialization: "cold",
    project: {
      id: "codex:viewer",
      name: "Viewer",
      source: "codex",
      hint: "C:\\Work\\viewer",
    },
    parentThreadId: null,
    agentPath: null,
    agentNickname: null,
    agentDepth: null,
    childCount: 0,
    sourceSize: 1_024,
    sourceMtimeMs: 1_786_550_400_000,
    sourceDevice: "1",
    sourceInode: id,
    sourceRevision: value.revision,
    error: null,
    ...inputOverrides,
    summary: value,
  };
}

describe("session catalog store", () => {
  it("carries disagreeing active and archived project recency order through the compatibility API", () => {
    const database = openCacheDatabase(":memory:");
    try {
      const rows = [
        catalogInput("aa"),
        catalogInput("ba"),
        catalogInput("ar", { summary: summary("ar", { scope: "archived" }) }),
        catalogInput("br", { summary: summary("br", { scope: "archived" }) }),
      ];
      upsertCatalogSessions(database, rows);
      writeCatalogLibrary(database, {
        projects: ["a", "b"].map((id) => ({
          id,
          name: id,
          rootPaths: [],
          hostId: null,
          source: "native",
          position: null,
          recencyAt: null,
        })),
        sections: [],
        diagnostics: [],
        preferences: {
          scope: "active",
          chatSortMode: "updated_at",
          projectSortMode: "updated_at",
          projectOrder: [],
          pinnedOrder: [],
          projectThreadOrders: {},
        },
        threads: rows.map((row, index) => ({
          id: row.summary.id,
          title: row.summary.id,
          scope: row.summary.scope,
          projectId: index % 2 ? "b" : "a",
          hostId: null,
          sectionId: null,
          sectionPosition: null,
          pinned: false,
          recencyAt: [20, 10, 10, 20].at(index)!,
          classification: classifyCatalogThread({ threadSource: "user" }),
        })),
      });
      expect(
        listCatalogProjects(database)
          .filter((project) => project.id !== "none")
          .map((project) => [project.id, project.sidebar?.order]),
      ).toEqual([
        ["a", { active: 0, archived: 1 }],
        ["b", { active: 1, archived: 0 }],
      ]);
    } finally {
      database.close();
    }
  });
  it("keeps catalog projectless, archive and pin metadata when later content normalization supplies cwd defaults", () => {
    const database = openCacheDatabase(":memory:");
    try {
      upsertCatalogSessions(database, [
        catalogInput("kept", {
          project: { id: "none", name: "Recents", source: "none", hint: null },
          summary: summary("kept", { scope: "archived", pinned: true, sectionName: "Review" }),
        }),
      ]);
      expect(
        markCatalogSessionReady(
          database,
          summary("kept", {
            scope: "active",
            pinned: false,
            sectionName: null,
            cwd: "C:/different",
          }),
        ),
      ).toBe(true);
      expect(catalogSession(database, "kept")).toMatchObject({
        project: { id: "none" },
        summary: { scope: "archived", pinned: true, sectionName: "Review" },
      });
    } finally {
      database.close();
    }
  });
  it("uses current validated structural visibility when a stored grouping projection is older", () => {
    const database = openCacheDatabase(":memory:");
    try {
      upsertCatalogSessions(database, [
        catalogInput("recovered", {
          project: { id: "none", name: "Recents", source: "none", hint: null },
        }),
      ]);
      writeCatalogLibrary(database, {
        projects: [],
        sections: [],
        diagnostics: [],
        preferences: {
          scope: "active",
          chatSortMode: "manual",
          projectSortMode: "manual",
          projectOrder: [],
          pinnedOrder: [],
          projectThreadOrders: {},
        },
        threads: [
          {
            id: "recovered",
            title: "Recovered",
            scope: "active",
            projectId: null,
            hostId: null,
            sectionId: null,
            sectionPosition: null,
            pinned: false,
            recencyAt: 1,
            classification: classifyCatalogThread({ threadSource: "custom-role" }),
          },
        ],
      });
      expect(listCatalogProjects(database)).toEqual([
        expect.objectContaining({ id: "none", activeCount: 1 }),
      ]);
      expect(
        listCatalogSessions(database, { scope: "active", projectId: null }).items.map(
          (item) => item.id,
        ),
      ).toEqual(["recovered"]);
    } finally {
      database.close();
    }
  });
  it("uses the same safe visibility fallback for missing and invalid persisted classification", () => {
    const database = openCacheDatabase(":memory:");
    try {
      upsertCatalogSessions(database, [catalogInput("legacy"), catalogInput("invalid")]);
      database
        .prepare("UPDATE session_catalog SET structural_evidence_json = ? WHERE id = 'invalid'")
        .run(
          JSON.stringify({
            version: 2,
            origin: "rollout-prefix",
            status: "found",
            parentThreadIdHint: null,
            meta: null,
            classification: { visibility: "user-root" },
          }),
        );
      expect(listCatalogSessions(database, { scope: "active" }).items.map((row) => row.id)).toEqual(
        ["legacy"],
      );
      expect(listCatalogProjects(database)[0]?.activeCount).toBe(1);
      expect(catalogSession(database, "invalid")?.structuralEvidence?.classification).toMatchObject(
        { visibility: "unresolved", reasons: ["invalid-classification-evidence"] },
      );
    } finally {
      database.close();
    }
  });
  it("paginates root conversations by project and scope without counting children or auxiliaries", () => {
    const database = openCacheDatabase(":memory:");
    const roots = Array.from({ length: 21 }, (_, index) =>
      catalogInput(`root-${String(index).padStart(2, "0")}`, {
        summary: {
          ...summary(`root-${String(index).padStart(2, "0")}`),
          updatedAt: index === 20 ? "2026-08-13T09:00:00.000Z" : "2026-08-13T08:30:00.000Z",
        },
      }),
    );
    const child = catalogInput("child", {
      kind: "subagent",
      parentThreadId: "root-00",
      agentPath: "/root/review",
      agentDepth: 1,
      summary: summary("child", { parentThreadId: "root-00" }),
    });
    const guardian = catalogInput("guardian", {
      kind: "auxiliary",
      parentThreadId: "root-00",
      summary: summary("guardian", {
        parentThreadId: "root-00",
        models: ["codex-auto-review"],
      }),
    });
    const archived = catalogInput("archived", {
      summary: summary("archived", { scope: "archived" }),
    });

    try {
      upsertCatalogSessions(database, [...roots, child, guardian, archived]);

      const page = listCatalogSessions(database, {
        scope: "active",
        projectId: "codex:viewer",
        parentThreadId: "__root__",
        limit: 20,
      });
      const children = listCatalogSessions(database, {
        scope: "active",
        projectId: "codex:viewer",
        parentThreadId: "root-00",
        limit: 20,
      });

      expect(page.items).toHaveLength(20);
      expect(page.total).toBe(21);
      expect(page.nextCursor).toBe("20");
      expect(page.items.every(({ kind }) => kind === "root")).toBe(true);
      expect(page.items.map((item) => item.id).slice(0, 3)).toEqual([
        "root-20",
        "root-00",
        "root-01",
      ]);
      expect(
        listCatalogSessions(database, {
          scope: "active",
          projectId: "codex:viewer",
          parentThreadId: "__root__",
          cursor: page.nextCursor!,
          limit: 20,
        }),
      ).toMatchObject({
        items: [{ id: "root-19" }],
        total: 21,
        nextCursor: null,
      });
      expect(children.items.map((item) => item.id)).toEqual(["child"]);
      expect(children.total).toBe(1);
      expect(listCatalogProjects(database)).toEqual([
        expect.objectContaining({
          id: "codex:viewer",
          name: "Viewer",
          activeCount: 21,
          archivedCount: 1,
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it("preserves failures for an unchanged source and resets them for a new revision", () => {
    const database = openCacheDatabase(":memory:");
    const failed = catalogInput("retry", {
      materialization: "failed",
      error: "temporary parse failure",
    });

    try {
      upsertCatalogSessions(database, [failed]);
      upsertCatalogSessions(database, [catalogInput("retry")]);
      expect(catalogSession(database, "retry")).toMatchObject({
        materialization: "failed",
        error: "temporary parse failure",
      });

      upsertCatalogSessions(database, [
        catalogInput("retry", {
          sourceRevision: "catalog:retry:new",
          summary: summary("retry", { revision: "catalog:retry:new" }),
        }),
      ]);
      expect(catalogSession(database, "retry")).toMatchObject({
        materialization: "cold",
        error: null,
        sourceRevision: "catalog:retry:new",
      });

      for (const state of ["queued", "loading", "ready"] as const) {
        setCatalogMaterialization(database, "retry", state, null);
        expect(catalogSession(database, "retry")?.materialization).toBe(state);
      }
      expect(catalogMaterializedSessionIds(database)).toEqual(["retry"]);
    } finally {
      database.close();
    }
  });

  it("retains selected materialization state while keeping content metrics out of catalog metadata", () => {
    const database = openCacheDatabase(":memory:");

    try {
      upsertCatalogSessions(database, [
        catalogInput("ready", {
          materialization: "ready",
          summary: summary("ready", {
            turnCount: 7,
            assistantMessageCount: 5,
            toolCallCount: 3,
            models: ["gpt-5.6-sol"],
          }),
        }),
      ]);
      upsertCatalogSessions(database, [
        catalogInput("ready", {
          summary: summary("ready", {
            title: "Renamed session",
            pinned: true,
            sectionName: "Current work",
          }),
        }),
      ]);

      expect(catalogSession(database, "ready")).toMatchObject({
        materialization: "ready",
        summary: {
          title: "Renamed session",
          pinned: true,
          sectionName: "Current work",
        },
      });
      expect(catalogSession(database, "ready")?.summary).not.toHaveProperty("turnCount");
      expect(catalogSession(database, "ready")?.summary).not.toHaveProperty("models");
    } finally {
      database.close();
    }
  });

  it("marks existing catalog rows ready only when revision and path both match", () => {
    const database = openCacheDatabase(":memory:");
    const current = catalogInput("fenced", { sourceRevision: "catalog:expected" });
    const hydrated = summary("fenced", {
      title: "Hydrated conversation",
      revision: "sha256:normalized",
      turnCount: 4,
    });

    try {
      upsertCatalogSessions(database, [current]);
      expect(
        markCatalogSessionReady(database, hydrated, {
          sourceRevision: "catalog:stale",
          sourcePath: current.summary.sourcePath!,
        }),
      ).toBe(false);
      expect(
        markCatalogSessionReady(database, hydrated, {
          sourceRevision: "catalog:expected",
          sourcePath: `${current.summary.sourcePath}.moved`,
        }),
      ).toBe(false);
      expect(catalogSession(database, "fenced")).toMatchObject({
        materialization: "cold",
        summary: { title: "Session fenced" },
      });

      expect(
        markCatalogSessionReady(database, hydrated, {
          sourceRevision: "catalog:expected",
          sourcePath: current.summary.sourcePath!,
        }),
      ).toBe(true);
      expect(catalogSession(database, "fenced")).toMatchObject({
        materialization: "ready",
        sourceRevision: "catalog:expected",
        summary: { title: "Session fenced" },
      });

      upsertCatalogSessions(database, [catalogInput("auxiliary", { kind: "auxiliary" })]);
      expect(
        markCatalogSessionReady(database, summary("auxiliary"), {
          sourceRevision: "catalog:auxiliary",
          sourcePath: summary("auxiliary").sourcePath,
        }),
      ).toBe(false);
      expect(catalogSession(database, "auxiliary")?.materialization).toBe("cold");
    } finally {
      database.close();
    }
  });

  it("removes a catalog source without exposing auxiliary rows", () => {
    const database = openCacheDatabase(":memory:");
    const visible = catalogInput("visible");
    const auxiliary = catalogInput("approval", { kind: "auxiliary" });

    try {
      upsertCatalogSessions(database, [visible, auxiliary]);
      expect(removeCatalogSource(database, visible.summary.sourcePath!)).toBe("visible");
      expect(catalogSession(database, "visible")).toBeNull();
      expect(
        listCatalogSessions(database, {
          scope: "active",
          projectId: "codex:viewer",
          parentThreadId: "__root__",
        }).items,
      ).toEqual([]);
      expect(catalogSession(database, "approval")).toMatchObject({ kind: "auxiliary" });
    } finally {
      database.close();
    }
  });
});
