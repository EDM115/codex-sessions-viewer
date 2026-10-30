import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { expect, it } from "vitest";

import { getCachedSession } from "#server/cache/conversationStore.ts";
import { openCacheDatabase } from "#server/cache/database.ts";
import { searchCachedSessions } from "#server/cache/searchStore.ts";
import { getSourceManifestEntry, SessionCacheUpdater } from "#server/cache/sourceManifest.ts";
import { prepareConversationForExport } from "#server/export/prepareConversation.ts";
import { RolloutStore } from "#server/ingestion/rolloutStream.ts";

it("invalidates normalized, search and rich content after stopped-viewer same-path recompression with equal encoded length and mtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "materialized-zstd-"));
  const path = join(
    root,
    "rollout-2026-01-01T10-00-00-11111111-1111-4111-8111-111111111111.jsonl.zst",
  );
  const fixture = (await readFile("tests/fixtures/rollouts/modern.jsonl", "utf8")).replace(
    /"parent_thread_id":"[^"]*",/u,
    "",
  );
  const a = zstdCompressSync(
    Buffer.from(fixture.replaceAll("Build the parser", "Build the generation_A")),
  );
  const b = zstdCompressSync(
    Buffer.from(fixture.replaceAll("Build the parser", "Build the generation_B")),
  );
  const database = openCacheDatabase(join(root, "viewer.sqlite"));
  let store = new RolloutStore({ cacheDirectory: join(root, "decoded") });
  try {
    await writeFile(path, a);
    const original = await stat(path);
    let updater = new SessionCacheUpdater(database, {
      retainLiveSources: false,
      openRollout: (ref, signal) => store.open(ref, signal),
    });
    const firstUpdate = await updater.update({ path, scope: "active" });
    expect(firstUpdate).toMatchObject({ status: "updated" });
    const id = "11111111-1111-4111-8111-111111111111";
    const first = getCachedSession(database, id)!;
    const firstPrepared = await prepareConversationForExport(database, first, {
      mediaRoot: join(root, "assets"),
      faviconRoot: join(root, "favicons"),
      offline: true,
    });
    expect(firstPrepared.conversation.turns[0]?.userMessage?.sourceMarkdown).toContain(
      "generation_A",
    );
    expect(searchCachedSessions(database, { scope: "active", query: "generation_A" }).total).toBe(
      1,
    );
    const generationA = getSourceManifestEntry(database, path)?.generation;
    expect(generationA?.encodedSha256).not.toEqual(generationA?.decodedSha256);
    expect(generationA?.decodedSize).toBeGreaterThan(a.length);
    updater.clear();
    await store.close();
    expect(b.length).toBe(a.length);
    await writeFile(path, b);
    await utimes(path, original.atime, original.mtime);
    store = new RolloutStore({ cacheDirectory: join(root, "decoded") });
    updater = new SessionCacheUpdater(database, {
      retainLiveSources: false,
      openRollout: (ref, signal) => store.open(ref, signal),
    });
    expect(await updater.update({ path, scope: "active" })).toMatchObject({ status: "updated" });
    const second = getCachedSession(database, id)!;
    expect(second.summary.revision).not.toBe(first.summary.revision);
    expect(second.turns[0]?.userMessage?.sourceMarkdown).toContain("generation_B");
    expect(searchCachedSessions(database, { scope: "active", query: "generation_A" }).total).toBe(
      0,
    );
    expect(searchCachedSessions(database, { scope: "active", query: "generation_B" }).total).toBe(
      1,
    );
    const secondPrepared = await prepareConversationForExport(database, second, {
      mediaRoot: join(root, "assets"),
      faviconRoot: join(root, "favicons"),
      offline: true,
    });
    expect(JSON.stringify(secondPrepared.conversation.turns[0]?.userMessage?.body)).toContain(
      "generation_B",
    );
    expect(JSON.stringify(secondPrepared.conversation.turns[0]?.userMessage?.body)).not.toContain(
      "generation_A",
    );
  } finally {
    await store.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
