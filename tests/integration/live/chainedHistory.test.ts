import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { expect, it, vi } from "vitest";

import { RolloutHistoryReader } from "#server/history/rolloutHistoryReader.ts";
import { rolloutRefFromSource } from "#server/ingestion/rolloutIdentity.ts";
import { RolloutStore } from "#server/ingestion/rolloutStream.ts";
import { SelectedPhysicalSources } from "#server/ingestion/selectedPhysicalSources.ts";
import { resolveSelectedRolloutLineage } from "#server/ingestion/selectedRolloutLineage.ts";
import { LiveViewerRuntime } from "#server/live/viewerRuntime.ts";

import { ancestryRecords, ancestryThread, jsonl } from "../../fixtures/history/mixedAncestry.ts";
import { createStateDatabase } from "../source-boundary/fixtures.ts";

const grandparent = "22222222-2222-4222-8222-222222222222";
const parent = "33333333-3333-4333-8333-333333333333";
const leaf = "44444444-4444-4444-8444-444444444444";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chain-"));
  const home = join(root, "home");
  const sessions = join(home, "sessions");
  await mkdir(sessions, { recursive: true });
  const grandparentPath = join(
    sessions,
    `rollout-2026-10-01T10-00-00-${ancestryThread}_${grandparent}.jsonl`,
  );
  const parentPath = join(
    sessions,
    `rollout-2026-10-02T10-00-00-${ancestryThread}_${parent}.jsonl`,
  );
  const leafPath = join(sessions, `rollout-2026-10-03T10-00-00-${ancestryThread}_${leaf}.jsonl`);
  const grandparentRecords = ancestryRecords(ancestryThread, "grandparent-turn", "GRANDPARENT_A");
  const grandparentText = jsonl(grandparentRecords);
  const parentRecords = ancestryRecords(ancestryThread, "parent-turn", "PARENT_A");
  parentRecords[0]!.payload["history_base"] = {
    thread_id: grandparent,
    end_ordinal_exclusive: grandparentRecords.length,
    end_byte_offset: Buffer.byteLength(grandparentText),
  };
  const parentText = jsonl(parentRecords);
  const leafRecords = ancestryRecords(ancestryThread, "leaf-turn", "LEAF_A");
  leafRecords[0]!.payload["history_base"] = {
    thread_id: parent,
    end_ordinal_exclusive: grandparentRecords.length + parentRecords.length,
    end_byte_offset: Buffer.byteLength(parentText),
  };
  const excluded = jsonl(ancestryRecords(ancestryThread, "excluded", "EXCLUDED_SUFFIX").slice(1));
  await Promise.all([
    writeFile(grandparentPath, grandparentText + excluded),
    writeFile(parentPath, parentText + excluded),
    writeFile(leafPath, jsonl(leafRecords)),
  ]);
  const selected = rolloutRefFromSource(leafPath, null);
  return { root, home, sessions, grandparentPath, parentPath, leafPath, selected };
}

async function sourceSnapshot(sessions: string) {
  return Promise.all(
    (await readdir(sessions)).toSorted().map(async (name) => {
      const path = join(sessions, name);
      const info = await stat(path, { bigint: true });
      return {
        name,
        size: info.size,
        mtimeNs: info.mtimeNs,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      };
    }),
  );
}

