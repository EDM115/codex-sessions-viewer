import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { catalogSession, listCatalogSessions } from "../../../server/cache/catalogStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import type { SourceDiscoveryResult } from "../../../server/ingestion/discoverSources.ts";
import { refreshLiveCatalog } from "../../../server/live/catalogBuilder.ts";
import type { GlobalStateMetadata } from "../../../server/metadata/globalState.ts";
import type { StateMetadataSnapshot } from "../../../server/metadata/stateSnapshot.ts";

const fixtureRoot = join(process.cwd(), "tests", "fixtures", "catalog");

function discovery(names: string[]): SourceDiscoveryResult {
  return {
    rollouts: names.map((name) => ({ path: join(fixtureRoot, name), scope: "active" })),
    metadata: { sessionIndex: null, globalState: null, stateDatabase: null, stateWal: null },
    diagnostics: [],
  };
}

const globalState: GlobalStateMetadata = {
  projects: [
    { id: "work", name: "Work", rootPaths: ["C:\\Work"] },
    { id: "viewer", name: "Viewer", rootPaths: ["c:\\work\\viewer"] },
  ],
  pinnedThreadIds: [],
};

const emptyStateSnapshot: StateMetadataSnapshot = { threads: [], sections: [], spawnEdges: [] };

describe("refreshLiveCatalog", () => {
  it("classifies roots, nested subagents, guardians, and project folders without normalizing sessions", async () => {
    const database = openCacheDatabase(":memory:");

    try {
      const result = await refreshLiveCatalog({
        database,
        discovery: discovery([
          "root.jsonl",
          "subagent.jsonl",
          "guardian.jsonl",
          "missing-meta.jsonl",
        ]),
        sessionIndexEntries: [
          { id: "root", threadName: "Root conversation", updatedAt: "2026-08-13T09:00:00.000Z" },
        ],
        globalState,
        stateSnapshot: {
          ...emptyStateSnapshot,
          spawnEdges: [{ parentThreadId: "root", childThreadId: "child", status: "running" }],
        },
      });

      expect(result.rows.find(({ summary }) => summary.id === "root")).toMatchObject({
        kind: "root",
        materialization: "cold",
        project: { id: "codex:viewer", name: "Viewer" },
        childCount: 1,
      });
      expect(result.rows.find(({ summary }) => summary.id === "child")).toMatchObject({
        kind: "subagent",
        parentThreadId: "root",
        agentDepth: 1,
        agentPath: "/root/review",
        agentNickname: "Fermat",
      });
      expect(result.rows.find(({ summary }) => summary.id === "guardian")).toMatchObject({
        kind: "auxiliary",
        parentThreadId: "root",
      });
      expect(catalogSession(database, "guardian")).toMatchObject({ kind: "auxiliary" });
      expect(database.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({
        count: 0,
      });
      expect(
        listCatalogSessions(database, {
          scope: "active",
          projectId: "codex:viewer",
          parentThreadId: "__root__",
        }).items.map(({ summary }) => summary.id),
      ).toEqual(["root"]);
      expect(result.projects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "codex:viewer", activeCount: 1, archivedCount: 0 }),
        ]),
      );
      expect(result.bytesRead).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });

  it("rejects parent cycles, falls back to the filename ID, and removes stale catalog sources", async () => {
    const database = openCacheDatabase(":memory:");

    try {
      await refreshLiveCatalog({
        database,
        discovery: discovery(["root.jsonl"]),
        sessionIndexEntries: [],
        globalState,
        stateSnapshot: emptyStateSnapshot,
      });
      const result = await refreshLiveCatalog({
        database,
        discovery: discovery(["cycle-a.jsonl", "cycle-b.jsonl", "missing-meta.jsonl"]),
        sessionIndexEntries: [],
        globalState: { projects: [], pinnedThreadIds: [] },
        stateSnapshot: emptyStateSnapshot,
      });

      expect(result.rows.filter(({ summary }) => summary.id.startsWith("cycle-"))).toEqual([
        expect.objectContaining({ kind: "root", parentThreadId: null }),
        expect.objectContaining({ kind: "root", parentThreadId: null }),
      ]);
      expect(result.rows.find(({ summary }) => summary.id === "missing-meta")).toMatchObject({
        kind: "root",
      });
      expect(result.diagnostics.some(({ message }) => message.includes("cycle"))).toBe(true);
      expect(catalogSession(database, "root")).toBeNull();
      expect(result.removedIds).toEqual(["root"]);
    } finally {
      database.close();
    }
  });

  it("promotes a subagent whose parent is absent so it remains visible as a root conversation", async () => {
    const database = openCacheDatabase(":memory:");

    try {
      const result = await refreshLiveCatalog({
        database,
        discovery: discovery(["subagent.jsonl"]),
        sessionIndexEntries: [],
        globalState,
        stateSnapshot: emptyStateSnapshot,
      });

      expect(result.rows).toEqual([
        expect.objectContaining({
          kind: "root",
          parentThreadId: null,
          agentDepth: null,
          summary: expect.objectContaining({ parentThreadId: null }),
        }),
      ]);
      expect(
        listCatalogSessions(database, { scope: "active", parentThreadId: "__root__" }).items,
      ).toHaveLength(1);
      expect(result.projects).toEqual([
        expect.objectContaining({ activeCount: 1, archivedCount: 0 }),
      ]);
    } finally {
      database.close();
    }
  });

  it("keeps oversized auto-review sessions auxiliary using bounded metadata hints", async () => {
    const database = openCacheDatabase(":memory:");

    try {
      const result = await refreshLiveCatalog({
        database,
        discovery: discovery(["guardian.jsonl"]),
        sessionIndexEntries: [],
        globalState,
        stateSnapshot: {
          ...emptyStateSnapshot,
          threads: [
            {
              id: "guardian",
              rolloutPath: join(fixtureRoot, "guardian.jsonl"),
              createdAt: 1,
              updatedAt: 2,
              source: JSON.stringify({ subagent: { other: "guardian" } }),
              modelProvider: "openai",
              cwd: "C:\\Work\\viewer",
              title: "Approval review",
              tokensUsed: 0,
              archived: false,
              archivedAt: null,
              gitSha: null,
              gitBranch: null,
              gitOriginUrl: null,
              firstUserMessage: "Review a tool call",
              model: "codex-auto-review",
              reasoningEffort: null,
              name: null,
              pinned: false,
              sectionId: null,
            },
          ],
        },
        readPrefix: async () => ({
          status: "missing",
          meta: null,
          parentThreadIdHint: "root",
          bytesRead: 4_096,
          observation: {
            device: 1n,
            inode: 2n,
            size: 16_384n,
            mtimeNs: 3_000_000n,
            ctimeNs: 3_000_000n,
            regular: true,
            symbolicLink: false,
          },
          diagnostics: [],
        }),
      });

      expect(result.rows).toEqual([
        expect.objectContaining({
          kind: "auxiliary",
          parentThreadId: "root",
          summary: expect.objectContaining({
            models: ["codex-auto-review"],
            parentThreadId: "root",
          }),
        }),
      ]);
      expect(
        listCatalogSessions(database, { scope: "active", parentThreadId: "__root__" }).items,
      ).toEqual([]);
      expect(result.projects).toEqual([]);
    } finally {
      database.close();
    }
  });
});
