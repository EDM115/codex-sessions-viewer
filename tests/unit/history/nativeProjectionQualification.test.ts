import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openCacheDatabase } from "../../../server/cache/database.ts";
import { HistoryEpochAuthority } from "../../../server/history/historyEpochAuthority.ts";
import {
  decodeNativeHistoryCursor,
  readNativeHistoryPage,
  readNativeTurnItems,
} from "../../../server/history/nativeHistoryReader.ts";
import {
  qualifyNativeProjection,
  VerifiedProjectionStore,
} from "../../../server/history/nativeProjectionQualification.ts";
import { RolloutHistoryReader } from "../../../server/history/rolloutHistoryReader.ts";
import { RolloutStore } from "../../../server/ingestion/rolloutStream.ts";
import { validateSourceRanges } from "../../../server/ingestion/sourceGeneration.ts";
import * as historySnapshots from "../../../server/metadata/historySnapshot.ts";
import type { HistoryItemQuery, HistoryPageQuery } from "../../../shared/types/repository.ts";
import {
  addItem,
  addTurn,
  canonicalRecords,
  fixtureLineage,
  fixtureRef,
  historyFixture,
} from "../../fixtures/history/nativeHistory.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const { snapshotHistoryDatabase } = historySnapshots;
afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(mutate?: (database: DatabaseSync) => void) {
  const root = await mkdtemp(join(tmpdir(), "native-qualification-"));
  roots.push(root);
  const fixture = await historyFixture(root);
  if (mutate) {
    const db = new DatabaseSync(fixture.sourceDatabase);
    try {
      mutate(db);
    } finally {
      db.close();
    }
  }
  const snapshot = await snapshotHistoryDatabase(fixture);
  expect(snapshot).toMatchObject({ status: "created", diagnostics: [] });
  const lineage = fixtureLineage(fixture.ref);
  const candidate = await readNativeHistoryPage(
    lineage,
    { anchor: { kind: "latest" } },
    snapshot.snapshot!,
  );
  const database = openCacheDatabase(":memory:");
  databases.push(database);
  const store = new VerifiedProjectionStore(database);
  const generation = async () =>
    (
      await validateSourceRanges(fixture.ref, [
        { start: 0, endExclusive: (await stat(fixture.rollout)).size },
      ])
    ).generation;
  return { ...fixture, lineage, candidate, database, store, generation };
}

async function continuationFixture() {
  const fixture = await setup();
  const records = canonicalRecords().slice(0, 1);
  const db = new DatabaseSync(fixture.sourceDatabase);
  db.exec("BEGIN; DELETE FROM thread_items; DELETE FROM thread_turns");
  for (let index = 1; index <= 6; index += 1) {
    const turnId = `t-${index}`;
    const started = records.length;
    records.push({
      type: "event_msg",
      payload: { type: "turn_started", turn_id: turnId, started_at: 100 },
    });
    addTurn(db, "physical", turnId, started, null);
    const userOrdinal = records.length;
    records.push({
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: turnId,
        item: {
          type: "UserMessage",
          id: "user",
          content: [{ type: "text", text: `question ${index}` }],
        },
      },
    });
    addItem(
      db,
      "user",
      userOrdinal,
      { type: "userMessage", id: "user", content: [{ type: "text", text: `question ${index}` }] },
      "physical",
      turnId,
    );
    if (index === 6) {
      for (let item = 1; item <= 103; item += 1) {
        const ordinal = records.length;
        records.push({
          type: "event_msg",
          payload: {
            type: "item_completed",
            turn_id: turnId,
            item: {
              type: "AgentMessage",
              id: `a-${item}`,
              content: [{ type: "Text", text: `tail ${item}` }],
            },
          },
        });
        addItem(
          db,
          `a-${item}`,
          ordinal,
          { type: "agentMessage", id: `a-${item}`, text: `tail ${item}` },
          "physical",
          turnId,
        );
      }
    }
    const answerOrdinal = records.length;
    records.push({
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: turnId,
        item: {
          type: "AgentMessage",
          id: "answer",
          content: [{ type: "Text", text: `answer ${index}` }],
          phase: "final_answer",
        },
      },
    });
    addItem(
      db,
      "answer",
      answerOrdinal,
      { type: "agentMessage", id: "answer", text: `answer ${index}`, phase: "final_answer" },
      "physical",
      turnId,
    );
    const completed = records.length;
    records.push({
      type: "event_msg",
      payload: {
        type: "turn_complete",
        turn_id: turnId,
        started_at: 100,
        completed_at: 200,
        duration_ms: 100,
      },
    });
    db.prepare(
      "UPDATE thread_turns SET rollout_end_ordinal=? WHERE thread_id='physical' AND turn_id=?",
    ).run(completed, turnId);
  }
  const raw = records.map((row) => JSON.stringify(row)).join("\n") + "\n";
  db.prepare(
    "UPDATE thread_history_projection_state SET next_rollout_byte_offset=?,next_rollout_ordinal=?",
  ).run(Buffer.byteLength(raw), records.length);
  db.exec("COMMIT");
  db.close();
  await writeFile(fixture.rollout, raw);
  const snapshot = (await snapshotHistoryDatabase(fixture)).snapshot!;
  const candidate = await readNativeHistoryPage(
    fixture.lineage,
    { anchor: { kind: "latest" } },
    snapshot,
  );
  const issued = await qualifyNativeProjection(
    candidate,
    fixture.lineage,
    await fixture.generation(),
    fixture.store,
  );
  expect(issued.status).toBe("verified-range");
  return { ...fixture, records, raw, snapshot, issued };
}