it("converges across bounded discovery slices for two unknown physical ancestors and reads their cutoffs", async () => {
  const f = await fixture();
  const before = await sourceSnapshot(f.sessions);
  const sources = new SelectedPhysicalSources(2);
  const store = new RolloutStore({ cacheDirectory: join(f.root, "cache") });
  const open = (ref: Parameters<RolloutStore["open"]>[0], signal?: AbortSignal) =>
    store.open(ref, signal);
  const resolve = () => {
    sources.beginLineage(f.selected);
    return resolveSelectedRolloutLineage(f.selected, [f.selected], undefined, {
      open,
      prepareCompressedAncestors: true,
      resolvePhysical: (physical, signal) => sources.resolve(f.selected, physical, signal),
    });
  };
  try {
    await expect(resolve()).rejects.toThrow("lineage.preparation_pending");
    const lineage = await resolve();
    expect(lineage.status).toBe("complete");
    expect(lineage.segments.map((segment) => segment.ref.physicalRolloutId)).toEqual([
      grandparent,
      parent,
      leaf,
    ]);
    const reader = new RolloutHistoryReader({ open });
    const page = await reader.read(lineage, {
      anchor: { kind: "turn", turnId: "grandparent-turn" },
      limit: 20,
    });
    expect(JSON.stringify(page)).toContain("GRANDPARENT_A");
    expect(JSON.stringify(page)).not.toContain("EXCLUDED_SUFFIX");
  } finally {
    expect(await sourceSnapshot(f.sessions)).toEqual(before);
    await sources.close();
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

it("refreshes completed discovery for a later missing ancestor, ambiguity and recompressed fresh bytes", async () => {
  const f = await fixture();
  const originalGrandparent = await readFile(f.grandparentPath);
  await rm(f.grandparentPath);
  const sources = new SelectedPhysicalSources(2);
  const store = new RolloutStore({ cacheDirectory: join(f.root, "cache") });
  const open = (ref: Parameters<RolloutStore["open"]>[0], signal?: AbortSignal) =>
    store.open(ref, signal);
  const resolve = () => {
    sources.beginLineage(f.selected);
    return resolveSelectedRolloutLineage(f.selected, [f.selected], undefined, {
      open,
      prepareCompressedAncestors: true,
      resolvePhysical: (physical, signal) => sources.resolve(f.selected, physical, signal),
    });
  };
  try {
    const missingSnapshot = await sourceSnapshot(f.sessions);
    await expect(resolve()).rejects.toThrow("lineage.preparation_pending");
    const missing = await resolve();
    expect(missing.status).toBe("unresolved");
    expect(missing.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "lineage.missing_base",
    );
    expect(await sourceSnapshot(f.sessions)).toEqual(missingSnapshot);
    await writeFile(f.grandparentPath, originalGrandparent);
    const restoredSnapshot = await sourceSnapshot(f.sessions);
    await expect(resolve()).rejects.toThrow("lineage.preparation_pending");
    expect((await resolve()).status).toBe("complete");
    expect(await sourceSnapshot(f.sessions)).toEqual(restoredSnapshot);
    const duplicate = f.grandparentPath.replace("10-00-00", "11-00-00");
    await writeFile(duplicate, originalGrandparent);
    const duplicateSnapshot = await sourceSnapshot(f.sessions);
    await expect(resolve()).rejects.toThrow("lineage.preparation_pending");
    await expect(resolve()).rejects.toThrow("lineage.preparation_pending");
    const ambiguous = await resolve();
    expect(ambiguous.status).toBe("unresolved");
    expect(ambiguous.segments.map((segment) => segment.ref.physicalRolloutId)).not.toContain(
      grandparent,
    );
    expect(await sourceSnapshot(f.sessions)).toEqual(duplicateSnapshot);
    await rm(duplicate);
    await rm(f.grandparentPath);
    await writeFile(
      `${f.grandparentPath}.zst`,
      zstdCompressSync(
        Buffer.from(originalGrandparent.toString().replace("GRANDPARENT_A", "GRANDPARENT_B")),
      ),
    );
    const compressedSnapshot = await sourceSnapshot(f.sessions);
    await expect(resolve()).rejects.toThrow("lineage.preparation_pending");
    const fresh = await resolve();
    expect(fresh.status).toBe("complete");
    expect(fresh.segments[0]?.ref.representation).toBe("zstd-jsonl");
    const page = await new RolloutHistoryReader({ open }).read(fresh, {
      anchor: { kind: "turn", turnId: "grandparent-turn" },
      limit: 20,
    });
    expect(JSON.stringify(page)).toContain("GRANDPARENT_B");
    expect(JSON.stringify(page)).not.toContain("GRANDPARENT_A");
    expect(JSON.stringify(page)).not.toContain("EXCLUDED_SUFFIX");
    expect(await sourceSnapshot(f.sessions)).toEqual(compressedSnapshot);
  } finally {
    await sources.close();
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

it("wires one discovery boundary around an actual runtime lineage and refreshes its next explicit selection", async () => {
  const f = await fixture();
  const state = createStateDatabase(join(f.home, "state_5.sqlite"));
  state.prepare("UPDATE threads SET id = ?, rollout_path = ?").run(ancestryThread, f.leafPath);
  state.close();
  const cacheDir = join(f.root, "cache");
  const runtime = await LiveViewerRuntime.start(
    {
      settings: { codexHome: f.home, port: 3000, fetchFavicons: false },
      paths: {
        cacheDir,
        cacheDatabase: join(cacheDir, "viewer.sqlite"),
        configDir: join(f.root, "config"),
        configFile: join(f.root, "config/config.json"),
        generatedDir: join(f.root, "generated"),
      },
      codexHomeSource: "cli",
      onboardingRequired: false,
      diagnostics: [],
    },
    { reconciliationIntervalMs: 60000 },
  );
  const bounded = new SelectedPhysicalSources(2);
  const beginBounded = bounded.beginLineage.bind(bounded);
  const resolveBounded = bounded.resolve.bind(bounded);
  const closeBounded = bounded.close.bind(bounded);
  const begin = vi
    .spyOn(SelectedPhysicalSources.prototype, "beginLineage")
    .mockImplementation(beginBounded);
  const resolve = vi
    .spyOn(SelectedPhysicalSources.prototype, "resolve")
    .mockImplementation(resolveBounded);
  vi.spyOn(SelectedPhysicalSources.prototype, "close").mockImplementation(closeBounded);
  try {
    const before = await sourceSnapshot(f.sessions);
    const recent = await runtime.repository.getHistoryPage(ancestryThread, {
      anchor: { kind: "latest" },
    });
    expect(recent.turns.map((turn) => turn.turnId)).toEqual(["leaf-turn"]);
    expect(resolve).not.toHaveBeenCalled();
    begin.mockClear();
    await expect(
      runtime.repository.getHistoryPage(ancestryThread, {
        anchor: { kind: "before", cursor: recent.beforeCursor! },
        limit: 20,
      }),
    ).rejects.toThrow("lineage.preparation_pending");
    const older = await runtime.repository.getHistoryPage(ancestryThread, {
      anchor: { kind: "before", cursor: recent.beforeCursor! },
      limit: 20,
    });
    expect(begin).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls.map((call) => call[1])).toEqual([parent, parent, grandparent]);
    expect(JSON.stringify(older)).toContain("GRANDPARENT_A");
    expect(JSON.stringify(older)).not.toContain("EXCLUDED_SUFFIX");
    expect(await sourceSnapshot(f.sessions)).toEqual(before);
    const bytes = await readFile(f.grandparentPath);
    await rm(f.grandparentPath);
    await writeFile(
      `${f.grandparentPath}.zst`,
      zstdCompressSync(Buffer.from(bytes.toString().replace("GRANDPARENT_A", "GRANDPARENT_B"))),
    );
    const compressed = await sourceSnapshot(f.sessions);
    begin.mockClear();
    await expect(
      runtime.repository.getHistoryPage(ancestryThread, {
        anchor: { kind: "turn", turnId: "grandparent-turn" },
      }),
    ).rejects.toThrow("lineage.preparation_pending");
    const target = await runtime.repository.getHistoryPage(ancestryThread, {
      anchor: { kind: "turn", turnId: "grandparent-turn" },
    });
    expect(begin).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(target)).toContain("GRANDPARENT_B");
    expect(JSON.stringify(target)).not.toContain("GRANDPARENT_A");
    expect(await sourceSnapshot(f.sessions)).toEqual(compressed);
  } finally {
    await runtime.close();
    vi.restoreAllMocks();
    await rm(f.root, { recursive: true, force: true });
  }
});

it("closes cancelled physical enumeration and starts a fresh bounded cursor afterward", async () => {
  const f = await fixture();
  const before = await sourceSnapshot(f.sessions);
  const sources = new SelectedPhysicalSources(2);
  const controller = new AbortController();
  try {
    const pending = sources.resolve(f.selected, parent, controller.signal);
    const rejected = pending.catch((error: unknown) => error);
    controller.abort();
    expect(await rejected).toMatchObject({ name: "AbortError" });
    sources.beginLineage(f.selected);
    await expect(sources.resolve(f.selected, parent)).rejects.toThrow(
      "lineage.preparation_pending",
    );
    expect((await sources.resolve(f.selected, parent))?.sourcePath).toBe(f.parentPath);
    expect((await sources.resolve(f.selected, grandparent))?.sourcePath).toBe(f.grandparentPath);
    expect(await sourceSnapshot(f.sessions)).toEqual(before);
  } finally {
    await sources.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
