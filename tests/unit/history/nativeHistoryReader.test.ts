import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { openCacheDatabase } from "#server/cache/database.ts";
import { readNativeHistoryPage, readNativeTurnItems } from "#server/history/nativeHistoryReader.ts";
import {
  qualifyNativeProjection,
  VerifiedProjectionStore,
} from "#server/history/nativeProjectionQualification.ts";
import { validateSourceRanges } from "#server/ingestion/sourceGeneration.ts";
import { snapshotHistoryDatabase } from "#server/metadata/historySnapshot.ts";

import {
  addItem,
  addTurn,
  fixtureLineage,
  fixtureRef,
  historyFixture,
} from "../../fixtures/history/nativeHistory.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(mutate?: (database: DatabaseSync) => void) {
  const root = await mkdtemp(join(tmpdir(), "native-history-"));
  roots.push(root);
  const fixture = await historyFixture(root);
  if (mutate) {
    const db = new DatabaseSync(fixture.sourceDatabase);
    try {
      db.exec("BEGIN");
      mutate(db);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  }
  const snapshot = await snapshotHistoryDatabase(fixture);
  expect(snapshot).toMatchObject({ status: "created", diagnostics: [] });
  return { ...fixture, snapshot: snapshot.snapshot!, lineage: fixtureLineage(fixture.ref) };
}

