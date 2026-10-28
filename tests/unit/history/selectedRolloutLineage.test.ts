import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { expect, it, vi } from "vitest";

import { HistoryEpochAuthority } from "../../../server/history/historyEpochAuthority.ts";
import { RolloutHistoryReader } from "../../../server/history/rolloutHistoryReader.ts";
import * as discovery from "../../../server/ingestion/discoverSources.ts";
import { RolloutStore } from "../../../server/ingestion/rolloutStream.ts";
import { resolveSelectedRolloutLineage } from "../../../server/ingestion/selectedRolloutLineage.ts";
import { fixtureRef, canonicalRecords } from "../../fixtures/history/nativeHistory.ts";
it("publishes a plain leaf without opening its unready compressed ancestor", async () => {
  const root = await mkdtemp(join(tmpdir(), "plain-leaf-"));
  const childPath = join(root, "child.jsonl");
  const parentPath = join(root, "parent.jsonl.zst");
  const base = {
    physicalRolloutId: "parent-physical",
    endOrdinalExclusive: 50,
    endByteOffset: 3 * 1024 * 1024,
  };
  const records = canonicalRecords();
  records.at(0)!.payload["history_base"] = {
    thread_id: base.physicalRolloutId,
    end_ordinal_exclusive: base.endOrdinalExclusive,
    end_byte_offset: base.endByteOffset,
  };
  await writeFile(childPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  await writeFile(parentPath, "unready compressed ancestor");
  const child = { ...fixtureRef(childPath), historyBase: base };
  const parent = {
    ...fixtureRef(parentPath, base.physicalRolloutId, "parent"),
    representation: "zstd-jsonl" as const,
  };
  const store = new RolloutStore({ cacheDirectory: join(root, "cache") });
  const open = vi.fn<typeof store.open>((ref, signal) => store.open(ref, signal));
  try {
    const lineage = await resolveSelectedRolloutLineage(child, [parent], undefined, { open });
    expect(lineage.status).toBe("unresolved");
    const reader = new RolloutHistoryReader({ open });
    const resolvedPage = await reader.read(lineage, { anchor: { kind: "latest" } });
    expect(resolvedPage.turns.at(0)!.context?.complete).toBe(false);
    const page = await reader.read(
      {
        status: "complete",
        historyEpoch: "known-lineage",
        diagnostics: [],
        segments: [
          {
            ref: parent,
            bodyStartOrdinal: 1,
            displayStartOrdinal: 1,
            endOrdinalExclusive: 50,
            endByteOffset: base.endByteOffset,
          },
          {
            ref: child,
            bodyStartOrdinal: 51,
            displayStartOrdinal: 51,
            endOrdinalExclusive: null,
            endByteOffset: null,
          },
        ],
      },
      { anchor: { kind: "latest" } },
    );
    expect(page.turns.at(0)!.items.at(-1)!.item).toMatchObject({ text: "answer A" });
    expect(page.coverage.status).toBe("unresolved");
    expect(page.turns.at(0)!.context?.complete).toBe(false);
    expect(page.turns.at(0)!.itemsView).toBe("summary");
    expect(open.mock.calls.every(([ref]) => ref.sourcePath === childPath)).toBe(true);
    const metadata =
      JSON.stringify({ type: "session_meta", payload: { id: "parent", session_id: "root" } }) +
      "\n";
    const emptyContext =
      JSON.stringify({ type: "turn_context", payload: { model: "parent-model", padding: "" } }) +
      "\n";
    const padding =
      base.endByteOffset - Buffer.byteLength(metadata) - 49 * Buffer.byteLength(emptyContext);
    const parentRecords = Array.from(
      { length: 49 },
      (_, index) =>
        JSON.stringify({
          type: "turn_context",
          payload: {
            model: "parent-model",
            padding: "x".repeat(Math.floor(padding / 49) + (index === 48 ? padding % 49 : 0)),
          },
        }) + "\n",
    );
    const parentBytes = Buffer.from(metadata + parentRecords.join(""));
    expect(parentBytes.length).toBe(base.endByteOffset);
    await writeFile(parentPath, zstdCompressSync(parentBytes));
    const prepared = await resolveSelectedRolloutLineage(child, [parent], undefined, {
      open,
      prepareCompressedAncestors: true,
    });
    expect(prepared.status).toBe("complete");
    expect(prepared.segments.at(0)!.endOrdinalExclusive).toBe(50);
    expect(open.mock.calls.some(([ref]) => ref.sourcePath === parentPath)).toBe(true);
    const epochs = new HistoryEpochAuthority();
    const sharedReader = new RolloutHistoryReader({ open, epochAuthority: epochs });
    const qualified = await sharedReader.read(prepared, {
      anchor: { kind: "turn", turnId: "turn" },
    });
    expect(qualified.turns.at(0)!.items.at(-1)!.item).toMatchObject({ text: "answer A" });
    await writeFile(parentPath, "unready again");
    open.mockClear();
    const pending = await sharedReader.read(prepared, { anchor: { kind: "latest" } });
    expect(pending.turns.at(0)!.items.at(-1)!.item).toMatchObject({ text: "answer A" });
    expect(pending.stale).toBe(true);
    expect(pending.historyEpoch).toBe(qualified.historyEpoch);
    expect(pending.coverage.status).toBe("unresolved");
    expect(pending.beforeCursor).toBeNull();
    expect(pending.turns.at(0)!.beforeCursor).toBeNull();
    expect(open.mock.calls.every(([ref]) => ref.sourcePath === childPath)).toBe(true);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("uses only selected and known ancestor references, preserving unproved ancestry without tree discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "selected-lineage-"));
  const path = join(root, "child.jsonl");
  const source = fixtureRef(path, "child", "stable");
  const base = { thread_id: "unknown-parent", end_ordinal_exclusive: 50, end_byte_offset: 2048 };
  await writeFile(
    path,
    JSON.stringify({
      type: "session_meta",
      payload: { id: "stable", session_id: "root", history_base: base },
    }) + "\n",
  );
  const store = new RolloutStore({ cacheDirectory: join(root, "cache") });
  const discover = vi.spyOn(discovery, "discoverSources");
  try {
    const lineage = await resolveSelectedRolloutLineage(source, [], undefined, {
      open: (ref, signal) => store.open(ref, signal),
    });
    expect(lineage.status).toBe("unresolved");
    expect(lineage.segments.at(0)!.bodyStartOrdinal).toBe(51);
    expect(lineage.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "lineage.missing_base",
    );
    expect(discover).not.toHaveBeenCalled();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
