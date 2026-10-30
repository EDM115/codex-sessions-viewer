import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openCacheDatabase } from "#server/cache/database.ts";
import { CanonicalRolloutIndex } from "#server/history/canonicalRolloutIndex.ts";
import { readNativeHistoryPage } from "#server/history/nativeHistoryReader.ts";
import {
  qualifyNativeProjection,
  VerifiedProjectionStore,
} from "#server/history/nativeProjectionQualification.ts";
import * as reads from "#server/ingestion/stableRead.ts";
import { snapshotHistoryDatabase } from "#server/metadata/historySnapshot.ts";

import {
  canonicalRecords,
  fixtureLineage,
  historyFixture,
} from "../../fixtures/history/nativeHistory.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "canonical-index-"));
  roots.push(root);
  const f = await historyFixture(root);
  const records = canonicalRecords();
  const prefix = Array.from({ length: 14000 }, () => ({
    type: "turn_context",
    payload: { model: "historical", padding: "x".repeat(180) },
  }));
  records.splice(1, 0, ...prefix);
  const raw = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  await writeFile(f.rollout, raw);
  const db = new DatabaseSync(f.sourceDatabase);
  db.prepare("UPDATE thread_turns SET rollout_ordinal=14001, rollout_end_ordinal=14004").run();
  db.prepare(
    "UPDATE thread_items SET rollout_ordinal=rollout_ordinal+14000, updated_at_ordinal=updated_at_ordinal+14000",
  ).run();
  db.prepare(
    "UPDATE thread_history_projection_state SET next_rollout_byte_offset=?, next_rollout_ordinal=14005",
  ).run(Buffer.byteLength(raw));
  db.close();
  const lineage = fixtureLineage(f.ref);
  const snapshot = await snapshotHistoryDatabase(f);
  const candidate = await readNativeHistoryPage(
    lineage,
    { anchor: { kind: "latest" } },
    snapshot.snapshot!,
  );
  return { ...f, raw, lineage, candidate };
}
describe("explicit raw index to bounded native evidence", () => {
  it("does not use a selected suffix to hide an unprojected legacy prefix", async () => {
    const f = await setup();
    await writeFile(f.rollout, f.raw.replace('"type":"turn_context"', '"type":"response_item"'));
    const index = new CanonicalRolloutIndex();
    expect(await index.prepare(f.lineage)).toBeNull();
  });
  it("rejects missing prepared authority and invalidates a genuinely prepared capability", async () => {
    const f = await setup();
    const index = new CanonicalRolloutIndex();
    const prepared = await index.prepare(f.lineage);
    const ranges = await index.proposeRanges(f.lineage, prepared!);
    expect(ranges?.[0]?.start).toBeGreaterThan(2 * 1024 * 1024);
    const db = openCacheDatabase(":memory:");
    try {
      const stripped = ranges!.map(({ preparedIndex: _proof, ...range }) => range);
      const missing = await qualifyNativeProjection(
        f.candidate,
        f.lineage,
        prepared!,
        new VerifiedProjectionStore(db, {
          canonicalEvidence: { proposeRanges: async () => stripped },
        }),
      );
      expect(missing.diagnostics).toContain("native.ordinal_anchor_required");
      index.invalidate();
      const invalidated = await qualifyNativeProjection(
        f.candidate,
        f.lineage,
        prepared!,
        new VerifiedProjectionStore(db, {
          canonicalEvidence: { proposeRanges: async () => ranges },
        }),
      );
      expect(invalidated.status).toBe("projection-only");
      expect(invalidated.page).toBeNull();
    } finally {
      db.close();
    }
  });
  it("qualifies a real large-source suffix using independently counted raw offsets and consumes its prepared capability", async () => {
    const f = await setup();
    const index = new CanonicalRolloutIndex();
    const prepared = await index.prepare(f.lineage);
    expect(prepared!.observation.encodedSize).toBeGreaterThan(2 * 1024 * 1024);
    const actualRead = reads.stableRead;
    let selectedBytes = 0;
    vi.spyOn(reads, "stableRead").mockImplementation(async (path, options) => {
      const result = await actualRead(path, options);
      if (path === f.rollout) {
        selectedBytes += result.bytesRead;
      }
      return result;
    });
    const db = openCacheDatabase(":memory:");
    try {
      const store = new VerifiedProjectionStore(db, { canonicalEvidence: index });
      const qualified = await qualifyNativeProjection(f.candidate, f.lineage, prepared!, store);
      expect(qualified).toMatchObject({ status: "verified-range", diagnostics: [] });
      expect(qualified.page!.turns.at(0)!.items.map((item) => [item.ordinal, item.itemId])).toEqual(
        [
          [14002, "user"],
          [14003, "answer"],
        ],
      );
      expect(selectedBytes).toBeLessThan(8192);
      const repeated = await qualifyNativeProjection(f.candidate, f.lineage, prepared!, store);
      expect(repeated.status).toBe("projection-only");
    } finally {
      db.close();
    }
  });
  it("rejects a same-length preserved-mtime rewrite outside the selected suffix after preparation", async () => {
    const f = await setup();
    const index = new CanonicalRolloutIndex();
    const prepared = await index.prepare(f.lineage);
    const old = await stat(f.rollout);
    await writeFile(f.rollout, f.raw.replace("historical", "rewritten!"));
    await utimes(f.rollout, old.atime, old.mtime);
    const db = openCacheDatabase(":memory:");
    try {
      const result = await qualifyNativeProjection(
        f.candidate,
        f.lineage,
        prepared!,
        new VerifiedProjectionStore(db, { canonicalEvidence: index }),
      );
      expect(result.status).not.toBe("verified-range");
    } finally {
      db.close();
    }
  });
});
