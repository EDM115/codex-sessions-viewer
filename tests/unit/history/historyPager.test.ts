import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { openCacheDatabase } from "../../../server/cache/database.ts";
import { CanonicalRolloutIndex } from "../../../server/history/canonicalRolloutIndex.ts";
import { HistoryEpochAuthority } from "../../../server/history/historyEpochAuthority.ts";
import { HistoryPager } from "../../../server/history/historyPager.ts";
import { NativeHistoryService } from "../../../server/history/nativeHistoryService.ts";
import { RolloutHistoryReader } from "../../../server/history/rolloutHistoryReader.ts";
import { RolloutStore } from "../../../server/ingestion/rolloutStream.ts";
import * as sourceGeneration from "../../../server/ingestion/sourceGeneration.ts";
import { HistorySnapshotManager } from "../../../server/metadata/historySnapshot.ts";
import { mergeHistoryWindows } from "../../../shared/timeline/history.ts";
import {
  canonicalRecords,
  fixtureRef,
  historyFixture,
} from "../../fixtures/history/nativeHistory.ts";

describe("public progressive history pager", () => {
  it("requires receiving-reader bytes after restoring the persisted authority even when length and mtime match", async () => {
    const root = await mkdtemp(join(tmpdir(), "pager-restart-"));
    const path = join(root, "source.jsonl");
    const text =
      canonicalRecords()
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n";
    await writeFile(path, text);
    const info = await stat(path);
    const database = openCacheDatabase(":memory:");
    const store = new RolloutStore({ cacheDirectory: join(root, "decoded") });
    const options = {
      database,
      open: (ref: Parameters<RolloutStore["open"]>[0], signal?: AbortSignal) =>
        store.open(ref, signal),
    };
    const ref = fixtureRef(path);
    const initial = new HistoryPager(options);
    const old = await initial.read(ref, [ref], { anchor: { kind: "latest" } });
    await initial.close();
    await writeFile(path, text.replace("answer A", "answer B"));
    await utimes(path, info.atime, info.mtime);
    const restarted = new HistoryPager(options);
    try {
      const fresh = await restarted.read(ref, [ref], { anchor: { kind: "latest" } });
      expect(fresh.historyEpoch).not.toBe(old.historyEpoch);
      expect(fresh.turns[0]?.items.at(-1)?.item).toMatchObject({ text: "answer B" });
    } finally {
      await restarted.close();
      await store.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("detaches one cancelled subscriber without cancelling the shared selected reader", async () => {
    const root = await mkdtemp(join(tmpdir(), "pager-subscribers-"));
    const path = join(root, "source.jsonl");
    await writeFile(
      path,
      canonicalRecords()
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const database = openCacheDatabase(":memory:");
    const store = new RolloutStore({ cacheDirectory: join(root, "decoded") });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let firstSignal: AbortSignal | undefined;
    let opens = 0;
    const pager = new HistoryPager({
      database,
      open: async (ref, signal) => {
        opens += 1;
        firstSignal ??= signal;
        entered();
        await gate;
        signal?.throwIfAborted();
        return store.open(ref, signal);
      },
    });
    const ref = fixtureRef(path);
    const controller = new AbortController();
    try {
      const first = pager
        .read(ref, [ref], { anchor: { kind: "latest" } }, controller.signal)
        .catch((error: unknown) => error);
      const second = pager.read(ref, [ref], { anchor: { kind: "latest" } });
      await started;
      controller.abort();
      expect(await first).toBeInstanceOf(Error);
      expect(firstSignal?.aborted).toBe(false);
      expect(opens).toBe(1);
      release();
      expect((await second).turns[0]?.items.at(-1)?.itemId).toBe("answer");
    } finally {
      release();
      await pager.close();
      await store.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("recovers an actually issued native item boundary through freshly verified raw bytes after the native snapshot becomes unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "pager-switch-"));
    const fixture = await historyFixture(root);
    const database = openCacheDatabase(":memory:");
    const store = new RolloutStore({ cacheDirectory: join(root, "decoded") });
    const snapshots = new HistorySnapshotManager(fixture);
    const epochAuthority = new HistoryEpochAuthority();
    let available = true;
    const native = new NativeHistoryService(
      database,
      {
        current: () => (available ? snapshots.current() : null),
        acquire: (snapshot) => snapshots.acquire(snapshot),
        requestRefresh() {},
        invalidate() {},
        close: () => snapshots.close(),
      },
      { epochAuthority },
    );
    snapshots.requestRefresh();
    await snapshots.whenSettled();
    const pager = new HistoryPager({
      database,
      open: (ref, signal) => store.open(ref, signal),
      native,
      epochAuthority,
    });
    try {
      const rawRead = vi.spyOn(RolloutHistoryReader.prototype, "read");
      const rawItems = vi.spyOn(RolloutHistoryReader.prototype, "readItems");
      const nativeRead = vi.spyOn(native, "read");
      const firstPage = await pager.read(fixture.ref, [fixture.ref], {
        anchor: { kind: "latest" },
      });
      expect(firstPage.reviewEvidence).toBeUndefined();
      expect(rawRead).not.toHaveBeenCalled();
      expect(rawItems).not.toHaveBeenCalled();
      const latest = await pager.readItems(fixture.ref, [fixture.ref], {
        turnId: "turn",
        anchor: { kind: "latest" },
        limit: 1,
      });
      expect(latest.items.map((entry) => entry.itemId)).toEqual(["answer"]);
      expect(latest.beforeCursor).not.toBeNull();
      expect(latest.beforeCursor!.startsWith("raw-v1-")).toBe(false);
      expect(rawRead).not.toHaveBeenCalled();
      expect(rawItems).not.toHaveBeenCalled();
      const nativeCalls = nativeRead.mock.calls.length;
      const reviewPage = await pager.readRawEvidence(fixture.ref, [fixture.ref], {
        anchor: { kind: "latest" },
      });
      expect(rawRead).toHaveBeenCalledOnce();
      expect(nativeRead).toHaveBeenCalledTimes(nativeCalls);
      expect(reviewPage.reviewEvidence).toEqual({ availability: "complete", records: [] });
      available = false;
      const older = await pager.readItems(fixture.ref, [fixture.ref], {
        turnId: "turn",
        anchor: { kind: "before", cursor: latest.beforeCursor! },
        limit: 1,
      });
      expect(older.historyEpoch).toBe(latest.historyEpoch);
      expect(older.items.map((entry) => entry.itemId)).toEqual(["user"]);
      expect(mergeHistoryWindows([latest], [older])[0]?.items.map((entry) => entry.itemId)).toEqual(
        ["user", "answer"],
      );
      await expect(
        pager.readItems({ ...fixture.ref, stableThreadId: "other" }, [fixture.ref], {
          turnId: "turn",
          anchor: { kind: "before", cursor: latest.beforeCursor! },
          limit: 1,
        }),
      ).rejects.toThrow(/identity_mismatch|cursor_owner_mismatch/u);
    } finally {
      await pager.close();
      await native.close();
      await store.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("reads latest independently of complete history and persists sparse evidence without trusting it after replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "history-pager-"));
    const path = join(root, "source.jsonl");
    const records = canonicalRecords();
    records.splice(
      1,
      0,
      ...Array.from({ length: 15000 }, () => ({
        type: "turn_context",
        payload: { padding: "x".repeat(160) },
      })),
    );
    await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const database = openCacheDatabase(":memory:");
    const store = new RolloutStore({ cacheDirectory: join(root, "cache") });
    let bytes = 0;
    const pager = new HistoryPager({
      database,
      open: async (ref, signal) => {
        const lease = await store.open(ref, signal);
        return {
          ...lease,
          read: async (start, end, readSignal) => {
            bytes += end - start;
            return lease.read(start, end, readSignal);
          },
        };
      },
    });
    const ref = fixtureRef(path);
    const fullDigest = vi
      .spyOn(sourceGeneration, "validateSourceGeneration")
      .mockRejectedValue(new Error("Forbidden whole plain source digest"));
    const canonical = vi
      .spyOn(CanonicalRolloutIndex.prototype, "prepare")
      .mockRejectedValue(new Error("Forbidden canonical index preparation"));
    try {
      const page = await pager.read(ref, [ref], { anchor: { kind: "latest" }, limit: 5 });
      expect(page.turns.at(-1)?.items.map((item) => item.itemId)).toEqual(["user", "answer"]);
      expect(bytes).toBeLessThan(2 * 1024 * 1024);
      expect(page.coverage.total).toBeUndefined();
      expect(fullDigest).not.toHaveBeenCalled();
      expect(canonical).not.toHaveBeenCalled();
      expect(
        database.prepare("SELECT count(*) AS count FROM history_sparse_windows").get()?.["count"],
      ).toBe(1);
      const originalEpoch = page.historyEpoch;
      await writeFile(
        path,
        canonicalRecords("answer B")
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );
      const replacement = await pager.read(ref, [ref], { anchor: { kind: "latest" } });
      expect(replacement.historyEpoch).not.toBe(originalEpoch);
      expect(replacement.turns.at(-1)?.items.at(-1)?.item).toMatchObject({ text: "answer B" });
    } finally {
      fullDigest.mockRestore();
      canonical.mockRestore();
      await pager.close();
      await store.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
