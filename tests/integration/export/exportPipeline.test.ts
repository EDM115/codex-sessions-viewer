import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { StaticConversationRepository } from "../../../app/repositories/static.ts";
import { getCachedSession } from "../../../server/cache/conversationStore.ts";
import { openCacheDatabase } from "../../../server/cache/database.ts";
import { SessionCacheUpdater } from "../../../server/cache/sourceManifest.ts";
import type { ViewerPaths } from "../../../server/core/paths.ts";
import { collectDoctorReport } from "../../../server/export/doctorReport.ts";
import { runStaticExport } from "../../../server/export/exportPipeline.ts";
import { CliExportProgress } from "../../../server/export/exportProgress.ts";
import { discoverSources } from "../../../server/ingestion/discoverSources.ts";
import { readStableJsonl } from "../../../server/ingestion/jsonlStream.ts";
import { selectSessionSources } from "../../../server/ingestion/selectSessionSources.ts";
import { refreshLiveCatalog } from "../../../server/live/catalogBuilder.ts";
import { LiveViewerRuntime } from "../../../server/live/viewerRuntime.ts";
import {
  hydrateStaticInspectorRecords,
  staticInspectorChunkSchema,
} from "../../../shared/types/staticPayloads.ts";
import { cutoffReviewRecords, parentReviewRecords } from "../../fixtures/history/parentReviews.ts";
import { createStateDatabase } from "../source-boundary/fixtures.ts";

const temporaryDirectories: string[] = [];
const routeManifestSchema = z.object({ routes: z.array(z.string()) });
const sessionIndexSchema = z.object({ sessions: z.array(z.object({ id: z.string() })) });
const exportManifestSchema = z.object({ version: z.literal(1), pagefind: z.boolean() });

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-viewer-pipeline-"));
  temporaryDirectories.push(root);
  return root;
}

