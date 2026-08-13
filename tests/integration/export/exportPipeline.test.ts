import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod";

import type { ViewerPaths } from "../../../server/core/paths.ts";
import { collectDoctorReport } from "../../../server/export/doctorReport.ts";
import { runStaticExport } from "../../../server/export/exportPipeline.ts";
import { CliExportProgress } from "../../../server/export/exportProgress.ts";

const temporaryDirectories: string[] = [];
const routeManifestSchema = z.object({ routes: z.array(z.string()) });
const sessionIndexSchema = z.object({ sessions: z.array(z.object({ id: z.string() })) });

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
    const outputRoot = join(root, "public");
    const paths = viewerPaths(root);
    await mkdir(join(codexHome, "sessions", "2026"), { recursive: true });
    await copyFile(new URL("../../fixtures/rollouts/modern.jsonl", import.meta.url), source);
    const sourceBytes = await readFile(source);
    const sourceBefore = await lstat(source, { bigint: true });
    const generateCalls: Array<{ outputRoot: string; routeManifest: string }> = [];
    const progressOutput: string[] = [];
    const progress = new CliExportProgress({
      interactive: false,
      write: (text) => progressOutput.push(text),
      heartbeatMs: 60_000,
    });
    const generate = async (input: {
      outputRoot: string;
      routeManifest: string;
    }): Promise<void> => {
      generateCalls.push(input);
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
    expect(generateCalls).toEqual([
      { outputRoot, routeManifest: join(generatedRoot, "routes.json") },
      { outputRoot, routeManifest: join(generatedRoot, "routes.json") },
    ]);
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
  }, 30_000);

  it("keeps doctor read-only while reporting discovery and viewer-cache state", async () => {
    const root = await temporaryRoot();
    const codexHome = join(root, "codex-home");
    const source = join(codexHome, "archived_sessions", "legacy.jsonl");
    const paths = viewerPaths(root);
    await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
    await copyFile(new URL("../../fixtures/rollouts/legacy.jsonl", import.meta.url), source);
    const before = await readFile(source);

    const report = await collectDoctorReport({ cwd: root, codexHome, paths });

    expect(report).toMatchObject({
      codexHome,
      activeSessions: 0,
      archivedSessions: 1,
      cache: { status: "missing", sessionCount: 0, diagnosticCount: 0 },
      capabilities: { live: true, export: true, offline: false },
    });
    await expect(lstat(paths.cacheDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(source)).toEqual(before);
  });
});
