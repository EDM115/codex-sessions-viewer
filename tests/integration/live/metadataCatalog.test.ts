import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { catalogSession, readCatalogLibrary } from "#server/cache/catalogStore.ts";
import { openCacheDatabase } from "#server/cache/database.ts";
import { readStableJsonl } from "#server/ingestion/jsonlStream.ts";
import { LiveViewerRuntime } from "#server/live/viewerRuntime.ts";
import { readCatalogMetadata } from "#server/metadata/catalogMetadata.ts";
import type { ViewerInvalidation } from "#shared/types/repository.ts";

import { createStateDatabase } from "../source-boundary/fixtures.ts";

const sourceIo = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return Object.fromEntries(
    Object.entries(fs).map(([name, value]) => [
      name,
      ["readdir", "opendir", "stat", "lstat", "open", "readFile"].includes(name) &&
      typeof value === "function"
        ? (...args: unknown[]) => {
            const path = String(args[0]);
            if (/[\\/](?:sessions|archived_sessions)(?:[\\/]|$)/u.test(path)) {
              sourceIo.paths.push(`${name}:${path}`);
            }
            return Reflect.apply(value, fs, args);
          }
        : value,
    ]),
  );
});

function config(root: string, home: string) {
  const cacheDir = join(root, "cache");
  return {
    settings: { codexHome: home, port: 3000, fetchFavicons: false },
    paths: {
      cacheDir,
      configDir: join(root, "config"),
      configFile: join(root, "config", "config.json"),
      generatedDir: join(cacheDir, "generated"),
      cacheDatabase: join(cacheDir, "viewer.sqlite"),
    },
    codexHomeSource: "cli" as const,
    onboardingRequired: false,
    diagnostics: [],
  };
}