function viewerPaths(root: string): ViewerPaths {
  const configDir = join(root, "viewer-config");
  const cacheDir = join(root, "viewer-cache");
  return {
    configDir,
    cacheDir,
    generatedDir: join(cacheDir, "generated"),
    configFile: join(configDir, "config.json"),
    cacheDatabase: join(cacheDir, "viewer.sqlite"),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("static export pipeline", () => {
  it("overlays current metadata titles and millisecond timestamps on warm selected and exported summaries without reparsing", async () => {
    const root = await temporaryRoot();
    const codexHome = join(root, "home");
    const paths = viewerPaths(root);
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    await writeFile(
      join(codexHome, "sessions", "rollout-thread-1.jsonl"),
      [
        {
          timestamp: "2026-01-01T00:00:00Z",
          type: "session_meta",
          payload: {
            id: "thread-1",
            source: "cli",
            thread_source: "user",
            timestamp: "2026-01-01T00:00:00Z",
          },
        },
        {
          timestamp: "2026-01-01T00:00:01Z",
          type: "event_msg",
          payload: { type: "user_message", message: "A prompt does not replace the human name" },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const statePath = join(codexHome, "state_5.sqlite");
    const state = createStateDatabase(statePath);
    state.exec(
      "ALTER TABLE threads ADD COLUMN created_at_ms INTEGER; ALTER TABLE threads ADD COLUMN updated_at_ms INTEGER; ALTER TABLE threads ADD COLUMN history_mode TEXT; ALTER TABLE threads ADD COLUMN thread_source TEXT; UPDATE threads SET created_at_ms=1001, updated_at_ms=2001, history_mode='paginated', thread_source='user'",
    );
    state
      .prepare("UPDATE threads SET rollout_path = ?")
      .run(join(codexHome, "sessions", "rollout-thread-1.jsonl"));
    state.close();
    await writeFile(
      join(codexHome, "session_index.jsonl"),
      '{"id":"thread-1","thread_name":"Incompatible legacy name","updated_at":"2026-01-01T00:00:00Z"}\n',
    );
    const readJsonl = vi.fn<typeof readStableJsonl>(readStableJsonl);
    const runtime = await LiveViewerRuntime.start(
      {
        settings: { codexHome, port: 3000, fetchFavicons: false },
        paths,
        codexHomeSource: "cli",
        onboardingRequired: false,
        diagnostics: [],
      },
      { readJsonl, debounceMs: 0, reconciliationIntervalMs: 60_000 },
    );
    try {
      expect((await runtime.repository.listSessions({ scope: "active" })).items[0]?.title).toBe(
        "Chosen name",
      );
      expect(readJsonl).not.toHaveBeenCalled();
      await expect(runtime.repository.getSession("thread-1")).resolves.toMatchObject({
        title: "Chosen name",
        createdAt: "1970-01-01T00:00:01.001Z",
        updatedAt: "1970-01-01T00:00:02.001Z",
      });
      expect(readJsonl).toHaveBeenCalledOnce();
      const changed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error("Expected metadata rename publication"));
        }, 5000);
        const unsubscribe = runtime.bus.subscribe((event) => {
          if (event.type === "library.updated" && event.ids.includes("thread-1")) {
            clearTimeout(timeout);
            unsubscribe();
            resolve();
          }
        });
      });
      const writer = new DatabaseSync(statePath);
      writer.exec("UPDATE threads SET name='Renamed current title', updated_at_ms=9001");
      writer.close();
      await changed;
      expect((await runtime.repository.listSessions({ scope: "active" })).items[0]?.title).toBe(
        "Renamed current title",
      );
      await expect(runtime.repository.getSession("thread-1")).resolves.toMatchObject({
        title: "Renamed current title",
        createdAt: "1970-01-01T00:00:01.001Z",
        updatedAt: "1970-01-01T00:00:09.001Z",
      });
      expect(readJsonl).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
    }
    const outputRoot = join(root, "output");
    const result = await runStaticExport({
      cwd: root,
      codexHome,
      generatedRoot: join(root, "generated"),
      outputRoot,
      paths,
      offline: true,
      index: false,
      async generate({ outputRoot: destination }) {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "index.html"), "metadata fixture");
      },
    });
    expect(result).toMatchObject({ transformed: 0, reused: 1 });
    const exported = JSON.parse(
      await readFile(join(outputRoot, "payloads", "sessions", "thread-1", "summary.json"), "utf8"),
    );
    expect(exported.summary).toMatchObject({
      title: "Renamed current title",
      createdAt: "1970-01-01T00:00:01.001Z",
      updatedAt: "1970-01-01T00:00:09.001Z",
    });
  });

  it("publishes only structurally visible chats and retains unmatched helper reviews beside their parent", async () => {
    const root = await temporaryRoot();
    const codexHome = join(root, "codex-home");
    const sessions = join(codexHome, "sessions");
    await mkdir(sessions, { recursive: true });
    const userId = "11111111-1111-4111-8111-111111111111";
    const helperId = "22222222-2222-4222-8222-222222222222";
    const inputs = [
      { id: userId, thread_source: "user" },
      { id: helperId, thread_source: "guardian_review", parent_thread_id: userId },
      { id: "33333333-3333-4333-8333-333333333333", thread_source: "security_scan" },
      { id: "44444444-4444-4444-8444-444444444444", thread_source: "custom-role" },
    ];
    await Promise.all(
      inputs.map((meta) =>
        writeFile(
          join(sessions, `${meta.id}.jsonl`),
          [
            {
              type: "session_meta",
              payload: { ...meta, source: "cli", name: null, has_user_event: 0 },
            },
            {
              type: "event_msg",
              payload: {
                type: "user_message",
                message:
                  meta.id === helperId
                    ? 'Planned action JSON: {"cmd":"same"}'
                    : "Visible user prompt",
              },
            },
            {
              type: "event_msg",
              payload: {
                type: "agent_message",
                message:
                  meta.id === helperId
                    ? '{"outcome":"deny","risk_level":"low","rationale":"Unmatched review"}'
                    : "Answer",
              },
            },
          ]
            .map((record) => JSON.stringify(record))
            .join("\n") + "\n",
        ),
      ),
    );
    const outputRoot = join(root, "output");
    await runStaticExport({
      cwd: root,
      codexHome,
      generatedRoot: join(root, "generated"),
      outputRoot,
      paths: viewerPaths(root),
      offline: true,
      index: false,
      async generate({ outputRoot: destination }) {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "index.html"), "classification fixture");
      },
    });
    const index = sessionIndexSchema.parse(
      JSON.parse(await readFile(join(outputRoot, "payloads/sessions/index.json"), "utf8")),
    );
    expect(index.sessions.map((session) => session.id)).toEqual([userId]);
    expect(await readdir(join(outputRoot, "downloads/active"))).toEqual([`${userId}.md`]);
    expect(
      JSON.parse(
        await readFile(join(outputRoot, `payloads/sessions/${userId}/approvals.json`), "utf8"),
      ),
    ).toMatchObject({
      sessionId: userId,
      matched: [],
      unattached: [
        {
          reason: "missing-tool-or-turn",
          review: { guardianSessionId: helperId, outcome: "deny" },
        },
      ],
    });
    const database = openCacheDatabase(viewerPaths(root).cacheDatabase);
    try {
      expect(database.prepare("SELECT count(*) AS count FROM sessions").get()?.["count"]).toBe(4);
    } finally {
      database.close();
    }
  });
  it("keeps a parent and its inheriting child as distinct selected, catalog and export identities", async () => {
    const directory = join(process.cwd(), ".tmp", "task2-tests");
    await mkdir(directory, { recursive: true });
    const root = await mkdtemp(join(directory, "cross-thread-"));
    temporaryDirectories.push(root);
    const codexHome = join(root, "codex-home");
    const sessions = join(codexHome, "sessions");
    await mkdir(sessions, { recursive: true });
    const parentId = "11111111-1111-4111-8111-111111111111";
    const childId = "22222222-2222-4222-8222-222222222222";
    const parentPath = join(sessions, `rollout-2026-10-27T10-00-00-${parentId}.jsonl`);
    const childPath = join(sessions, `rollout-2026-10-27T10-00-01-${childId}.jsonl`);
    const parent = [
      { type: "session_meta", payload: { id: parentId, session_id: "parent-root" } },
      { type: "event_msg", payload: { type: "user_message", message: "parent prompt" } },
    ]
      .map((value) => JSON.stringify(value) + "\n")
      .join("");
    const child = [
      {
        type: "session_meta",
        payload: {
          id: childId,
          session_id: "child-root",
          parent_thread_id: parentId,
          history_base: {
            thread_id: parentId,
            end_ordinal_exclusive: 2,
            end_byte_offset: Buffer.byteLength(parent),
          },
          subagent_history_start_ordinal: 3,
        },
      },
      { type: "event_msg", payload: { type: "user_message", message: "child prompt" } },
    ]
      .map((value) => JSON.stringify(value) + "\n")
      .join("");
    await writeFile(parentPath, parent);
    await writeFile(childPath, child);
    const discovery = await discoverSources(codexHome);
    const selected = await selectSessionSources(discovery.rollouts);
    expect(
      selected.selected
        .map((source) => source.prefix.meta?.id)
        .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual([parentId, childId]);
    expect(
      selected.historyGraph
        .map((source) => source.rootSessionId)
        .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
    ).toEqual(["child-root", "parent-root"]);
    const database = openCacheDatabase(":memory:");
    try {
      const catalog = await refreshLiveCatalog({
        database,
        discovery,
        sessionIndexEntries: [],
        globalState: { projects: [], pinnedThreadIds: [] },
        stateSnapshot: null,
      });
      expect(catalog.rows.map((row) => row.summary.id).toSorted()).toEqual([parentId, childId]);
      expect(catalog.rows.find((row) => row.summary.id === childId)?.parentThreadId).toBe(parentId);
    } finally {
      database.close();
    }
    const outputRoot = join(root, ".output", "public");
    const exported = await runStaticExport({
      cwd: root,
      codexHome,
      generatedRoot: join(root, ".generated"),
      outputRoot,
      paths: viewerPaths(root),
      offline: true,
      index: false,
      async generate({ outputRoot: generatedOutput }) {
        await mkdir(generatedOutput, { recursive: true });
        await writeFile(join(generatedOutput, "index.html"), "lineage identities");
      },
    });
    expect(exported).toMatchObject({ discovered: 2, transformed: 2, failed: 0 });
    const index = sessionIndexSchema.parse(
      JSON.parse(await readFile(join(outputRoot, "payloads", "sessions", "index.json"), "utf8")),
    );
    expect(index.sessions.map((session) => session.id).toSorted()).toEqual([parentId, childId]);
  });
  it("selects the same newest stable complete duplicate as the live catalog", async () => {
    const root = await temporaryRoot();
    const codexHome = join(root, "codex-home");
    const active = join(codexHome, "sessions", "active.jsonl");
    const archived = join(codexHome, "archived_sessions", "archived.jsonl");
    const generatedRoot = join(root, ".generated");
    const outputRoot = join(root, ".output", "public");
    const paths = viewerPaths(root);
    await Promise.all([
      mkdir(join(codexHome, "sessions"), { recursive: true }),
      mkdir(join(codexHome, "archived_sessions"), { recursive: true }),
    ]);
    const fixture = await readFile(
      new URL("../../fixtures/rollouts/modern.jsonl", import.meta.url),
      "utf8",
    );
    await Promise.all([
      writeFile(active, fixture.replace("Build the parser", "Active older"), "utf8"),
      writeFile(archived, fixture.replace("Build the parser", "Archived winner"), "utf8"),
    ]);
    const now = Date.now() / 1_000;
    await Promise.all([utimes(active, now - 20, now - 20), utimes(archived, now - 10, now - 10)]);
    const discovery = await discoverSources(codexHome);
    const liveDatabase = openCacheDatabase(":memory:");
    const live = await refreshLiveCatalog({
      database: liveDatabase,
      discovery,
      sessionIndexEntries: [],
      globalState: { projects: [], pinnedThreadIds: [] },
      stateSnapshot: { threads: [], sections: [], spawnEdges: [] },
    });
    liveDatabase.close();

    const exported = await runStaticExport({
      cwd: root,
      codexHome,
      generatedRoot,
      outputRoot,
      paths,
      offline: true,
      index: false,
      async generate({ outputRoot: generatedOutput }) {
        await mkdir(generatedOutput, { recursive: true });
        await writeFile(join(generatedOutput, "index.html"), "duplicate parity", "utf8");
      },
    });
    const staticDatabase = openCacheDatabase(paths.cacheDatabase);
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const cached = getCachedSession(staticDatabase, sessionId);
    staticDatabase.close();

    expect(live.rows).toEqual([
      expect.objectContaining({
        summary: expect.objectContaining({ sourcePath: archived, scope: "archived" }),
      }),
    ]);
    expect(exported).toMatchObject({
      discovered: 1,
      transformed: 1,
      failed: 0,
      diagnosticCounts: { "source.duplicate_session": 1 },
    });
    expect(cached?.summary).toMatchObject({
      sourcePath: archived,
      scope: "archived",
      preview: "Archived winner",
    });
    expect(
      await readFile(join(outputRoot, "downloads", "archived", `${sessionId}.md`), "utf8"),
    ).toContain("Archived winner");
  }, 30_000);

  it("reads Codex sources unchanged, incrementally reuses them, and publishes the final offline data", async () => {
    const root = await temporaryRoot();
    const codexHome = join(root, "codex-home");
    const source = join(codexHome, "sessions", "2026", "modern.jsonl");
    const generatedRoot = join(root, ".generated");
    const outputRoot = join(root, ".output", "public");
    const paths = viewerPaths(root);
    await mkdir(join(codexHome, "sessions", "2026"), { recursive: true });
    await copyFile(new URL("../../fixtures/rollouts/modern.jsonl", import.meta.url), source);
    const sourceBytes = await readFile(source);
    const sourceBefore = await lstat(source, { bigint: true });
    const generateCalls: Array<{
      outputRoot: string;
      publicInputRoot: string;
      buildRoot: string;
      routeManifest: string;
    }> = [];
    const progressOutput: string[] = [];
    const progress = new CliExportProgress({
      interactive: false,
      write: (text) => progressOutput.push(text),
      heartbeatMs: 60_000,
    });
    const generate = async (input: {
      outputRoot: string;
      publicInputRoot: string;
      buildRoot: string;
      routeManifest: string;
    }): Promise<void> => {
      generateCalls.push(input);
      await expect(
        readFile(join(input.publicInputRoot, "payloads", "sessions", "index.json"), "utf8"),
      ).resolves.toContain('"version":1');
      await rm(input.outputRoot, { recursive: true, force: true });
      await mkdir(input.outputRoot, { recursive: true });
      await writeFile(join(input.outputRoot, "index.html"), "<!doctype html><title>Viewer</title>");
    };

    const first = await runStaticExport({
      cwd: root,
      codexHome,
      generatedRoot,
      outputRoot,
      paths,
      offline: true,
      generate,
      progress,
    });
    const second = await runStaticExport({
      cwd: root,
      codexHome,
      generatedRoot,
      outputRoot,
      paths,
      offline: true,
      generate,
    });
    const sourceAfter = await lstat(source, { bigint: true });
    const routeManifest = routeManifestSchema.parse(
      JSON.parse(await readFile(join(generatedRoot, "routes.json"), "utf8")),
    );
    const index = sessionIndexSchema.parse(
      JSON.parse(await readFile(join(outputRoot, "payloads", "sessions", "index.json"), "utf8")),
    );
    const firstSession = index.sessions[0];
    if (!firstSession) {
      throw new Error("Expected an exported session");
    }
    const sessionId = firstSession.id;

    expect(first).toMatchObject({
      discovered: 1,
      transformed: 1,
      reused: 0,
      failed: 0,
      pagefindRecords: 2,
    });
    expect(second).toMatchObject({
      discovered: 1,
      transformed: 0,
      reused: 1,
      failed: 0,
      pagefindRecords: 2,
    });
    expect(generateCalls).toHaveLength(2);
    for (const call of generateCalls) {
      expect(call).toMatchObject({ routeManifest: join(generatedRoot, "routes.json") });
      expect(call.outputRoot).not.toBe(outputRoot);
      expect(call.outputRoot).toContain(join(root, ".output", ".public."));
      expect(call.publicInputRoot).toContain(join(root, ".output", ".public."));
      expect(call.publicInputRoot).not.toBe(call.outputRoot);
      expect(call.buildRoot).toContain(join(root, ".output", ".public."));
    }
    expect(routeManifest.routes).toEqual([`/session/${sessionId}`]);
    expect(
      await readFile(join(outputRoot, "downloads", "active", `${sessionId}.md`), "utf8"),
    ).toContain("Build the parser");
    expect(await readFile(join(outputRoot, "pagefind", "pagefind.js"), "utf8")).toContain(
      "pagefind",
    );
    expect(await readFile(source)).toEqual(sourceBytes);
    expect(sourceAfter.size).toBe(sourceBefore.size);
    expect(sourceAfter.mtimeNs).toBe(sourceBefore.mtimeNs);
    expect(sourceAfter.ctimeNs).toBe(sourceBefore.ctimeNs);
    expect(progressOutput.join("")).toContain("Discovered 1 session");
    expect(progressOutput.join("")).toContain("Updating session cache (1/1)");
    expect(progressOutput.join("")).toContain("Preparing conversations (1/1)");
    expect(progressOutput.join("")).toContain("Generating the Nuxt static site");
    expect(progressOutput.join("")).toContain("Building the offline search index (2/2)");
    expect(progressOutput.join("")).toContain("Finalizing the offline search index");
    await expect(collectDoctorReport({ cwd: root, codexHome, paths })).resolves.toMatchObject({
      capabilities: { offline: true },
      offlineOutput: {
        structuralStatus: "present",
        integrityStatus: "not-checked",
        sessionCount: 1,
        missingFiles: [],
      },
    });
  }, 30_000);

  it("publishes a complete index-free site without creating or loading Pagefind", async () => {
    const root = await temporaryRoot();
    const codexHome = join(root, "codex-home");
    const source = join(codexHome, "sessions", "modern.jsonl");
    const generatedRoot = join(root, ".generated");
    const outputRoot = join(root, ".output", "public");
    const paths = viewerPaths(root);
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    await copyFile(new URL("../../fixtures/rollouts/modern.jsonl", import.meta.url), source);
    let buildSearchCalled = false;
    let generatedWithSearch: boolean | null = null;

    const result = await runStaticExport({
      cwd: root,
      codexHome,
      generatedRoot,
      outputRoot,
      paths,
      offline: true,
      index: false,
      async generate(input) {
        generatedWithSearch = input.searchIndex;
        await mkdir(input.outputRoot, { recursive: true });
        await writeFile(join(input.outputRoot, "index.html"), "index-free site", "utf8");
      },
      async buildSearch() {
        buildSearchCalled = true;
        throw new Error("Pagefind must not run for --no-index");
      },
    });
    const manifest = exportManifestSchema.parse(
      JSON.parse(await readFile(join(outputRoot, "payloads", "export.json"), "utf8")),
    );

    expect(result).toMatchObject({ pagefindRecords: 0, searchIndex: false });
    expect(generatedWithSearch).toBe(false);
    expect(buildSearchCalled).toBe(false);
    expect(manifest).toEqual({ version: 1, pagefind: false });
    await expect(lstat(join(outputRoot, "pagefind"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(collectDoctorReport({ cwd: root, codexHome, paths })).resolves.toMatchObject({
      capabilities: { offline: true },
      offlineOutput: {
        structuralStatus: "present",
        integrityStatus: "not-checked",
        searchIndex: "disabled",
      },
    });
  }, 30_000);

  it("reports rich-content fallbacks separately while still publishing the conversation", async () => {
    const root = await temporaryRoot();
    const codexHome = join(root, "codex-home");
    const source = join(codexHome, "sessions", "modern.jsonl");
    const generatedRoot = join(root, ".generated");
    const outputRoot = join(root, ".output", "public");
    const paths = viewerPaths(root);
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    await copyFile(new URL("../../fixtures/rollouts/modern.jsonl", import.meta.url), source);

    const result = await runStaticExport({
      cwd: root,
      codexHome,
      generatedRoot,
      outputRoot,
      paths,
      offline: true,
      index: false,
      async prepareConversation() {
        throw new TypeError("Synthetic rich-content preparation failure");
      },
      async generate({ outputRoot: generatedOutput }) {
        await mkdir(generatedOutput, { recursive: true });
        await writeFile(join(generatedOutput, "index.html"), "index-free site", "utf8");
      },
    });

    expect(result).toMatchObject({
      failed: 0,
      sessionCount: 1,
      richContentFailures: [
        {
          sessionId: "11111111-1111-4111-8111-111111111111",
          sourcePath: source,
          stage: "prepare",
          errorName: "TypeError",
          errorMessage: "Synthetic rich-content preparation failure",
        },
      ],
    });
    const publishedIndex = sessionIndexSchema.parse(
      JSON.parse(await readFile(join(outputRoot, "payloads", "sessions", "index.json"), "utf8")),
    );
    expect(publishedIndex.sessions).toEqual([{ id: "11111111-1111-4111-8111-111111111111" }]);
  }, 30_000);

  it("keeps the previous offline site when search finalization fails", async () => {
    const root = await temporaryRoot();
    const codexHome = join(root, "codex-home");
    const source = join(codexHome, "sessions", "modern.jsonl");
    const generatedRoot = join(root, ".generated");
    const outputRoot = join(root, ".output", "public");
    const paths = viewerPaths(root);
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    await copyFile(new URL("../../fixtures/rollouts/modern.jsonl", import.meta.url), source);
    await mkdir(outputRoot, { recursive: true });
    await writeFile(join(outputRoot, "last-good.txt"), "keep me", "utf8");

    await expect(
      runStaticExport({
        cwd: root,
        codexHome,
        generatedRoot,
        outputRoot,
        paths,
        offline: true,
        async generate({ outputRoot: generatedOutput }) {
          await rm(generatedOutput, { recursive: true, force: true });
          await mkdir(generatedOutput, { recursive: true });
          await writeFile(join(generatedOutput, "index.html"), "new site", "utf8");
        },
        async buildSearch() {
          throw new Error("Synthetic Pagefind finalization failure");
        },
      }),
    ).rejects.toThrow("Synthetic Pagefind finalization failure");

    expect(await readFile(join(outputRoot, "last-good.txt"), "utf8")).toBe("keep me");
    await expect(
      readFile(join(outputRoot, "payloads", "sessions", "index.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await readdir(join(root, ".output"))).filter((name) => name.includes(".tmp"))).toEqual(
      [],
    );
  });

  it("passes only flat search records after staging inspector payloads", async () => {
    const root = await temporaryRoot();
    const codexHome = join(root, "codex-home");
    const source = join(codexHome, "sessions", "modern.jsonl");
    const generatedRoot = join(root, ".generated");
    const outputRoot = join(root, ".output", "public");
    const paths = viewerPaths(root);
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    await copyFile(new URL("../../fixtures/rollouts/modern.jsonl", import.meta.url), source);
    let pagefindUrls: string[] = [];

    await runStaticExport({
      cwd: root,
      codexHome,
      generatedRoot,
      outputRoot,
      paths,
      offline: true,
      async generate({ outputRoot: generatedOutput }) {
        await mkdir(generatedOutput, { recursive: true });
        await writeFile(join(generatedOutput, "index.html"), "new site", "utf8");
      },
      async buildSearch(records, outputPath, options) {
        pagefindUrls = records.flatMap((record) =>
          "url" in record && typeof record.url === "string" ? [record.url] : [],
        );
        options?.onRecordProgress?.(2, 2);
        options?.onWriteStart?.();
        await mkdir(outputPath, { recursive: true });
        await writeFile(join(outputPath, "pagefind.js"), "pagefind", "utf8");
        return { recordCount: 2, outputPath };
      },
    });

    expect(pagefindUrls).toEqual([
      "/session/11111111-1111-4111-8111-111111111111#turn-turn-1",
      "/session/11111111-1111-4111-8111-111111111111#turn-turn-2",
    ]);
    const inspector = staticInspectorChunkSchema.parse(
      JSON.parse(
        await readFile(
          join(
            outputRoot,
            "payloads",
            "sessions",
            "11111111-1111-4111-8111-111111111111",
            "inspector-0.json",
          ),
          "utf8",
        ),
      ),
    );
    expect(
      hydrateStaticInspectorRecords(inspector).some(({ rawRecords }) => rawRecords.length > 0),
    ).toBe(true);
  });

  it("keeps doctor read-only while reporting discovery and viewer-cache state", async () => {
    const root = await temporaryRoot();
    const codexHome = join(root, "codex-home");
    const source = join(codexHome, "archived_sessions", "legacy.jsonl");
    const paths = viewerPaths(root);
    await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
    await mkdir(join(root, ".output", "public"), { recursive: true });
    await copyFile(new URL("../../fixtures/rollouts/legacy.jsonl", import.meta.url), source);
    const before = await readFile(source);

    const report = await collectDoctorReport({ cwd: root, codexHome, paths });

    expect(report).toMatchObject({
      codexHome,
      activeSessions: 0,
      archivedSessions: 1,
      cache: { status: "missing", sessionCount: 0, diagnosticCount: 0 },
      capabilities: { live: true, export: true, offline: false },
      offlineOutput: {
        structuralStatus: "incomplete",
        integrityStatus: "not-checked",
        sessionCount: 0,
      },
    });
    await expect(lstat(paths.cacheDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(source)).toEqual(before);
  });

  it("includes persisted source-level cache failures in the doctor diagnostics", async () => {
    const root = await temporaryRoot();
    const codexHome = join(root, "codex-home");
    const source = join(codexHome, "sessions", "modern.jsonl");
    const paths = viewerPaths(root);
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    await copyFile(new URL("../../fixtures/rollouts/modern.jsonl", import.meta.url), source);
    await mkdir(paths.cacheDir, { recursive: true });
    const database = openCacheDatabase(paths.cacheDatabase);
    try {
      const updater = new SessionCacheUpdater(database, {
        normalize() {
          throw new Error("Synthetic doctor-visible failure");
        },
      });
      await updater.update({ path: source, scope: "active" });
    } finally {
      database.close();
    }

    const report = await collectDoctorReport({ cwd: root, codexHome, paths });

    expect(report.cache).toMatchObject({
      status: "available",
      sessionCount: 0,
      diagnosticCount: 1,
    });
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cache.unavailable", area: "cache", path: source }),
      ]),
    );
  });
});

it("preserves logical review visibility through fresh and cached exports and the actual static reader", async () => {
  const root = await temporaryRoot();
  const codexHome = join(root, "home");
  const id = "11111111-1111-4111-8111-111111111111";
  const records = cutoffReviewRecords(id);
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  const sourcePath = join(codexHome, "sessions", "rollout-parent.jsonl");
  await writeFile(sourcePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const bytes = await readFile(sourcePath);
  const outputRoot = join(root, "output");
  const paths = viewerPaths(root);
  const options = {
    cwd: root,
    codexHome,
    generatedRoot: join(root, "generated"),
    outputRoot,
    paths,
    offline: true,
    index: false,
    async generate({ outputRoot: destination }: { outputRoot: string }) {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "index.html"), "cutoff review fixture");
    },
  };
  async function verifyExport(cached: boolean) {
    const result = await runStaticExport(options);
    expect(result).toMatchObject({ transformed: cached ? 0 : 1, reused: cached ? 1 : 0 });
    const repository = new StaticConversationRepository(async (path) =>
      JSON.parse(await readFile(join(outputRoot, path.replace(/^\//u, "")), "utf8")),
    );
    const evidence = await repository.getApprovalEvidence(id);
    expect(
      evidence.matched.map((match) => [
        match.activityId,
        match.attempts.map((review) => review.reviewId),
      ]),
    ).toEqual([["visible-command", ["visible-review"]]]);
    expect(evidence.unattached).toEqual([]);
    expect(evidence.parentSource?.availability).toBe("partial");
    const database = openCacheDatabase(paths.cacheDatabase);
    try {
      const conversation = getCachedSession(database, id);
      const rawReviews = conversation?.rawEvents.filter(
        (event) =>
          event.payload !== null &&
          typeof event.payload === "object" &&
          Object.hasOwn(event.payload, "method"),
      );
      expect(rawReviews?.map((event) => event.logicalVisibility)).toEqual([
        "context-only",
        "context-only",
        "context-only",
        "context-only",
        "context-only",
        "visible",
        "visible",
      ]);
      expect(rawReviews?.[0]?.payload).toMatchObject({ params: { reviewId: "review-a" } });
    } finally {
      database.close();
    }
  }
  await verifyExport(false);
  await verifyExport(true);
  expect(Buffer.compare(await readFile(sourcePath), bytes)).toBe(0);
});

it("exports supplied parent native reviews and reads them through the actual static repository", async () => {
  const root = await temporaryRoot();
  const codexHome = join(root, "home");
  const id = "11111111-1111-4111-8111-111111111111";
  const records = parentReviewRecords(id);
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  await writeFile(
    join(codexHome, "sessions", "rollout-parent.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  const outputRoot = join(root, "output");
  await runStaticExport({
    cwd: root,
    codexHome,
    generatedRoot: join(root, "generated"),
    outputRoot,
    paths: viewerPaths(root),
    offline: true,
    index: false,
    async generate({ outputRoot: destination }) {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "index.html"), "parent review fixture");
    },
  });
  const repository = new StaticConversationRepository(async (path) =>
    JSON.parse(await readFile(join(outputRoot, path.replace(/^\//u, "")), "utf8")),
  );
  const evidence = await repository.getApprovalEvidence(id);
  expect(evidence).toMatchObject({
    sessionId: id,
    parentSource: { availability: "partial", historyEpoch: null, coverage: null },
    matched: [
      {
        activityId: "command",
        attempts: [
          { reviewId: "review-a", outcome: "allow" },
          { reviewId: "review-b", outcome: null },
        ],
      },
    ],
  });
  expect(evidence.parentSource?.contentRevision).toMatch(/^[a-f0-9]{64}$/u);
  expect(evidence.unattached.map(({ review, reason }) => [review.reviewId, reason])).toEqual([
    ["network", "missing-target"],
    ["mcp-denied", "standalone-denial"],
  ]);
  const sources = evidence.matched[0]?.attempts[0]?.sourceRecords;
  const expectedStart = Buffer.byteLength(
    records
      .slice(0, 5)
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );
  expect(sources).toHaveLength(2);
  expect(sources?.[0]?.identity.decodedByteStart).toBe(expectedStart);
  expect(sources?.[1]?.identity.decodedByteStart).toBeGreaterThan(expectedStart);
  expect(sources?.[0]?.identity.rangeSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(sources?.[0]?.envelope).toMatchObject({
    method: "item/autoApprovalReview/started",
    params: { threadId: id, turnId: "turn", reviewId: "review-a" },
  });
});
