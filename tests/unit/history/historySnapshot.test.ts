import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { readNativeHistoryPage } from "../../../server/history/nativeHistoryReader.ts";
import {
  HistorySnapshotManager,
  snapshotHistoryDatabase,
} from "../../../server/metadata/historySnapshot.ts";
import { historyFixture, fixtureLineage } from "../../fixtures/history/nativeHistory.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "history-snapshot-"));
  roots.push(root);
  return historyFixture(root);
}

describe("optional native snapshot acquisition", () => {
  it("validates only an owned immutable generation and leaves source bytes and sidecars untouched", async () => {
    const options = await fixture();
    const before = await readFile(options.sourceDatabase);
    const result = await snapshotHistoryDatabase(options);
    expect({ status: result.status, diagnostics: result.diagnostics }).toEqual({
      status: "created",
      diagnostics: [],
    });
    expect(result.snapshot?.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.snapshot?.capabilities).toMatchObject({
      supported: true,
      updatedAtOrdinal: true,
    });
    expect(await readFile(options.sourceDatabase)).toEqual(before);
    expect(
      (await readdir(dirname(options.sourceDatabase))).filter((name) =>
        name.startsWith("thread_history"),
      ),
    ).toEqual(["thread_history_1.sqlite"]);
  });

  it("returns immediate fallback while real worker validation runs and reuses a retained generation asynchronously", async () => {
    const options = await fixture();
    const manager = new HistorySnapshotManager(options);
    try {
      manager.requestRefresh();
      expect(manager.current()).toBeNull();
      let progressed = false;
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          progressed = true;
          resolve();
        }, 0),
      );
      expect(progressed).toBe(true);
      await manager.whenSettled();
      expect(manager.current()?.digest).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await manager.close();
    }
    await rm(options.sourceDatabase);
    const retained = new HistorySnapshotManager(options);
    try {
      retained.requestRefresh();
      expect(retained.current()).toBeNull();
      await retained.whenSettled();
      expect(retained.current()?.digest).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await retained.close();
    }
  });

  it("treats absent, corrupt and missing-index databases as unavailable rather than empty history", async () => {
    const options = await fixture();
    const database = new DatabaseSync(options.sourceDatabase);
    database.exec("DROP INDEX idx_thread_items_by_turn_page");
    database.close();
    expect((await snapshotHistoryDatabase(options)).snapshot).toBeNull();
    await writeFile(options.sourceDatabase, "not sqlite");
    expect((await snapshotHistoryDatabase(options)).status).toBe("unavailable");
    await rm(options.sourceDatabase);
    expect((await snapshotHistoryDatabase(options)).snapshot).toBeNull();
  });

  it("applies a copied WAL only in owned storage and rejects a corrupt retained generation", async () => {
    const options = await fixture();
    const source = new DatabaseSync(options.sourceDatabase);
    source.exec(
      "PRAGMA journal_mode=WAL; UPDATE thread_items SET item_json='{}' WHERE item_id='answer'",
    );
    try {
      const before = await readFile(options.sourceDatabase);
      const walBefore = await readFile(options.sourceWal);
      const snapshot = await snapshotHistoryDatabase(options);
      expect({ status: snapshot.status, diagnostics: snapshot.diagnostics }).toEqual({
        status: "created",
        diagnostics: [],
      });
      const owned = new DatabaseSync(snapshot.snapshot!.databasePath, { readOnly: true });
      try {
        expect(
          owned.prepare("SELECT item_json FROM thread_items WHERE item_id='answer'").get()?.[
            "item_json"
          ],
        ).toBe("{}");
      } finally {
        owned.close();
      }
      expect(await readFile(options.sourceDatabase)).toEqual(before);
      expect(await readFile(options.sourceWal)).toEqual(walBefore);
      await writeFile(snapshot.snapshot!.databasePath, "corrupt retained generation");
      expect((await snapshotHistoryDatabase(options, undefined, true)).status).toBe("unavailable");
    } finally {
      source.close();
    }
  });

  it("retires unused successful generations instead of accumulating complete history copies", async () => {
    const options = await fixture();
    const manager = new HistorySnapshotManager(options);
    try {
      manager.requestRefresh();
      await manager.whenSettled();
      const first = manager.current()!;
      manager.invalidate();
      manager.requestRefresh();
      await manager.whenSettled();
      const second = manager.current()!;
      expect(second.generationId).not.toBe(first.generationId);
      expect(await readdir(join(options.snapshotRoot, "generations"))).toEqual([
        second.generationId,
      ]);
    } finally {
      await manager.close();
    }
  });

  it("keeps an active reader's old immutable generation until its idempotent lease release", async () => {
    const options = await fixture();
    const manager = new HistorySnapshotManager(options);
    try {
      manager.requestRefresh();
      await manager.whenSettled();
      const old = manager.current()!;
      const lease = manager.acquire(old);
      expect(lease).not.toBeNull();
      manager.invalidate();
      manager.requestRefresh();
      await manager.whenSettled();
      const current = manager.current()!;
      expect(
        (await readdir(join(options.snapshotRoot, "generations"))).toSorted((a, b) =>
          a.localeCompare(b),
        ),
      ).toEqual([old.generationId, current.generationId].toSorted((a, b) => a.localeCompare(b)));
      expect(
        (
          await readNativeHistoryPage(
            fixtureLineage(options.ref),
            { anchor: { kind: "latest" } },
            old,
          )
        ).status,
      ).toBe("available");
      expect(manager.acquire(old)).toBeNull();
      lease!.release();
      lease!.release();
      await manager.whenSettled();
      expect(await readdir(join(options.snapshotRoot, "generations"))).toEqual([
        current.generationId,
      ]);
    } finally {
      await manager.close();
    }
  });

  it("retires a late acquisition without publishing it over the retained generation and cleans only owned abandoned staging", async () => {
    const options = await fixture();
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let fresh = 0;
    const manager = new HistorySnapshotManager(
      options,
      async (input, signal, retainOnly, acquisition) => {
        const result = await snapshotHistoryDatabase(input, signal, retainOnly, acquisition);
        if (!retainOnly && ++fresh === 2) {
          ready.resolve();
          await release.promise;
        }
        return result;
      },
    );
    try {
      manager.requestRefresh();
      await manager.whenSettled();
      const retained = manager.current()!;
      manager.invalidate();
      manager.requestRefresh();
      await ready.promise;
      expect(manager.current()?.generationId).toBe(retained.generationId);
      manager.invalidate();
      release.resolve();
      await manager.whenSettled();
      expect(manager.current()?.generationId).toBe(retained.generationId);
      expect(
        JSON.parse(await readFile(join(options.snapshotRoot, "current.json"), "utf8")),
      ).toMatchObject({ generationId: retained.generationId });
      expect(await readdir(join(options.snapshotRoot, "generations"))).toEqual([
        retained.generationId,
      ]);
      const abandoned = `.${randomUUID()}.tmp`;
      const guarded = randomUUID();
      await mkdir(join(options.snapshotRoot, "generations", abandoned));
      await writeFile(
        join(options.snapshotRoot, "generations", abandoned, "thread_history_1.sqlite"),
        "abandoned",
      );
      await mkdir(join(options.snapshotRoot, "generations", guarded));
      await link(
        options.sourceDatabase,
        join(options.snapshotRoot, "generations", guarded, "thread_history_1.sqlite"),
      );
      const sourceBefore = await readFile(options.sourceDatabase);
      manager.requestRefresh();
      await manager.whenSettled();
      expect(await readFile(options.sourceDatabase)).toEqual(sourceBefore);
      expect(
        (await readdir(join(options.snapshotRoot, "generations"))).toSorted((a, b) =>
          a.localeCompare(b),
        ),
      ).toEqual([guarded, retained.generationId].toSorted((a, b) => a.localeCompare(b)));
    } finally {
      release.resolve();
      await manager.close();
    }
  });
});
