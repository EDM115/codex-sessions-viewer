import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { expect, it } from "vitest";

import { openCacheDatabase } from "#server/cache/database.ts";
import { searchCachedSessions } from "#server/cache/searchStore.ts";
import { getSourceManifestEntry } from "#server/cache/sourceManifest.ts";
import { runStaticExport } from "#server/export/exportPipeline.ts";
import { StaticConversationRepository } from "~/repositories/static.ts";

it("revisions search, rich content and the actual export reader across a stopped-viewer same-path equal-size recompression", async () => {
  const root = await mkdtemp(join(tmpdir(), "viewer-export-recompression-"));
  const codexHome = join(root, "home");
  const cacheDir = join(root, "cache");
  const id = "11111111-1111-4111-8111-111111111111";
  const source = join(codexHome, `sessions/rollout-2026-01-01T10-00-00-${id}.jsonl.zst`);
  const outputRoot = join(root, "output");
  const paths = {
    cacheDir,
    cacheDatabase: join(cacheDir, "viewer.sqlite"),
    configDir: join(root, "config"),
    configFile: join(root, "config/config.json"),
    generatedDir: join(root, "generated"),
  };
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  const text = (await readFile("tests/fixtures/rollouts/modern.jsonl", "utf8")).replace(
    /"parent_thread_id":"[^"]*",/u,
    "",
  );
  const a = zstdCompressSync(
    Buffer.from(text.replaceAll("Build the parser", "Build the generation_A")),
  );
  const b = zstdCompressSync(
    Buffer.from(text.replaceAll("Build the parser", "Build the generation_B")),
  );
  expect(a.length).toBe(b.length);
  const options = {
    codexHome,
    paths,
    outputRoot,
    generatedRoot: paths.generatedDir,
    offline: true,
    index: false,
    generate: async ({ outputRoot: destination }: { outputRoot: string }) => {
      await mkdir(destination, { recursive: true });
      await writeFile(
        join(destination, "index.html"),
        "<!doctype html><title>Fixture shell</title>",
      );
    },
  };
  const reader = () =>
    new StaticConversationRepository(
      async (path) => JSON.parse(await readFile(join(outputRoot, path), "utf8")) as unknown,
    );
  try {
    await writeFile(source, a);
    const initial = await stat(source);
    await runStaticExport(options);
    const first = await reader().getSession(id);
    expect(
      JSON.stringify(await reader().getHistoryPage(id, { anchor: { kind: "latest" } })),
    ).toContain("generation_A");
    let database = openCacheDatabase(paths.cacheDatabase);
    const generationA = getSourceManifestEntry(database, source)?.generation;
    try {
      expect(searchCachedSessions(database, { scope: "active", query: "generation_A" }).total).toBe(
        1,
      );
    } finally {
      database.close();
    }
    await writeFile(source, b);
    await utimes(source, initial.atime, initial.mtime);
    await runStaticExport(options);
    const current = reader();
    expect((await current.getSession(id)).revision).not.toBe(first.revision);
    const page = await current.getHistoryPage(id, { anchor: { kind: "latest" } });
    expect(JSON.stringify(page)).toContain("generation_B");
    expect(JSON.stringify(page)).not.toContain("generation_A");
    const turns = await current.getTurns(id, { limit: 20 });
    expect(JSON.stringify(turns.turns[0]?.userMessage?.body)).toContain("generation_B");
    expect(JSON.stringify(turns.turns[0]?.userMessage?.body)).not.toContain("generation_A");
    database = openCacheDatabase(paths.cacheDatabase);
    try {
      const generationB = getSourceManifestEntry(database, source)?.generation;
      expect(generationB?.encodedSha256).not.toBe(generationA?.encodedSha256);
      expect(generationB?.decodedSha256).not.toBe(generationA?.decodedSha256);
      expect(searchCachedSessions(database, { scope: "active", query: "generation_A" }).total).toBe(
        0,
      );
      expect(searchCachedSessions(database, { scope: "active", query: "generation_B" }).total).toBe(
        1,
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30000);