async function appendContinuationFixture(fixture: Awaited<ReturnType<typeof continuationFixture>>) {
  const records = [...fixture.records];
  const updateOrdinal = records.length;
  records.push({
    type: "event_msg",
    payload: {
      type: "item_completed",
      turn_id: "t-6",
      item: { type: "AgentMessage", id: "a-2", content: [{ type: "Text", text: "updated tail" }] },
    },
  });
  const nextTurnStart = records.length;
  const appended = canonicalRecords("answer 7")
    .slice(1)
    .map((entry) =>
      Object.assign({}, entry, { payload: Object.assign({}, entry.payload, { turn_id: "t-7" }) }),
    );
  records.push(...appended);
  const raw = records.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(fixture.rollout, raw);
  const db = new DatabaseSync(fixture.sourceDatabase);
  db.exec("BEGIN");
  db.prepare(
    "UPDATE thread_items SET item_json=?,updated_at_ordinal=? WHERE thread_id='physical' AND turn_id='t-6' AND item_id='a-2'",
  ).run(JSON.stringify({ type: "agentMessage", id: "a-2", text: "updated tail" }), updateOrdinal);
  addTurn(db, "physical", "t-7", nextTurnStart, nextTurnStart + 3);
  addItem(
    db,
    "user",
    nextTurnStart + 1,
    { type: "userMessage", id: "user", content: [{ type: "text", text: "question" }] },
    "physical",
    "t-7",
  );
  addItem(
    db,
    "answer",
    nextTurnStart + 2,
    { type: "agentMessage", id: "answer", text: "answer 7", phase: "final_answer" },
    "physical",
    "t-7",
  );
  db.prepare(
    "UPDATE thread_history_projection_state SET next_rollout_byte_offset=?,next_rollout_ordinal=?",
  ).run(Buffer.byteLength(raw), records.length);
  db.exec("COMMIT");
  db.close();
}

