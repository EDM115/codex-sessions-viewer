import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod";

import { openCacheDatabase } from "../../../server/cache/database.ts";
import { SessionCacheUpdater } from "../../../server/cache/sourceManifest.ts";
import type { ViewerPaths } from "../../../server/core/paths.ts";
import { collectDoctorReport } from "../../../server/export/doctorReport.ts";
import { runStaticExport } from "../../../server/export/exportPipeline.ts";
import { CliExportProgress } from "../../../server/export/exportProgress.ts";
import {
  hydrateStaticInspectorRecords,
  staticInspectorChunkSchema,
} from "../../../shared/types/staticPayloads.ts";

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
    const sessionId = index.sessions[0]!.id;

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
      offlineOutput: { status: "available", sessionCount: 1, missingFiles: [] },
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
      offlineOutput: { status: "available", searchIndex: "disabled" },
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
      offlineOutput: { status: "incomplete", sessionCount: 0 },
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