describe("bounded native history pages", () => {
  it("rejects changed lineage cutoffs and wrong thread/turn owners for actually issued qualified cursors", async () => {
    const fixture = await setup();
    const database = openCacheDatabase(":memory:");
    try {
      const store = new VerifiedProjectionStore(database);
      const source = (
        await validateSourceRanges(fixture.ref, [
          { start: 0, endExclusive: Buffer.byteLength(fixture.raw) },
        ])
      ).generation;
      const turns = await qualifyNativeProjection(
        await readNativeHistoryPage(
          fixture.lineage,
          { anchor: { kind: "turn", turnId: "turn" } },
          fixture.snapshot,
        ),
        fixture.lineage,
        source,
        store,
      );
      const items = await qualifyNativeProjection(
        await readNativeTurnItems(
          fixture.lineage,
          { turnId: "turn", anchor: { kind: "latest" }, limit: 1 },
          fixture.snapshot,
        ),
        fixture.lineage,
        source,
        store,
      );
      expect(turns.status).toBe("verified-range");
      expect(items.status).toBe("verified-range");
      const turnCursor = turns.page?.beforeCursor;
      const itemCursor = items.page?.turns[0]?.beforeCursor;
      if (!turnCursor || !itemCursor) {
        throw new Error("Expected issued turn and item cursors");
      }
      const changedCutoff = structuredClone(fixture.lineage);
      const changedOwner = structuredClone(fixture.lineage);
      const cutoffSegment = changedCutoff.segments[0];
      const ownerSegment = changedOwner.segments[0];
      if (!cutoffSegment || !ownerSegment) {
        throw new Error("Missing fixture segment");
      }
      cutoffSegment.endOrdinalExclusive = 5;
      cutoffSegment.endByteOffset = Buffer.byteLength(fixture.raw);
      ownerSegment.ref.stableThreadId = "different-stable-thread";
      await expect(
        readNativeHistoryPage(
          changedCutoff,
          { anchor: { kind: "before", cursor: turnCursor } },
          fixture.snapshot,
        ),
      ).rejects.toThrow(/cursor/iu);
      await expect(
        readNativeHistoryPage(
          changedOwner,
          { anchor: { kind: "before", cursor: turnCursor } },
          fixture.snapshot,
        ),
      ).rejects.toThrow(/cursor/iu);
      await expect(
        readNativeTurnItems(
          fixture.lineage,
          { turnId: "different-turn", anchor: { kind: "before", cursor: itemCursor } },
          fixture.snapshot,
        ),
      ).rejects.toThrow(/cursor/iu);
    } finally {
      database.close();
    }
  });
  it("joins physical IDs, renders chronological five-turn metadata and keeps a giant tail separate from its opening prompt", async () => {
    const fixture = await setup((db) => {
      for (let i = 1; i <= 7; i += 1) {
        addTurn(db, "physical", `turn-${i}`, i * 10000, null);
      }
      addItem(
        db,
        "prompt",
        70001,
        { type: "userMessage", id: "prompt", content: [{ type: "text", text: "opening prompt" }] },
        "physical",
        "turn-7",
      );
      for (let i = 2; i <= 1105; i += 1) {
        addItem(
          db,
          `a-${i}`,
          70000 + i,
          { type: "agentMessage", id: `a-${i}`, text: `message ${i}` },
          "physical",
          "turn-7",
        );
      }
      addTurn(db, "stable", "wrong-stable-id", 99000, null);
    });
    const result = await readNativeHistoryPage(
      fixture.lineage,
      { anchor: { kind: "latest" } },
      fixture.snapshot,
    );
    expect(result.status).toBe("available");
    expect(result.page!.turns.map((turn: { turnId: string }) => turn.turnId)).toEqual([
      "turn-3",
      "turn-4",
      "turn-5",
      "turn-6",
      "turn-7",
    ]);
    const latest = result.page!.turns.at(-1)!;
    expect(latest.items).toHaveLength(100);
    expect(latest.items[0]?.itemId).toBe("a-1006");
    expect(latest.items.at(-1)!.itemId).toBe("a-1105");
    expect(latest.opening.item).toMatchObject({ text: "opening prompt" });
    expect(latest.itemsView).toBe("summary");
    expect(latest.coverage.gaps.length).toBeGreaterThan(0);
    expect(latest.beforeCursor).not.toBeNull();
    expect(result.page!.coverage.total).toBeUndefined();
    expect(result.stats.payloadBytes).toBeLessThan(2 * 1024 * 1024);
    expect(
      result.stats.statements.every((statement: { rows: number }) => statement.rows <= 101),
    ).toBe(true);
    expect(
      result.stats.statements
        .filter((statement: { payloadBytes: number }) => statement.payloadBytes > 0)
        .every((statement: { sql: string }) => statement.sql.includes("LIMIT")),
    ).toBe(true);
    const older = await readNativeTurnItems(
      fixture.lineage,
      { turnId: "turn-7", anchor: { kind: "before", cursor: latest.beforeCursor! }, limit: 3 },
      fixture.snapshot,
    );
    expect(older.page!.turns[0]?.items.map((item: { itemId: string }) => item.itemId)).toEqual([
      "a-1003",
      "a-1004",
      "a-1005",
    ]);
    await expect(
      readNativeTurnItems(
        fixture.lineage,
        { turnId: "turn-6", anchor: { kind: "before", cursor: latest.beforeCursor! } },
        fixture.snapshot,
      ),
    ).rejects.toThrow(/cursor/iu);
  });

  it("suppresses ancestor turns and rejects payloads and terminal lifecycle updated beyond an inherited cutoff", async () => {
    const fixture = await setup((db) => {
      db.prepare("UPDATE thread_items SET updated_at_ordinal = 15 WHERE item_id = 'answer'").run();
      db.prepare("UPDATE thread_turns SET rollout_end_ordinal = 15").run();
      addTurn(db, "child", "new-turn", 20, null);
      addItem(
        db,
        "child-item",
        21,
        { type: "agentMessage", id: "child-item", text: "child" },
        "child",
        "new-turn",
      );
      addTurn(db, "child", "overridden", 22, null);
      addTurn(db, "physical", "overridden", 6, 7);
    });
    const ancestorSegment = fixture.lineage.segments[0];
    if (!ancestorSegment) {
      throw new Error("Missing fixture ancestor segment");
    }
    ancestorSegment.endOrdinalExclusive = 10;
    ancestorSegment.endByteOffset = 500;
    fixture.lineage.segments.push({
      ref: fixtureRef(fixture.rollout, "child", "child-stable"),
      bodyStartOrdinal: 11,
      displayStartOrdinal: 11,
      endOrdinalExclusive: null,
      endByteOffset: null,
    });
    const result = await readNativeHistoryPage(
      fixture.lineage,
      { anchor: { kind: "latest" } },
      fixture.snapshot,
    );
    expect(
      result.page!.turns.filter((turn: { turnId: string }) => turn.turnId === "overridden"),
    ).toHaveLength(1);
    expect(
      result.page!.turns.find((turn: { turnId: string }) => turn.turnId === "overridden")!
        .physicalRolloutId,
    ).toBe("child");
    const ancestor = result.page!.turns.find((turn: { turnId: string }) => turn.turnId === "turn")!;
    expect(ancestor.status).toBe("unknown");
    expect(ancestor.finalAnswerItemId).toBeNull();
    expect(
      ancestor.items.find((item: { itemId: string }) => item.itemId === "answer"),
    ).toMatchObject({ detail: "unsupported", item: null });
    expect(result.diagnostics).toContain("native.cutoff_update");
  });

  it("bounds selected payload bytes and preserves explicit unsupported detail for an oversized item", async () => {
    const fixture = await setup((db) => {
      db.prepare("UPDATE thread_items SET item_json = ? WHERE item_id = 'answer'").run(
        JSON.stringify({ type: "agentMessage", id: "answer", text: "x".repeat(300_000) }),
      );
    });
    const result = await readNativeHistoryPage(
      fixture.lineage,
      { anchor: { kind: "latest" } },
      fixture.snapshot,
    );
    expect(
      result.page!.turns[0]?.items.find((item: { itemId: string }) => item.itemId === "answer"),
    ).toMatchObject({ detail: "unsupported", item: null });
    expect(result.stats.payloadBytes).toBeLessThan(1000);
    expect(result.page!.coverage.status).toBe("partial");
  });

  it("rechecks owned snapshot changes and never returns unavailable as an empty complete page", async () => {
    const fixture = await setup();
    await rm(fixture.snapshot.databasePath);
    const result = await readNativeHistoryPage(
      fixture.lineage,
      { anchor: { kind: "latest" } },
      fixture.snapshot,
    );
    expect(result.status).toBe("unavailable");
    expect(result.page).toBeNull();
  });

  it("preserves unknown lifecycle states without inventing in-progress status", async () => {
    const fixture = await setup((db) => db.exec("UPDATE thread_turns SET status='future-status'"));
    const result = await readNativeHistoryPage(
      fixture.lineage,
      { anchor: { kind: "latest" } },
      fixture.snapshot,
    );
    expect(result.page?.turns[0]?.status).toBe("unknown");
  });

  it("continues opening reads past compaction markers and pages older turns without counting the full database", async () => {
    const fixture = await setup((db) => {
      db.exec("DELETE FROM thread_items; DELETE FROM thread_turns");
      for (let i = 1; i <= 27; i += 1) {
        addTurn(db, "physical", `t-${i}`, i * 10, null);
      }
      addItem(
        db,
        "compact-1",
        271,
        { type: "contextCompaction", id: "compact-1" },
        "physical",
        "t-27",
      );
      addItem(
        db,
        "compact-2",
        272,
        { type: "contextCompaction", id: "compact-2" },
        "physical",
        "t-27",
      );
      addItem(
        db,
        "user",
        273,
        { type: "userMessage", id: "user", content: [{ type: "text", text: "after compaction" }] },
        "physical",
        "t-27",
      );
    });
    const recent = await readNativeHistoryPage(
      fixture.lineage,
      { anchor: { kind: "latest" } },
      fixture.snapshot,
    );
    expect(recent.page?.turns.at(-1)?.opening.item).toMatchObject({
      type: "userMessage",
      text: "after compaction",
    });
    const older = await readNativeHistoryPage(
      fixture.lineage,
      { anchor: { kind: "before", cursor: recent.page!.beforeCursor! } },
      fixture.snapshot,
    );
    expect(older.page?.turns).toHaveLength(20);
    expect(older.page?.turns[0]?.turnId).toBe("t-3");
    expect(older.page?.turns.at(-1)?.turnId).toBe("t-22");
    expect(older.stats.statements.every((entry) => !/COUNT\(/iu.test(entry.sql))).toBe(true);
    expect(older.page?.beforeCursor).not.toBe(recent.page?.beforeCursor);
    const target = await readNativeHistoryPage(
      fixture.lineage,
      { anchor: { kind: "turn", turnId: "t-10" } },
      fixture.snapshot,
    );
    expect(target.page?.beforeCursor).toBeTruthy();
    expect(target.page?.afterCursor).toBeTruthy();
    const after = await readNativeHistoryPage(
      fixture.lineage,
      { anchor: { kind: "after", cursor: target.page!.afterCursor! }, limit: 2 },
      fixture.snapshot,
    );
    expect(after.page?.turns.map((turn) => turn.turnId)).toEqual(["t-11", "t-12"]);
  });

  it("reserves selected latest prompt and tail work before older large turns consume the payload budget", async () => {
    const fixture = await setup((db) => {
      addTurn(db, "physical", "large-old", 10, null);
      for (let i = 0; i < 12; i += 1) {
        addItem(
          db,
          `large-${i}`,
          11 + i,
          { type: "agentMessage", id: `large-${i}`, text: "x".repeat(240_000) },
          "physical",
          "large-old",
        );
      }
      addTurn(db, "physical", "selected-latest", 30, null);
      addItem(
        db,
        "selected-user",
        31,
        {
          type: "userMessage",
          id: "selected-user",
          content: [{ type: "text", text: "selected prompt" + "p".repeat(200_000) }],
        },
        "physical",
        "selected-latest",
      );
      addItem(
        db,
        "selected-answer",
        32,
        {
          type: "agentMessage",
          id: "selected-answer",
          text: "selected result" + "r".repeat(200_000),
        },
        "physical",
        "selected-latest",
      );
      for (let i = 0; i < 20; i += 1) {
        addItem(
          db,
          `selected-large-${i}`,
          40 + i,
          { type: "agentMessage", id: `selected-large-${i}`, text: "x".repeat(240_000) },
          "physical",
          "selected-latest",
        );
      }
      addItem(
        db,
        "selected-final",
        60,
        { type: "agentMessage", id: "selected-final", text: "final" + "r".repeat(200_000) },
        "physical",
        "selected-latest",
      );
    });
    const result = await readNativeHistoryPage(
      fixture.lineage,
      { anchor: { kind: "latest" } },
      fixture.snapshot,
    );
    expect(result.page?.turns.at(-1)?.opening.item).toMatchObject({ id: "selected-user" });
    expect(result.page?.turns.at(-1)?.items.at(-1)?.item).toMatchObject({ id: "selected-final" });
    expect(result.stats.payloadBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});