describe("source to projection qualification", () => {
  it("keeps one verified semantic epoch across raw to native to raw handoff", async () => {
    const f = await setup();
    const epochs = new HistoryEpochAuthority();
    const rollouts = new RolloutStore({ cacheDirectory: join(f.snapshotRoot, "decoded") });
    const raw = new RolloutHistoryReader({
      open: (ref, signal) => rollouts.open(ref, signal),
      epochAuthority: epochs,
    });
    try {
      const first = await raw.read(f.lineage, { anchor: { kind: "latest" } });
      const native = await qualifyNativeProjection(
        f.candidate,
        f.lineage,
        await f.generation(),
        new VerifiedProjectionStore(f.database, { epochAuthority: epochs }),
      );
      expect(native.status).toBe("verified-range");
      expect(native.historyEpoch).toBe(first.historyEpoch);
      const again = await raw.read(f.lineage, { anchor: { kind: "latest" } });
      expect(again.historyEpoch).toBe(native.historyEpoch);
      await writeFile(f.rollout, f.raw.replace("answer A", "answer B"));
      const changed = await raw.read(f.lineage, { anchor: { kind: "latest" } });
      expect(changed.historyEpoch).not.toBe(first.historyEpoch);
      const rejected = await qualifyNativeProjection(
        f.candidate,
        f.lineage,
        await f.generation(),
        new VerifiedProjectionStore(f.database, { epochAuthority: epochs }),
      );
      expect(rejected.status).toBe("stale");
      expect(epochs.begin(f.lineage).previous?.epoch).toBe(changed.historyEpoch);
    } finally {
      await rollouts.close();
    }
  });
  it("shares the same issued epoch for concurrent cold native publications through one authority", async () => {
    const f = await setup();
    const epochs = new HistoryEpochAuthority();
    const store = new VerifiedProjectionStore(f.database, { epochAuthority: epochs });
    const generation = await f.generation();
    const results = await Promise.all([
      qualifyNativeProjection(f.candidate, f.lineage, generation, store),
      qualifyNativeProjection(f.candidate, f.lineage, generation, store),
    ]);
    expect(results.map((result) => result.status)).toEqual(["verified-range", "verified-range"]);
    expect(new Set(results.map((result) => result.historyEpoch)).size).toBe(1);
    expect(epochs.begin(f.lineage).previous?.epoch).toBe(results.at(0)!.historyEpoch);
  });
  it.each(["different", "duplicate"] as const)(
    "publishes one cold-store semantic epoch for gated concurrent %s queries and preserves every issued cursor",
    async (kind) => {
      const fixture = await continuationFixture();
      const coldDatabase = openCacheDatabase(":memory:");
      databases.push(coldDatabase);
      const store = new VerifiedProjectionStore(coldDatabase);
      expect(
        coldDatabase.prepare("SELECT count(*) AS count FROM verified_history_projections").get(),
      ).toEqual({ count: 0 });
      const source = await fixture.generation();
      const firstCandidate = await readNativeHistoryPage(
        fixture.lineage,
        { anchor: { kind: "latest" } },
        fixture.snapshot,
      );
      const secondSnapshot = structuredClone(fixture.snapshot);
      const secondCandidate = await readNativeHistoryPage(
        fixture.lineage,
        kind === "different"
          ? { anchor: { kind: "turn", turnId: "t-6" } }
          : { anchor: { kind: "latest" } },
        secondSnapshot,
      );
      const firstFence = Promise.withResolvers<void>();
      const secondFence = Promise.withResolvers<void>();
      const bothAtFence = Promise.withResolvers<void>();
      const gatedSnapshots = new Map([
        [firstCandidate.snapshot, firstFence],
        [secondCandidate.snapshot, secondFence],
      ]);
      const arrivals = new Set<object>();
      const unchanged = historySnapshots.historySnapshotUnchanged;
      const fence = vi
        .spyOn(historySnapshots, "historySnapshotUnchanged")
        .mockImplementation(async (snapshot) => {
          const result = await unchanged(snapshot);
          const gate = gatedSnapshots.get(snapshot);
          if (gate) {
            arrivals.add(snapshot);
            if (arrivals.size === 2) {
              bothAtFence.resolve();
            }
            await gate.promise;
          }
          return result;
        });
      const firstWork = qualifyNativeProjection(firstCandidate, fixture.lineage, source, store);
      const secondWork = qualifyNativeProjection(secondCandidate, fixture.lineage, source, store);
      try {
        await Promise.race([
          bothAtFence.promise,
          Promise.all([firstWork, secondWork]).then(() => {
            throw new Error("Qualifications did not reach both publication fences");
          }),
        ]);
        firstFence.resolve();
        const first = await firstWork;
        secondFence.resolve();
        const second = await secondWork;
        fence.mockRestore();
        expect([first.status, second.status]).toEqual(["verified-range", "verified-range"]);
        const queries: (HistoryPageQuery | HistoryItemQuery)[] = [];
        for (const issued of [first, second]) {
          expect(issued.page?.beforeCursor).toBeTruthy();
          expect(issued.page?.turns.at(-1)?.beforeCursor).toBeTruthy();
          if (!issued.page) {
            throw new Error("Missing verified concurrent page");
          }
          if (issued.page.beforeCursor) {
            queries.push({ anchor: { kind: "before", cursor: issued.page.beforeCursor } });
          }
          if (issued.page.afterCursor) {
            queries.push({ anchor: { kind: "after", cursor: issued.page.afterCursor } });
          }
          for (const turn of issued.page.turns) {
            if (turn.beforeCursor) {
              queries.push({
                turnId: turn.turnId,
                anchor: { kind: "before", cursor: turn.beforeCursor },
                limit: 3,
              });
            }
            if (turn.afterCursor) {
              queries.push({
                turnId: turn.turnId,
                anchor: { kind: "after", cursor: turn.afterCursor },
                limit: 3,
              });
            }
          }
        }
        const continuations = await Promise.all(
          queries.map(async (query) => {
            const candidate =
              "turnId" in query
                ? await readNativeTurnItems(fixture.lineage, query, fixture.snapshot)
                : await readNativeHistoryPage(fixture.lineage, query, fixture.snapshot);
            const result = await qualifyNativeProjection(candidate, fixture.lineage, source, store);
            return {
              status: result.status,
              diagnostics: result.diagnostics,
              sameEpoch: result.historyEpoch === first.historyEpoch,
            };
          }),
        );
        expect({ sameEpoch: first.historyEpoch === second.historyEpoch, continuations }).toEqual({
          sameEpoch: true,
          continuations: queries.map(() => ({
            status: "verified-range",
            diagnostics: [],
            sameEpoch: true,
          })),
        });
      } finally {
        firstFence.resolve();
        secondFence.resolve();
        await Promise.allSettled([firstWork, secondWork]);
        fence.mockRestore();
      }
    },
  );
  it.each(["turns", "items"] as const)(
    "rejects an issued qualified %s cursor after a same-size dependency rewrite outside the requested page",
    async (kind) => {
      const fixture = await continuationFixture();
      const cursor =
        kind === "turns"
          ? fixture.issued.page!.beforeCursor!
          : fixture.issued.page!.turns.at(-1)!.beforeCursor!;
      const before = await stat(fixture.rollout);
      await writeFile(fixture.rollout, fixture.raw.replace("answer 4", "rewrite4"));
      await utimes(fixture.rollout, before.atime, before.mtime);
      expect((await stat(fixture.rollout)).size).toBe(before.size);
      const db = new DatabaseSync(fixture.sourceDatabase);
      db.prepare(
        "UPDATE thread_items SET item_json=? WHERE thread_id='physical' AND turn_id='t-4' AND item_id='answer'",
      ).run(
        JSON.stringify({
          type: "agentMessage",
          id: "answer",
          text: "rewrite4",
          phase: "final_answer",
        }),
      );
      db.close();
      const snapshot = (await snapshotHistoryDatabase(fixture)).snapshot!;
      const candidate =
        kind === "turns"
          ? await readNativeHistoryPage(
              fixture.lineage,
              { anchor: { kind: "before", cursor } },
              snapshot,
            )
          : await readNativeTurnItems(
              fixture.lineage,
              { turnId: "t-6", anchor: { kind: "before", cursor }, limit: 3 },
              snapshot,
            );
      const result = await qualifyNativeProjection(
        candidate,
        fixture.lineage,
        await fixture.generation(),
        fixture.store,
      );
      expect(result.status).toBe("stale");
      expect(result.page).toBeNull();
      expect(result.diagnostics).toContain("native.cursor_dependencies_changed");
    },
  );

  it("rejects current native rows that failed to reconcile a new suffix update even when an issued cursor prefix still matches", async () => {
    const fixture = await continuationFixture();
    const cursor = fixture.issued.page!.turns.at(-1)!.beforeCursor!;
    await appendContinuationFixture(fixture);
    const db = new DatabaseSync(fixture.sourceDatabase);
    db.prepare(
      "UPDATE thread_items SET item_json=?,updated_at_ordinal=rollout_ordinal WHERE thread_id='physical' AND turn_id='t-6' AND item_id='a-2'",
    ).run(JSON.stringify({ type: "agentMessage", id: "a-2", text: "tail 2" }));
    db.close();
    const snapshot = (await snapshotHistoryDatabase(fixture)).snapshot!;
    const candidate = await readNativeTurnItems(
      fixture.lineage,
      { turnId: "t-6", anchor: { kind: "before", cursor }, limit: 3 },
      snapshot,
    );
    const result = await qualifyNativeProjection(
      candidate,
      fixture.lineage,
      await fixture.generation(),
      fixture.store,
    );
    expect(result.status).toBe("stale");
    expect(result.page).toBeNull();
    expect(result.diagnostics).toContain("native.item_payload_mismatch");
  });

  it.each(["epoch", "dependency", "ordinal"] as const)(
    "rejects a tampered qualified cursor %s instead of trusting same-thread token fields",
    async (field) => {
      const fixture = await continuationFixture();
      const issued = decodeNativeHistoryCursor(fixture.issued.page!.beforeCursor!);
      const changed =
        field === "epoch"
          ? { ...issued, epoch: "unissued-epoch" }
          : field === "dependency"
            ? { ...issued, dependency: "0".repeat(64) }
            : { ...issued, ordinal: 1 };
      const cursor = Buffer.from(JSON.stringify(changed)).toString("base64url");
      const candidate = await readNativeHistoryPage(
        fixture.lineage,
        { anchor: { kind: "before", cursor } },
        fixture.snapshot,
      );
      const result = await qualifyNativeProjection(
        candidate,
        fixture.lineage,
        await fixture.generation(),
        fixture.store,
      );
      expect(result.status).toBe("stale");
      expect(result.diagnostics).toContain("native.cursor_association_mismatch");
    },
  );
  it.each([
    ["unrelated", "turns"],
    ["unrelated", "items"],
    ["append", "turns"],
    ["append", "items"],
  ] as const)(
    "consumes an issued qualified %s-refresh %s cursor with the same semantic epoch",
    async (change, kind) => {
      const fixture = await continuationFixture();
      const cursor =
        kind === "turns"
          ? fixture.issued.page!.beforeCursor!
          : fixture.issued.page!.turns.at(-1)!.beforeCursor!;
      if (change === "append") {
        await appendContinuationFixture(fixture);
      } else {
        const db = new DatabaseSync(fixture.sourceDatabase);
        addTurn(db, "unrelated-physical", "unrelated-turn", 1, null);
        db.close();
      }
      const snapshot = (await snapshotHistoryDatabase(fixture)).snapshot!;
      expect(snapshot.digest).not.toBe(fixture.snapshot.digest);
      const candidate =
        kind === "turns"
          ? await readNativeHistoryPage(
              fixture.lineage,
              { anchor: { kind: "before", cursor } },
              snapshot,
            )
          : await readNativeTurnItems(
              fixture.lineage,
              { turnId: "t-6", anchor: { kind: "before", cursor }, limit: 3 },
              snapshot,
            );
      const result = await qualifyNativeProjection(
        candidate,
        fixture.lineage,
        await fixture.generation(),
        fixture.store,
      );
      expect({ status: result.status, diagnostics: result.diagnostics }).toEqual({
        status: "verified-range",
        diagnostics: [],
      });
      expect(result.historyEpoch).toBe(fixture.issued.historyEpoch);
      expect(decodeNativeHistoryCursor(cursor).epoch).toBe(fixture.issued.historyEpoch);
      expect(result.page?.turns.map((turn) => turn.turnId)).toEqual(
        kind === "turns" ? ["t-1"] : ["t-6"],
      );
      expect(result.page?.turns[0]?.items.map((item) => item.itemId)).toEqual(
        kind === "turns" ? ["user", "answer"] : ["a-2", "a-3", "a-4"],
      );
      expect(result.page?.turns[0]?.items[0]?.item).toMatchObject({
        text: kind === "turns" ? "question 1" : change === "append" ? "updated tail" : "tail 2",
      });
    },
  );
  it("establishes a real verified-range association for an assistant message with canonical memory citations", async () => {
    const entries = [{ path: "MEMORY.md", lineStart: 4, lineEnd: 8, note: "source evidence" }];
    const fixture = await setup((db) =>
      db.prepare("UPDATE thread_items SET item_json=? WHERE item_id='answer'").run(
        JSON.stringify({
          type: "agentMessage",
          id: "answer",
          text: "answer A",
          phase: "final_answer",
          memoryCitation: { entries, threadIds: ["original-rollout"] },
        }),
      ),
    );
    const records = canonicalRecords();
    const event = records[3];
    if (!event) {
      throw new Error("Missing cited-message fixture event");
    }
    event.payload["item"] = {
      type: "AgentMessage",
      id: "answer",
      content: [{ type: "Text", text: "answer A" }],
      phase: "final_answer",
      memory_citation: { entries, rolloutIds: ["original-rollout"] },
    };
    const raw = records.map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(fixture.rollout, raw);
    const db = new DatabaseSync(fixture.sourceDatabase);
    db.prepare("UPDATE thread_history_projection_state SET next_rollout_byte_offset=?").run(
      Buffer.byteLength(raw),
    );
    db.close();
    const snapshot = await snapshotHistoryDatabase(fixture);
    const candidate = await readNativeHistoryPage(
      fixture.lineage,
      { anchor: { kind: "latest" } },
      snapshot.snapshot!,
    );
    const result = await qualifyNativeProjection(
      candidate,
      fixture.lineage,
      await fixture.generation(),
      fixture.store,
    );
    expect({ status: result.status, diagnostics: result.diagnostics }).toEqual({
      status: "verified-range",
      diagnostics: [],
    });
    expect(result.page?.turns[0]?.items[1]?.item).toMatchObject({
      id: "answer",
      memoryCitation: { entries, threadIds: ["original-rollout"] },
    });
  });
  it("establishes and reuses a persisted association from actual canonical evidence without claiming whole history completeness", async () => {
    const fixture = await setup();
    const first = await qualifyNativeProjection(
      fixture.candidate,
      fixture.lineage,
      await fixture.generation(),
      fixture.store,
    );
    expect(first.status).toBe("verified-range");
    expect(first.association).toBe("established");
    expect(first.dependencies).toMatchObject([
      { physicalRolloutId: "physical", start: 0, endExclusive: Buffer.byteLength(fixture.raw) },
    ]);
    expect(first.page!.coverage.status).toBe("partial");
    expect(first.page!.coverage.total).toBeUndefined();
    const second = await qualifyNativeProjection(
      fixture.candidate,
      fixture.lineage,
      await fixture.generation(),
      new VerifiedProjectionStore(fixture.database),
    );
    expect(second.status).toBe("verified-range");
    expect(second.association).toBe("reused");
    expect(second.historyEpoch).toBe(first.historyEpoch);
  });

  it("rejects old native A after an equal-length equal-mtime rewrite to B even after a verified association existed", async () => {
    const fixture = await setup();
    expect(
      (
        await qualifyNativeProjection(
          fixture.candidate,
          fixture.lineage,
          await fixture.generation(),
          fixture.store,
        )
      ).status,
    ).toBe("verified-range");
    const before = await stat(fixture.rollout);
    await writeFile(fixture.rollout, fixture.raw.replace("answer A", "answer B"));
    await utimes(fixture.rollout, before.atime, before.mtime);
    expect((await stat(fixture.rollout)).size).toBe(before.size);
    const changed = await qualifyNativeProjection(
      fixture.candidate,
      fixture.lineage,
      await fixture.generation(),
      fixture.store,
    );
    expect(changed.status).toBe("stale");
    expect(changed.page).toBeNull();
  });

  it("does not mistake an established creation prefix for current authority after later updates", async () => {
    const fixture = await setup();
    const prefix = await fixture.generation();
    expect(
      (await qualifyNativeProjection(fixture.candidate, fixture.lineage, prefix, fixture.store))
        .status,
    ).toBe("verified-range");
    await writeFile(
      fixture.rollout,
      fixture.raw +
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "item_completed",
            turn_id: "turn",
            item: {
              type: "AgentMessage",
              id: "answer",
              content: [{ type: "Text", text: "late result" }],
            },
          },
        }) +
        "\n",
    );
    expect(
      (
        await qualifyNativeProjection(
          fixture.candidate,
          fixture.lineage,
          await fixture.generation(),
          fixture.store,
        )
      ).status,
    ).toBe("stale");
    expect(
      (await qualifyNativeProjection(fixture.candidate, fixture.lineage, prefix, fixture.store))
        .status,
    ).toBe("stale");
  });

  it("keeps advanced watermarks with skipped unknown canonical records projection-only", async () => {
    const fixture = await setup();
    const records = canonicalRecords();
    records.splice(3, 0, {
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn",
        item: { type: "FutureAction", id: "unsupported" },
      },
    });
    const raw = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await writeFile(fixture.rollout, raw);
    const db = new DatabaseSync(fixture.sourceDatabase);
    db.prepare(
      "UPDATE thread_history_projection_state SET next_rollout_byte_offset=?,next_rollout_ordinal=6",
    ).run(Buffer.byteLength(raw));
    db.prepare(
      "UPDATE thread_items SET rollout_ordinal=4,updated_at_ordinal=4 WHERE item_id='answer'",
    ).run();
    db.prepare("UPDATE thread_turns SET rollout_end_ordinal=5").run();
    db.close();
    const snapshot = await snapshotHistoryDatabase(fixture);
    const candidate = await readNativeHistoryPage(
      fixture.lineage,
      { anchor: { kind: "latest" } },
      snapshot.snapshot!,
    );
    const qualified = await qualifyNativeProjection(
      candidate,
      fixture.lineage,
      await fixture.generation(),
      fixture.store,
    );
    expect(qualified.status).toBe("projection-only");
    expect(qualified.diagnostics).toContain("native.unprojected_record");
  });

  it("refuses zero-watermark writers and does not attach independent state/source generations to a different physical projection", async () => {
    const fixture = await setup((database) =>
      database.exec(
        "UPDATE thread_history_projection_state SET next_rollout_ordinal=0,next_rollout_byte_offset=0; UPDATE thread_items SET updated_at_ordinal=0",
      ),
    );
    expect(
      (
        await qualifyNativeProjection(
          fixture.candidate,
          fixture.lineage,
          await fixture.generation(),
          fixture.store,
        )
      ).status,
    ).toBe("projection-only");
    const source = await fixture.generation();
    source.physicalRolloutId = "state-changed-physical";
    expect(
      (await qualifyNativeProjection(fixture.candidate, fixture.lineage, source, fixture.store))
        .status,
    ).toBe("stale");
  });

  it("validates proposed canonical evidence against real bytes and refuses invented ordinal anchors or missing suffix dependencies", async () => {
    const fixture = await setup();
    const sha256 = createHash("sha256").update(fixture.raw).digest("hex");
    const makeStore = (start: number, endExclusive: number, digest: string) =>
      new VerifiedProjectionStore(fixture.database, {
        canonicalEvidence: {
          async proposeRanges() {
            return [
              {
                physicalRolloutId: "physical",
                start,
                endExclusive,
                sha256: digest,
                startOrdinal: 0,
              },
            ];
          },
        },
      });
    expect(
      (
        await qualifyNativeProjection(
          fixture.candidate,
          fixture.lineage,
          await fixture.generation(),
          makeStore(0, Buffer.byteLength(fixture.raw), sha256),
        )
      ).status,
    ).toBe("verified-range");
    expect(
      (
        await qualifyNativeProjection(
          fixture.candidate,
          fixture.lineage,
          await fixture.generation(),
          makeStore(0, Buffer.byteLength(fixture.raw), "0".repeat(64)),
        )
      ).status,
    ).toBe("stale");
    expect(
      (
        await qualifyNativeProjection(
          fixture.candidate,
          fixture.lineage,
          await fixture.generation(),
          makeStore(50, Buffer.byteLength(fixture.raw), sha256),
        )
      ).status,
    ).toBe("projection-only");
    expect(
      (
        await qualifyNativeProjection(
          fixture.candidate,
          fixture.lineage,
          await fixture.generation(),
          makeStore(0, 100, sha256),
        )
      ).status,
    ).toBe("stale");
  });

  it("selects fallback without scanning a large source to establish provenance", async () => {
    const fixture = await setup();
    await writeFile(fixture.rollout, fixture.raw + "x".repeat(2 * 1024 * 1024));
    const source = (await validateSourceRanges(fixture.ref, [{ start: 0, endExclusive: 20 }]))
      .generation;
    const result = await qualifyNativeProjection(
      fixture.candidate,
      fixture.lineage,
      source,
      fixture.store,
    );
    expect(result.status).toBe("projection-only");
    expect(result.diagnostics).toContain("native.verification_budget");
    expect(result.dependencies).toEqual([]);
  });

  it("refetches changed existing items by their update ordinal and preserves the semantic epoch for a verified append", async () => {
    const fixture = await setup();
    const first = await qualifyNativeProjection(
      fixture.candidate,
      fixture.lineage,
      await fixture.generation(),
      fixture.store,
    );
    expect(first.status).toBe("verified-range");
    const raw =
      fixture.raw +
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn",
          item: {
            type: "AgentMessage",
            id: "answer",
            content: [{ type: "Text", text: "new output" }],
            phase: "final_answer",
          },
          completed_at_ms: 0,
        },
      }) +
      "\n";
    await writeFile(fixture.rollout, raw);
    const db = new DatabaseSync(fixture.sourceDatabase);
    db.prepare(
      "UPDATE thread_items SET item_json=?,updated_at_ordinal=5 WHERE item_id='answer'",
    ).run(
      JSON.stringify({
        type: "agentMessage",
        id: "answer",
        text: "new output",
        phase: "final_answer",
      }),
    );
    db.prepare(
      "UPDATE thread_history_projection_state SET next_rollout_ordinal=6,next_rollout_byte_offset=?",
    ).run(Buffer.byteLength(raw));
    db.close();
    const snapshot = await snapshotHistoryDatabase(fixture);
    const candidate = await readNativeHistoryPage(
      fixture.lineage,
      { anchor: { kind: "latest" } },
      snapshot.snapshot!,
    );
    const next = await qualifyNativeProjection(
      candidate,
      fixture.lineage,
      await fixture.generation(),
      fixture.store,
    );
    expect(next.status).toBe("verified-range");
    expect(next.page?.turns[0]?.items[1]).toMatchObject({
      ordinal: 3,
      updatedAtOrdinal: 5,
      decodedByteStart: Buffer.byteLength(fixture.raw.split("\n").slice(0, 3).join("\n") + "\n"),
      decodedByteEnd: Buffer.byteLength(fixture.raw.split("\n").slice(0, 4).join("\n") + "\n"),
      updatedAtDecodedByte: Buffer.byteLength(fixture.raw),
      item: { text: "new output" },
    });
    expect(next.historyEpoch).toBe(first.historyEpoch);
  });

  it("qualifies nonzero-base physical metadata ordinals and invalidates an equal-size ancestor rewrite", async () => {
    const fixture = await setup();
    const childPath = join(roots.at(-1)!, "child.jsonl");
    const childRef = fixtureRef(childPath, "child", "child-stable");
    childRef.historyBase = {
      physicalRolloutId: "physical",
      endOrdinalExclusive: 5,
      endByteOffset: Buffer.byteLength(fixture.raw),
    };
    const childRecords = canonicalRecords("child output").map((value) => {
      const row = value;
      return row.type === "session_meta"
        ? {
            type: "session_meta",
            payload: {
              id: "child-stable",
              session_id: "root",
              history_base: {
                thread_id: "physical",
                end_ordinal_exclusive: 5,
                end_byte_offset: Buffer.byteLength(fixture.raw),
              },
            },
          }
        : Object.assign({}, row, {
            payload: Object.assign({}, row.payload, { turn_id: "child-turn" }),
          });
    });
    const childRaw = childRecords.map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(childPath, childRaw);
    const ancestorSegment = fixture.lineage.segments[0];
    if (!ancestorSegment) {
      throw new Error("Missing fixture ancestor segment");
    }
    ancestorSegment.endOrdinalExclusive = 5;
    ancestorSegment.endByteOffset = Buffer.byteLength(fixture.raw);
    fixture.lineage.segments.push({
      ref: childRef,
      bodyStartOrdinal: 6,
      displayStartOrdinal: 6,
      endOrdinalExclusive: null,
      endByteOffset: null,
    });
    const db = new DatabaseSync(fixture.sourceDatabase);
    addTurn(db, "child", "child-turn", 6, 9);
    addItem(
      db,
      "user",
      7,
      { type: "userMessage", id: "user", content: [{ type: "text", text: "question" }] },
      "child",
      "child-turn",
    );
    addItem(
      db,
      "answer",
      8,
      { type: "agentMessage", id: "answer", text: "child output", phase: "final_answer" },
      "child",
      "child-turn",
    );
    db.prepare("INSERT INTO thread_history_projection_state VALUES(?,?,?)").run(
      "child",
      Buffer.byteLength(childRaw),
      10,
    );
    db.close();
    const snapshot = await snapshotHistoryDatabase(fixture);
    const candidate = await readNativeHistoryPage(
      fixture.lineage,
      { anchor: { kind: "latest" } },
      snapshot.snapshot!,
    );
    const source = (
      await validateSourceRanges(childRef, [
        { start: 0, endExclusive: Buffer.byteLength(childRaw) },
      ])
    ).generation;
    const qualified = await qualifyNativeProjection(
      candidate,
      fixture.lineage,
      source,
      fixture.store,
    );
    expect({ status: qualified.status, diagnostics: qualified.diagnostics }).toEqual({
      status: "verified-range",
      diagnostics: [],
    });
    expect(
      qualified.dependencies.map((dependency) => [
        dependency.physicalRolloutId,
        dependency.nextOrdinal,
      ]),
    ).toEqual([
      ["physical", 5],
      ["child", 10],
    ]);
    expect(qualified.page?.turns.map((turn) => [turn.physicalRolloutId, turn.order])).toEqual([
      ["physical", 1],
      ["child", 6],
    ]);
    await writeFile(fixture.rollout, fixture.raw.replace("answer A", "answer B"));
    expect(
      (await qualifyNativeProjection(candidate, fixture.lineage, source, fixture.store)).status,
    ).toBe("stale");
  });
});
