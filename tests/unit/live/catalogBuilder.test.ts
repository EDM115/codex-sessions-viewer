import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { catalogSession, listCatalogSessions } from "../../../server/cache/catalogStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import type { SourceDiscoveryResult } from "../../../server/ingestion/discoverSources.ts";
import { readSessionMetaPrefix } from "../../../server/ingestion/sessionMetaPrefix.ts";
import { refreshLiveCatalog } from "../../../server/live/catalogBuilder.ts";
import type { GlobalStateMetadata } from "../../../server/metadata/globalState.ts";
import type { StateMetadataSnapshot } from "../../../server/metadata/stateSnapshot.ts";

const fixtureRoot = join(process.cwd(), "tests", "fixtures", "catalog");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

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
  it("skips unchanged prefixes and catalog writes after the baseline refresh", async () => {
    const database = openCacheDatabase(":memory:");
    const readPrefix = vi.fn(readSessionMetaPrefix);

    try {
      const first = await refreshLiveCatalog({
        database,
        discovery: discovery(["root.jsonl", "subagent.jsonl"]),
        sessionIndexEntries: [],
        globalState,
        stateSnapshot: emptyStateSnapshot,
        readPrefix,
      });
      expect(first.changedIds).toEqual(["child", "root"]);
      const changesBefore = database.prepare("SELECT total_changes() AS changes").get()?.[
        "changes"
      ];

      const unchanged = await refreshLiveCatalog({
        database,
        discovery: discovery(["root.jsonl", "subagent.jsonl"]),
        sessionIndexEntries: [],
        globalState,
        stateSnapshot: emptyStateSnapshot,
        readPrefix,
      });

      expect(unchanged.changedIds).toEqual([]);
      expect(unchanged.removedIds).toEqual([]);
      expect(unchanged.bytesRead).toBe(0);
      expect(readPrefix).toHaveBeenCalledTimes(2);
      expect(database.prepare("SELECT total_changes() AS changes").get()?.["changes"]).toBe(
        changesBefore,
      );
    } finally {
      database.close();
    }
  });

  it("reports only same-revision metadata and topology changes", async () => {
    const database = openCacheDatabase(":memory:");
    const selectedDiscovery = discovery(["root.jsonl", "missing-meta.jsonl"]);

    try {
      await refreshLiveCatalog({
        database,
        discovery: selectedDiscovery,
        sessionIndexEntries: [],
        globalState,
        stateSnapshot: emptyStateSnapshot,
      });
      const metadataOnly = await refreshLiveCatalog({
        database,
        discovery: selectedDiscovery,
        sessionIndexEntries: [
          { id: "root", threadName: "Renamed root", updatedAt: "2026-08-18T12:00:00.000Z" },
        ],
        globalState,
        stateSnapshot: emptyStateSnapshot,
      });
      expect(metadataOnly.changedIds).toEqual(["root"]);
      expect(catalogSession(database, "root")?.summary.title).toBe("Renamed root");

      const topology = await refreshLiveCatalog({
        database,
        discovery: selectedDiscovery,
        sessionIndexEntries: [
          { id: "root", threadName: "Renamed root", updatedAt: "2026-08-18T12:00:00.000Z" },
        ],
        globalState,
        stateSnapshot: {
          ...emptyStateSnapshot,
          spawnEdges: [
            { parentThreadId: "root", childThreadId: "missing-meta", status: "running" },
          ],
        },
      });
      expect(topology.changedIds).toEqual(["missing-meta", "root"]);
      expect(catalogSession(database, "root")?.summary.childThreadIds).toEqual(["missing-meta"]);
      expect(catalogSession(database, "missing-meta")).toMatchObject({
        kind: "subagent",
        parentThreadId: "root",
      });
    } finally {
      database.close();
    }
  });

  it("rereads and demotes only a source whose observed revision changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-catalog-change-"));
    temporaryRoots.push(root);
    const path = join(root, "root.jsonl");
    await writeFile(path, await readFile(join(fixtureRoot, "root.jsonl")), "utf8");
    const database = openCacheDatabase(":memory:");
    const readPrefix = vi.fn(readSessionMetaPrefix);
    const selectedDiscovery: SourceDiscoveryResult = {
      ...discovery([]),
      rollouts: [{ path, scope: "active" }],
    };

    try {
      await refreshLiveCatalog({
        database,
        discovery: selectedDiscovery,
        sessionIndexEntries: [],
        globalState,
        stateSnapshot: emptyStateSnapshot,
        readPrefix,
      });
      database
        .prepare("UPDATE session_catalog SET materialization_state = 'ready' WHERE id = 'root'")
        .run();
      await appendFile(path, "\n", "utf8");

      const changed = await refreshLiveCatalog({
        database,
        discovery: selectedDiscovery,
        sessionIndexEntries: [],
        globalState,
        stateSnapshot: emptyStateSnapshot,
        readPrefix,
      });

      expect(changed.changedIds).toEqual(["root"]);
      expect(readPrefix).toHaveBeenCalledTimes(2);
      expect(catalogSession(database, "root")?.materialization).toBe("cold");
    } finally {
      database.close();
    }
  });

  it("selects the newest stable complete duplicate across active and archived sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-viewer-catalog-duplicates-"));
    temporaryRoots.push(root);
    const active = join(root, "sessions", "active.jsonl");
    const archived = join(root, "archived_sessions", "archived.jsonl");
    const incomplete = join(root, "sessions", "incomplete.jsonl");
    await Promise.all([
      mkdir(join(root, "sessions"), { recursive: true }),
      mkdir(join(root, "archived_sessions"), { recursive: true }),
    ]);
    const fixture = await readFile(
      join(process.cwd(), "tests", "fixtures", "rollouts", "modern.jsonl"),
      "utf8",
    );
    await Promise.all([
      writeFile(active, fixture.replace("Build the parser", "Active older"), "utf8"),
      writeFile(archived, fixture.replace("Build the parser", "Archived winner"), "utf8"),
      writeFile(incomplete, `${fixture.trimEnd()}\n{"type":`, "utf8"),
    ]);
    const now = Date.now() / 1_000;
    await Promise.all([
      utimes(active, now - 30, now - 30),
      utimes(archived, now - 20, now - 20),
      utimes(incomplete, now - 10, now - 10),
    ]);
    const database = openCacheDatabase(":memory:");

    try {
      const result = await refreshLiveCatalog({
        database,
        discovery: {
          rollouts: [
            { path: active, scope: "active" },
            { path: archived, scope: "archived" },
            { path: incomplete, scope: "active" },
          ],
          metadata: {
            sessionIndex: null,
            globalState: null,
            stateDatabase: null,
            stateWal: null,
          },
          diagnostics: [],
        },
        sessionIndexEntries: [],
        globalState: { projects: [], pinnedThreadIds: [] },
        stateSnapshot: emptyStateSnapshot,
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.summary).toMatchObject({
        id: "11111111-1111-4111-8111-111111111111",
        sourcePath: archived,
        scope: "archived",
      });
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "source.duplicate_session",
          path: archived,
          details: { candidateCount: 3, selectedPath: archived },
        }),
      ]);

      const withoutLosingIncomplete = await refreshLiveCatalog({
        database,
        discovery: {
          rollouts: [
            { path: active, scope: "active" },
            { path: archived, scope: "archived" },
          ],
          metadata: {
            sessionIndex: null,
            globalState: null,
            stateDatabase: null,
            stateWal: null,
          },
          diagnostics: [],
        },
        sessionIndexEntries: [],
        globalState: { projects: [], pinnedThreadIds: [] },
        stateSnapshot: emptyStateSnapshot,
      });
      expect(withoutLosingIncomplete.rows[0]?.summary.sourcePath).toBe(archived);
      expect(withoutLosingIncomplete.removedIds).toEqual([]);

      const promoted = await refreshLiveCatalog({
        database,
        discovery: {
          rollouts: [{ path: active, scope: "active" }],
          metadata: {
            sessionIndex: null,
            globalState: null,
            stateDatabase: null,
            stateWal: null,
          },
          diagnostics: [],
        },
        sessionIndexEntries: [],
        globalState: { projects: [], pinnedThreadIds: [] },
        stateSnapshot: emptyStateSnapshot,
      });
      expect(promoted.rows[0]?.summary).toMatchObject({ sourcePath: active, scope: "active" });
      expect(promoted.removedIds).toEqual([]);
    } finally {
      database.close();
    }
  });

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