function nextLibrary(
  runtime: LiveViewerRuntime,
  predicate: (event: ViewerInvalidation) => boolean = () => true,
) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Expected metadata watcher publication"));
    }, 5000);
    const unsubscribe = runtime.bus.subscribe((event) => {
      if (event.type === "library.updated" && predicate(event)) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
}

describe("metadata-only live catalog", () => {
  it("reconciles selected validated raw evidence and warm reuse without reading raw data during metadata refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-selected-structure-"));
    const home = join(root, "home");
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(
      join(home, "sessions", "rollout-thread-1.jsonl"),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:00Z",
        type: "session_meta",
        payload: {
          id: "thread-1",
          source: { subagent: "review" },
          thread_source: "guardian_review",
          timestamp: "2026-01-01T00:00:00Z",
        },
      }) + "\n",
    );
    const statePath = join(home, "state_5.sqlite");
    const native = createStateDatabase(statePath);
    native.exec(
      "ALTER TABLE threads ADD COLUMN thread_source TEXT; UPDATE threads SET thread_source='user'",
    );
    native.close();
    const readJsonl = vi.fn<typeof readStableJsonl>(readStableJsonl);
    const runtime = await LiveViewerRuntime.start(config(root, home), {
      readJsonl,
      debounceMs: 0,
      reconciliationIntervalMs: 60_000,
    });
    try {
      expect((await runtime.repository.listSessions({ scope: "active" })).total).toBe(1);
      expect(readJsonl).not.toHaveBeenCalled();
      await runtime.repository.getSession("thread-1");
      let evidence = catalogSession(runtime.database, "thread-1")?.structuralEvidence;
      expect(evidence?.classification?.visibility).toBe("unresolved");
      expect(evidence?.classification?.declarations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ origin: "native", threadSource: "user" }),
          expect.objectContaining({ origin: "raw", internal: true }),
        ]),
      );
      expect(evidence?.freshness).toBe("verified");
      expect(evidence?.validatedSha256).toBe(
        runtime.database
          .prepare("SELECT sha256 FROM source_files WHERE session_id = 'thread-1'")
          .get()?.["sha256"],
      );
      expect(evidence?.meta?.source).toEqual({ subagent: "review" });
      expect(readJsonl).toHaveBeenCalledOnce();
      sourceIo.paths = [];
      const changed = nextLibrary(runtime, (event) => event.ids.includes("thread-1"));
      const writer = new DatabaseSync(statePath);
      writer.exec("UPDATE threads SET name='Current metadata rename'");
      writer.close();
      await changed;
      evidence = catalogSession(runtime.database, "thread-1")?.structuralEvidence;
      expect(evidence?.classification?.visibility).toBe("user-root");
      expect(evidence?.freshness).toBe("retained-unvalidated");
      expect(sourceIo.paths).toEqual([]);
      expect(readJsonl).toHaveBeenCalledOnce();
      await runtime.repository.getSession("thread-1");
      expect(
        catalogSession(runtime.database, "thread-1")?.structuralEvidence?.classification
          ?.visibility,
      ).toBe("unresolved");
      expect(catalogSession(runtime.database, "thread-1")?.structuralEvidence?.freshness).toBe(
        "verified",
      );
      expect(readJsonl).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps retained native helper roles when a partial metadata read rejects their row", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-partial-native-role-"));
    const home = join(root, "home");
    await mkdir(home);
    const statePath = join(home, "state_5.sqlite");
    const state = createStateDatabase(statePath);
    state.exec(
      "ALTER TABLE threads ADD COLUMN thread_source TEXT; UPDATE threads SET thread_source='guardian_review'",
    );
    state.close();
    const runtime = await LiveViewerRuntime.start(config(root, home), {
      debounceMs: 0,
      reconciliationIntervalMs: 60_000,
    });
    try {
      expect((await runtime.repository.listSessions({ scope: "active" })).items).toEqual([]);
      const changed = nextLibrary(runtime, (event) => event.ids.includes("thread-1"));
      const writer = new DatabaseSync(statePath);
      writer.exec("UPDATE threads SET tokens_used='invalid-required-field'");
      writer.close();
      await changed;
      expect(
        catalogSession(runtime.database, "thread-1")?.structuralEvidence?.classification
          ?.visibility,
      ).toBe("internal");
      expect(catalogSession(runtime.database, "thread-1")?.structuralEvidence?.freshness).toBe(
        "retained-unvalidated",
      );
      expect((await runtime.repository.listSessions({ scope: "active" })).items).toEqual([]);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates DB-only identities across homes even when both catalogs have no resolved source paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-metadata-home-isolation-"));
    const homes = [join(root, "first-home"), join(root, "second-home")] as const;
    await Promise.all(
      homes.map(async (home, index) => {
        await mkdir(home);
        const state = createStateDatabase(join(home, "state_5.sqlite"));
        state.prepare("UPDATE threads SET id = ?, rollout_path = ''").run(`home-${index}`);
        state.close();
      }),
    );
    const firstConfig = config(root, homes[0]);
    const first = await LiveViewerRuntime.start(firstConfig);
    expect(catalogSession(first.database, "home-0")?.summary.sourcePath).toBeNull();
    await first.close();
    const second = await LiveViewerRuntime.start(config(root, homes[1]));
    try {
      expect(
        (await second.repository.listSessions({ scope: "active" })).items.map((entry) => entry.id),
      ).toEqual(["home-1"]);
      const retained = openCacheDatabase(firstConfig.paths.cacheDatabase);
      try {
        expect(catalogSession(retained, "home-0")).not.toBeNull();
        expect(catalogSession(retained, "home-1")).toBeNull();
      } finally {
        retained.close();
      }
    } finally {
      await second.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes DB-only entries through the real runtime and keeps browsing free of rollout I/O", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-metadata-runtime-"));
    const home = join(root, "home");
    const cacheDir = join(root, "cache");
    await mkdir(join(home, "sessions"), { recursive: true });
    const state = createStateDatabase(join(home, "state_5.sqlite"));
    state.close();
    sourceIo.paths = [];
    const runtime = await LiveViewerRuntime.start(
      {
        settings: { codexHome: home, port: 3000, fetchFavicons: false },
        paths: {
          cacheDir,
          configDir: join(root, "config"),
          configFile: join(root, "config", "config.json"),
          generatedDir: join(cacheDir, "generated"),
          cacheDatabase: join(cacheDir, "viewer.sqlite"),
        },
        codexHomeSource: "cli",
        onboardingRequired: false,
        diagnostics: [],
      },
      { reconciliationIntervalMs: 60_000 },
    );
    try {
      expect(sourceIo.paths).toEqual([]);
      const page = await runtime.repository.listSessions({ scope: "active" });
      expect(page.items).toEqual([
        expect.objectContaining({ id: "thread-1", title: "Chosen name", scope: "active" }),
      ]);
      expect(page.items[0]).not.toHaveProperty("summary");
      expect(page.items[0]).not.toHaveProperty("materialization");
      await Promise.all(
        (await runtime.repository.listProjects()).map((group) =>
          runtime.repository.listSessions({ scope: "active", groupId: group.groupId }),
        ),
      );
      expect(runtime.database.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({
        count: 0,
      });
      expect(sourceIo.paths).toEqual([]);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies valid sibling updates without deleting skipped rows and only removes native-owned identities after a complete authoritative observation", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewer-metadata-authority-"));
    const home = join(root, "home");
    await mkdir(home);
    const statePath = join(home, "state_5.sqlite");
    const initial = createStateDatabase(statePath);
    initial.exec(
      "INSERT INTO threads SELECT 'sibling', rollout_path || '-sibling', created_at, updated_at, source, model_provider, cwd, title, tokens_used, archived, archived_at, git_sha, git_branch, git_origin_url, first_user_message, model, reasoning_effort, 'Sibling', is_pinned, thread_section_id, secret_blob FROM threads",
    );
    initial.exec(
      "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT); INSERT INTO projects VALUES ('retained-project', 'Retained project'); ALTER TABLE threads ADD COLUMN project_id TEXT; UPDATE threads SET project_id='retained-project' WHERE id='thread-1'",
    );
    initial.close();
    await writeFile(
      join(home, "session_index.jsonl"),
      '{"id":"index-only","thread_name":"Index identity","updated_at":"2026-01-01T00:00:00Z"}\n{"id":"thread-1","thread_name":"Old native index","updated_at":"2026-01-01T00:00:00Z"}\n',
    );
    const runtime = await LiveViewerRuntime.start(config(root, home), {
      debounceMs: 0,
      reconciliationIntervalMs: 60_000,
    });
    try {
      let changed = nextLibrary(runtime, (event) => event.ids.includes("sibling"));
      const writer = new DatabaseSync(statePath);
      writer.exec(
        "UPDATE threads SET tokens_used='bad' WHERE id='thread-1'; UPDATE threads SET name='Valid sibling update' WHERE id='sibling'",
      );
      await changed;
      expect(
        (await runtime.repository.listSessions({ scope: "active" })).items
          .map((entry) => entry.id)
          .toSorted(),
      ).toEqual(["index-only", "sibling", "thread-1"]);
      expect(
        (await runtime.repository.listSessions({ scope: "active" })).items.find(
          (entry) => entry.id === "sibling",
        )?.title,
      ).toBe("Valid sibling update");
      expect(
        (await runtime.repository.listSessions({ scope: "active" })).items.find(
          (entry) => entry.id === "thread-1",
        )?.projectId,
      ).toBe("retained-project");
      expect(
        readCatalogLibrary(runtime.database)?.threads.find((entry) => entry.id === "thread-1"),
      ).toMatchObject({
        sectionId: "section-1",
        membershipFreshness: "retained-unvalidated",
        sectionFreshness: "retained-unvalidated",
      });
      changed = nextLibrary(
        runtime,
        (event) => event.ids.includes("thread-1") || event.groupsChanged === true,
      );
      writer.exec(
        "UPDATE threads SET tokens_used=0, project_id=NULL, thread_section_id=NULL WHERE id='thread-1'",
      );
      await changed;
      expect(
        (await runtime.repository.listSessions({ scope: "active" })).items.find(
          (entry) => entry.id === "thread-1",
        )?.projectId,
      ).toBeNull();
      expect(
        readCatalogLibrary(runtime.database)?.threads.find((entry) => entry.id === "thread-1"),
      ).toMatchObject({ sectionId: null, membershipFreshness: "fresh", sectionFreshness: "fresh" });
      changed = nextLibrary(runtime, (event) => event.ids.includes("thread-1"));
      writer.exec("DELETE FROM threads");
      await changed;
      expect(
        (await runtime.repository.listSessions({ scope: "active" })).items.map((entry) => entry.id),
      ).toEqual(["index-only"]);
      writer.close();
      const metadata = await readCatalogMetadata(home, join(root, "independent-observation"));
      expect(metadata).toMatchObject({
        threads: [],
        threadsComplete: true,
        freshness: { state: "fresh" },
      });
      changed = nextLibrary(runtime, (event) => event.groupsChanged === true);
      await writeFile(
        join(home, ".codex-global-state.json"),
        '{"pinned-thread-ids":["index-only"]}',
      );
      await changed;
      expect(
        (await runtime.repository.listSessions({ scope: "active" })).items.map((entry) => entry.id),
      ).toEqual(["index-only"]);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([true, false])(
    "retains unvalidated raw provenance while honoring only affirmative current native role evidence (explicit user=%s)",
    async (explicitUser) => {
      const root = await mkdtemp(join(tmpdir(), "viewer-catalog-freshness-"));
      const home = join(root, "home");
      await mkdir(join(home, "sessions"), { recursive: true });
      await writeFile(
        join(home, "sessions", "rollout-thread-1.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "thread-1", timestamp: "2026-01-01T00:00:00Z", source: { subagent: "review" } } })}\n`,
      );
      const first = await LiveViewerRuntime.start(config(root, home), {
        reconciliationIntervalMs: 60_000,
      });
      await first.whenRecoverySettled();
      expect(
        catalogSession(first.database, "thread-1")?.structuralEvidence?.classification?.visibility,
      ).toBe("internal");
      await first.close();
      const state = createStateDatabase(join(home, "state_5.sqlite"));
      if (explicitUser) {
        state.exec(
          "ALTER TABLE threads ADD COLUMN thread_source TEXT; UPDATE threads SET thread_source='user'",
        );
      }
      state.close();
      sourceIo.paths = [];
      const current = await LiveViewerRuntime.start(config(root, home), {
        reconciliationIntervalMs: 60_000,
      });
      try {
        const evidence = catalogSession(current.database, "thread-1")?.structuralEvidence;
        expect(evidence?.meta?.source).toEqual({ subagent: "review" });
        expect(evidence?.freshness).toBe("retained-unvalidated");
        expect(evidence?.classification?.visibility).toBe(explicitUser ? "user-root" : "internal");
        expect(evidence?.classification?.reasons).toContain("retained-raw-structure-unvalidated");
        expect(sourceIo.paths).toEqual([]);
        expect((await current.repository.listSessions({ scope: "active" })).total).toBe(
          explicitUser ? 1 : 0,
        );
      } finally {
        await current.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
