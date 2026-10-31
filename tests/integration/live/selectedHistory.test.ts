import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { catalogSession, upsertCatalogSessions } from "#server/cache/catalogStore.ts";
import { HistoryPager, HistoryReloadError } from "#server/history/historyPager.ts";
import { RolloutStore } from "#server/ingestion/rolloutStream.ts";
import { MaterializationQueue } from "#server/live/materializationQueue.ts";
import { LiveViewerRuntime } from "#server/live/viewerRuntime.ts";
import type { HistoryPageQuery, ViewerInvalidation } from "#shared/types/repository.ts";

import {
  ancestryThread,
  ancestryLeafPhysical,
  ancestryRecords,
  mixedAncestryFixture,
  jsonl,
} from "../../fixtures/history/mixedAncestry.ts";
import { createStateDatabase } from "../source-boundary/fixtures.ts";

async function setup(options: { compressed?: boolean; padding?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "sel-"));
  const fixture = await mixedAncestryFixture(join(root, "home"), options);
  const state = createStateDatabase(join(fixture.home, "state_5.sqlite"));
  state
    .prepare("UPDATE threads SET id = ?, rollout_path = ?")
    .run(ancestryThread, fixture.leafPath);
  state.close();
  const cacheDir = join(root, "cache");
  const runtime = await LiveViewerRuntime.start(
    {
      settings: { codexHome: fixture.home, port: 3000, fetchFavicons: false },
      paths: {
        cacheDir,
        cacheDatabase: join(cacheDir, "viewer.sqlite"),
        configDir: join(root, "config"),
        configFile: join(root, "config/config.json"),
        generatedDir: join(root, "generated"),
      },
      codexHomeSource: "cli",
      onboardingRequired: false,
      diagnostics: [],
    },
    { reconciliationIntervalMs: 60000 },
  );
  return {
    ...fixture,
    root,
    runtime,
    async close() {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function changeOpenedLeaf(f: Awaited<ReturnType<typeof setup>>, changes: number) {
  const original = RolloutStore.prototype.open;
  let changed = 0;
  return vi.spyOn(RolloutStore.prototype, "open").mockImplementation(async function (
    this: RolloutStore,
    ref,
    signal,
  ) {
    const lease = await original.call(this, ref, signal);
    if (ref.sourcePath === f.leafPath && changed < changes) {
      changed += 1;
      await appendFile(
        f.leafPath,
        jsonl(ancestryRecords(ancestryThread, `append-${changed}`, `FRESH_${changed}`).slice(1)),
      );
    }
    return lease;
  });
}

it("reads a quiet latest page once and keeps one selected-work lifetime across a fresh reread", async () => {
  const f = await setup();
  const reads = vi.spyOn(HistoryPager.prototype, "read");
  const originalHold = MaterializationQueue.prototype.holdSelected;
  const releases = vi.fn<() => void>();
  const holds = vi
    .spyOn(MaterializationQueue.prototype, "holdSelected")
    .mockImplementation(function (this: MaterializationQueue) {
      const release = originalHold.call(this);
      return () => {
        releases();
        release();
      };
    });
  const controller = new AbortController();
  const query: HistoryPageQuery = { anchor: { kind: "latest" }, limit: 1 };
  try {
    const quiet = await f.runtime.repository.getHistoryPage(ancestryThread, query, {
      signal: controller.signal,
    });
    expect(quiet.turns.map((turn) => turn.turnId)).toEqual(["leaf-turn"]);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(holds).toHaveBeenCalledTimes(1);
    expect(releases).toHaveBeenCalledTimes(1);
    reads.mockClear();
    holds.mockClear();
    releases.mockClear();
    const opened = changeOpenedLeaf(f, 1);
    const fresh = await f.runtime.repository.getHistoryPage(ancestryThread, query, {
      signal: controller.signal,
    });
    expect(fresh.turns.map((turn) => turn.turnId)).toEqual(["append-1"]);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(
      reads.mock.calls.every((call) => call[2] === query && call[3] === controller.signal),
    ).toBe(true);
    expect(holds).toHaveBeenCalledTimes(1);
    expect(releases).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it("caps a latest page at two actual source-conflicted attempts", async () => {
  const f = await setup();
  const reads = vi.spyOn(HistoryPager.prototype, "read");
  const opened = changeOpenedLeaf(f, 3);
  try {
    await expect(
      f.runtime.repository.getHistoryPage(ancestryThread, { anchor: { kind: "latest" } }),
    ).rejects.toBeInstanceOf(HistoryReloadError);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(opened).toHaveBeenCalledTimes(2);
    expect(await readFile(f.leafPath, "utf8")).toContain("FRESH_2");
    expect(await readFile(f.leafPath, "utf8")).not.toContain("FRESH_3");
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it.each(["source-path", "source-revision"] as const)(
  "reselects and rechecks the latest page after the actual publication fence changes %s",
  async (field) => {
    const f = await setup();
    const replacement = join(
      f.home,
      `sessions/rollout-2026-10-03T10-00-00-${ancestryThread}_55555555-5555-4555-8555-555555555555.jsonl`,
    );
    await writeFile(
      replacement,
      jsonl(ancestryRecords(ancestryThread, "replacement", "NEW_SELECTION")),
    );
    const original = HistoryPager.prototype.read;
    const reads = vi.spyOn(HistoryPager.prototype, "read").mockImplementation(async function (
      this: HistoryPager,
      ...args
    ) {
      const page = await original.call(this, ...args);
      if (reads.mock.calls.length === 1) {
        const selected = catalogSession(f.runtime.database, ancestryThread);
        if (!selected) {
          throw new Error("Expected the selected synthetic catalog row");
        }
        upsertCatalogSessions(f.runtime.database, [
          {
            ...selected,
            summary: {
              ...selected.summary,
              sourcePath: field === "source-path" ? replacement : selected.summary.sourcePath,
            },
            sourceRevision: field === "source-revision" ? "new-selection" : selected.sourceRevision,
          },
        ]);
      }
      return page;
    });
    try {
      const page = await f.runtime.repository.getHistoryPage(ancestryThread, {
        anchor: { kind: "latest" },
      });
      expect(reads).toHaveBeenCalledTimes(2);
      expect(page.turns.map((turn) => turn.turnId)).toEqual([
        field === "source-path" ? "replacement" : "leaf-turn",
      ]);
      expect(reads.mock.calls[1]?.[0].sourcePath).toBe(
        field === "source-path" ? replacement : f.leafPath,
      );
      expect(reads.mock.calls[1]?.[4]).toBe(
        field === "source-revision" ? "new-selection" : reads.mock.calls[0]?.[4],
      );
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

it.each(["abort", "dispose"] as const)(
  "does not reread latest when %s wins after the actual source conflict",
  async (ending) => {
    const f = await setup();
    const controller = new AbortController();
    const original = HistoryPager.prototype.read;
    let observedConflict: unknown;
    changeOpenedLeaf(f, 1);
    const reads = vi.spyOn(HistoryPager.prototype, "read").mockImplementation(async function (
      this: HistoryPager,
      ...args
    ) {
      try {
        return await original.call(this, ...args);
      } catch (error) {
        observedConflict = error;
        if (ending === "abort") {
          controller.abort();
        } else {
          await f.runtime.close();
        }
        throw error;
      }
    });
    try {
      const read = f.runtime.repository.getHistoryPage(
        ancestryThread,
        { anchor: { kind: "latest" } },
        { signal: controller.signal },
      );
      await expect(read).rejects.toMatchObject({
        name: ending === "abort" ? "AbortError" : "HistoryReloadError",
      });
      expect(observedConflict).toBeInstanceOf(HistoryReloadError);
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

it("retains the final selection fence on the second latest attempt", async () => {
  const f = await setup();
  const original = HistoryPager.prototype.read;
  const reads = vi.spyOn(HistoryPager.prototype, "read").mockImplementation(async function (
    this: HistoryPager,
    ...args
  ) {
    const page = await original.call(this, ...args);
    const selected = catalogSession(f.runtime.database, ancestryThread);
    if (!selected) {
      throw new Error("Expected the selected synthetic catalog row");
    }
    upsertCatalogSessions(f.runtime.database, [
      { ...selected, sourceRevision: `changed-${reads.mock.calls.length}` },
    ]);
    return page;
  });
  try {
    await expect(
      f.runtime.repository.getHistoryPage(ancestryThread, { anchor: { kind: "latest" } }),
    ).rejects.toMatchObject({ name: "HistoryReloadError", message: "history.selection_changed" });
    expect(reads).toHaveBeenCalledTimes(2);
    expect(reads.mock.calls[1]?.[4]).toBe("changed-1");
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it("does not retry schema failures or an untyped reload-shaped error", async () => {
  const f = await setup();
  const reads = vi.spyOn(HistoryPager.prototype, "read");
  try {
    await expect(
      f.runtime.repository.getHistoryPage(ancestryThread, { anchor: { kind: "latest" }, limit: 0 }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(reads).toHaveBeenCalledTimes(1);
    const error = Object.assign(new Error("rollout.source_changed"), {
      code: "history.reload_required",
    });
    reads.mockClear();
    reads.mockRejectedValue(error);
    await expect(
      f.runtime.repository.getHistoryPage(ancestryThread, { anchor: { kind: "latest" } }),
    ).rejects.toBe(error);
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it.each(["before", "after", "turn", "item"] as const)(
  "does not turn a pinned %s source conflict into a fresh latest request",
  async (kind) => {
    const f = await setup();
    const recent = await f.runtime.repository.getHistoryPage(ancestryThread, {
      anchor: { kind: "latest" },
    });
    const older = await f.runtime.repository.getHistoryPage(ancestryThread, {
      anchor: { kind: "before", cursor: recent.beforeCursor! },
    });
    const reads = vi.spyOn(HistoryPager.prototype, "read");
    const items = vi.spyOn(HistoryPager.prototype, "readItems");
    const opened = changeOpenedLeaf(f, 2);
    try {
      const read =
        kind === "item"
          ? f.runtime.repository.getTurnItems(ancestryThread, {
              turnId: "leaf-turn",
              anchor: { kind: "latest" },
            })
          : f.runtime.repository.getHistoryPage(ancestryThread, {
              anchor:
                kind === "turn"
                  ? { kind, turnId: "leaf-turn" }
                  : { kind, cursor: kind === "before" ? recent.beforeCursor! : older.afterCursor! },
            });
      await expect(read).rejects.toBeInstanceOf(HistoryReloadError);
      expect(reads.mock.calls.length + items.mock.calls.length).toBe(1);
      expect(opened).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  },
);

it.each([{ compressed: false }, { compressed: true }, { compressed: false, padding: 300 * 1024 }])(
  "reaches a noncurrent physical ancestor through the public runtime after bounded leaf paint (%j)",
  async (options) => {
    const opened: string[] = [];
    const original = RolloutStore.prototype.open;
    const spy = vi.spyOn(RolloutStore.prototype, "open").mockImplementation(function (
      this: RolloutStore,
      ref,
      signal,
    ) {
      opened.push(ref.sourcePath);
      return original.call(this, ref, signal);
    });
    const f = await setup(options);
    try {
      expect(opened).toEqual([]);
      expect(
        (await f.runtime.repository.listSessions({ scope: "active" })).items.map(
          (entry) => entry.id,
        ),
      ).toEqual([ancestryThread]);
      const recent = await f.runtime.repository.getHistoryPage(ancestryThread, {
        anchor: { kind: "latest" },
      });
      expect(recent.turns.map((turn) => turn.turnId)).toEqual(["leaf-turn"]);
      expect(opened.every((path) => path === f.leafPath)).toBe(true);
      expect(recent.beforeCursor).not.toBeNull();
      const older = await f.runtime.repository.getHistoryPage(ancestryThread, {
        anchor: { kind: "before", cursor: recent.beforeCursor! },
      });
      expect(older.turns.map((turn) => turn.turnId)).toContain("base-turn");
      expect(JSON.stringify(older)).toContain("ANCESTOR_A");
      expect(JSON.stringify(older)).not.toContain("EXCLUDED_SUFFIX");
      expect(opened).toContain(f.basePath);
      expect(
        f.runtime.database.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.["count"],
      ).toBe(0);
      const target = await f.runtime.repository.getHistoryPage(ancestryThread, {
        anchor: { kind: "turn", turnId: "base-turn" },
      });
      expect(JSON.stringify(target)).toContain("ANCESTOR_A");
    } finally {
      spy.mockRestore();
      await f.close();
    }
  },
);

it("owns raw-only observation across concurrent idle selections and releases the inactive selection", async () => {
  const f = await setup();
  const events: ViewerInvalidation[] = [];
  let first = () => {};
  let second = () => {};
  try {
    first = f.runtime.repository.subscribe((event) => events.push(event), {
      threadId: ancestryThread,
    });
    second = f.runtime.repository.subscribe(() => {}, { threadId: ancestryThread });
    await f.runtime.repository.getHistoryPage(ancestryThread, { anchor: { kind: "latest" } });
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === "session.updated")).toBe(true),
    );
    first();
    events.length = 0;
    const remaining: ViewerInvalidation[] = [];
    const listen = f.runtime.bus.subscribe((event) => remaining.push(event));
    await appendFile(
      f.leafPath,
      jsonl(ancestryRecords(ancestryThread, "appended-turn", "AUTOMATIC_APPEND").slice(1)),
    );
    await vi.waitFor(
      () => expect(remaining.some((event) => event.type === "session.updated")).toBe(true),
      { timeout: 2500 },
    );
    expect(
      JSON.stringify(
        await f.runtime.repository.getHistoryPage(ancestryThread, { anchor: { kind: "latest" } }),
      ),
    ).toContain("AUTOMATIC_APPEND");
    second();
    remaining.length = 0;
    await appendFile(
      f.leafPath,
      jsonl(ancestryRecords(ancestryThread, "inactive-turn", "INACTIVE").slice(1)),
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(remaining.filter((event) => event.type === "session.updated")).toEqual([]);
    listen();
    expect(await readFile(f.leafPath, "utf8")).toContain("INACTIVE");
  } finally {
    first();
    second();
    await f.close();
  }
});

it.each(["missing", "cycle", "invalid-cutoff"])(
  "keeps %s ancestry explicitly unresolved through public target requests",
  async (condition) => {
    const f = await setup();
    try {
      if (condition === "missing") {
        await rm(f.basePath);
      }
      if (condition === "cycle") {
        f.baseRecords[0]!.payload["history_base"] = {
          thread_id: ancestryLeafPhysical,
          end_ordinal_exclusive: 1,
          end_byte_offset: 1,
        };
        await writeFile(f.basePath, jsonl(f.baseRecords));
      }
      if (condition === "invalid-cutoff") {
        const bound = f.leafRecords[0]!.payload["history_base"];
        if (
          !bound ||
          typeof bound !== "object" ||
          !("end_byte_offset" in bound) ||
          typeof bound.end_byte_offset !== "number"
        ) {
          throw new Error("Expected supplied cutoff fixture");
        }
        bound.end_byte_offset += 1;
        await writeFile(f.leafPath, jsonl(f.leafRecords));
      }
      const page = await f.runtime.repository.getHistoryPage(ancestryThread, {
        anchor: { kind: "turn", turnId: "leaf-turn" },
      });
      expect(page.coverage.status).toBe("unresolved");
      expect(JSON.stringify(page.coverage)).toContain(
        condition === "missing"
          ? "lineage.missing_base"
          : condition === "cycle"
            ? "lineage.cycle"
            : "lineage.unverified_boundary",
      );
      expect(page.turns.map((turn) => turn.turnId)).not.toContain("base-turn");
    } finally {
      await f.close();
    }
  },
);

it("cancels public older ancestry preparation and releases the actual decoded ancestor lease", async () => {
  const f = await setup({ compressed: true });
  const original = RolloutStore.prototype.open;
  const before = await readFile(f.basePath);
  const recent = await f.runtime.repository.getHistoryPage(ancestryThread, {
    anchor: { kind: "latest" },
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const spy = vi.spyOn(RolloutStore.prototype, "open").mockImplementation(async function (
    this: RolloutStore,
    ref,
    signal,
  ) {
    const lease = await original.call(this, ref, signal);
    if (ref.sourcePath !== f.basePath) {
      return lease;
    }
    entered();
    try {
      await new Promise<void>((_resolve, reject) => {
        signal?.throwIfAborted();
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return lease;
    } finally {
      await lease.close();
    }
  });
  const abort = new AbortController();
  try {
    const read = f.runtime.repository.getHistoryPage(
      ancestryThread,
      { anchor: { kind: "before", cursor: recent.beforeCursor! } },
      { signal: abort.signal },
    );
    const rejected = read.catch((error: unknown) => error);
    await started;
    abort.abort();
    expect(await rejected).toMatchObject({ name: "AbortError" });
    expect(await readFile(f.basePath)).toEqual(before);
  } finally {
    abort.abort();
    spy.mockRestore();
    await f.close();
  }
});
