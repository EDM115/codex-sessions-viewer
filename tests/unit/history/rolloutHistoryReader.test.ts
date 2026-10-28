import { mkdtemp, rm, writeFile, appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RolloutHistoryReader } from "../../../server/history/rolloutHistoryReader.ts";
import * as lineageModule from "../../../server/ingestion/rolloutLineage.ts";
import { RolloutStore } from "../../../server/ingestion/rolloutStream.ts";
import { resolveSelectedRolloutLineage } from "../../../server/ingestion/selectedRolloutLineage.ts";
import * as generations from "../../../server/ingestion/sourceGeneration.ts";
import {
  canonicalRecords,
  fixtureLineage,
  fixtureRef,
} from "../../fixtures/history/nativeHistory.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(records: unknown[], finalNewline = true) {
  const root = await mkdtemp(join(tmpdir(), "raw-history-"));
  roots.push(root);
  const path = join(root, "source.jsonl");
  await writeFile(
    path,
    records.map((entry) => JSON.stringify(entry)).join("\n") + (finalNewline ? "\n" : ""),
  );
  const store = new RolloutStore({ cacheDirectory: join(root, "cache") });
  const reader = new RolloutHistoryReader({ open: (ref, signal) => store.open(ref, signal) });
  return { root, path, store, reader, lineage: fixtureLineage(fixtureRef(path)) };
}
describe("bounded raw history pages", () => {
  it("I3 applies context observed after the matching turn start", async () => {
    const records = canonicalRecords();
    records.splice(2, 0, {
      type: "turn_context",
      payload: { turn_id: "turn", model: "correct-model", effort: "high", cwd: "/current" },
    });
    const f = await fixture(records);
    const page = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    expect(page.turns.at(0)!.context).toMatchObject({
      model: "correct-model",
      effort: "high",
      cwd: "/current",
      complete: true,
      source: { physicalRolloutId: "physical", ordinal: 2, turnId: "turn" },
    });
    await f.store.close();
  });
  it("I3 does not borrow a context explicitly associated with the preceding turn", async () => {
    const records = canonicalRecords();
    records.splice(2, 0, {
      type: "turn_context",
      payload: { turn_id: "turn", model: "previous-model", effort: "low", cwd: "/previous" },
    });
    records.push(
      ...canonicalRecords("second answer")
        .slice(1)
        .map((record) =>
          Object.assign({}, record, {
            payload: Object.assign({}, record.payload, { turn_id: "second" }),
          }),
        ),
    );
    const f = await fixture(records);
    const page = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    expect(page.turns.at(0)!.context?.model).toBe("previous-model");
    expect(page.turns.at(1)!.context).toMatchObject({
      model: null,
      effort: null,
      cwd: null,
      complete: false,
    });
    await f.store.close();
  });
  it.each([500, 2000])(
    "I1 locates a later giant turn opening independently of its newest item tail (%i prefix records)",
    async (prefixRecords) => {
      const records = canonicalRecords();
      records.splice(
        1,
        0,
        ...Array.from({ length: prefixRecords }, () => ({
          type: "turn_context",
          payload: { padding: "p".repeat(400) },
        })),
      );
      records.splice(
        prefixRecords + 3,
        0,
        ...Array.from({ length: 9000 }, (_, index) => ({
          type: "event_msg",
          payload: {
            type: "item_completed",
            turn_id: "turn",
            item: {
              type: "AgentMessage",
              id: `later-${index}`,
              content: [{ type: "Text", text: `middle-${index}-${"x".repeat(100)}` }],
            },
          },
        })),
      );
      const f = await fixture(records);
      let opening = await f.reader.readItems(f.lineage, {
        turnId: "turn",
        anchor: { kind: "opening" },
      });
      const cursors = new Set<string>();
      for (let page = 0; opening.opening.availability !== "available" && page < 5; page += 1) {
        expect(opening.items).toEqual([]);
        const cursor = opening.preparation?.cursor;
        expect(cursor).toBeTruthy();
        expect(cursors.has(cursor!)).toBe(false);
        cursors.add(cursor!);
        // oxlint-disable-next-line no-await-in-loop -- Opening preparation advances one independently bounded source window per issued cursor
        opening = await f.reader.readItems(f.lineage, {
          turnId: "turn",
          anchor: { kind: "after", cursor: cursor! },
        });
      }
      expect(opening.opening.item).toMatchObject({ id: "user", text: "question" });
      expect(opening.items.at(0)!.itemId).toBe("user");
      await f.store.close();
    },
  );
  it("I2 keeps an unnamed giant legacy tail visible with a stable provisional window", async () => {
    const records = [
      { type: "session_meta", payload: { id: "stable", session_id: "root" } },
      { type: "event_msg", payload: { type: "user_message", message: "legacy opening" } },
      ...Array.from({ length: 9000 }, (_, index) => ({
        type: "event_msg",
        payload: { type: "agent_message", message: `legacy-${index}-${"x".repeat(100)}` },
      })),
      { type: "event_msg", payload: { type: "agent_message", message: "LATEST-ANSWER" } },
    ];
    const f = await fixture(records);
    const first = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    const latest = first.turns.find((turn) =>
      turn.items.some(
        (entry) => entry.item?.type === "agentMessage" && entry.item.text === "LATEST-ANSWER",
      ),
    );
    expect(latest).toBeDefined();
    expect(latest!.opening.availability).toBe("notLoaded");
    expect(latest!.boundary).toMatchObject({
      status: "unresolved",
      sourceTurnId: null,
      decodedByteStart: null,
    });
    const prefixIdentity = first.turns.find(
      (turn) =>
        turn.opening.item?.type === "userMessage" && turn.opening.item.text === "legacy opening",
    )!.turnId;
    const repeat = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    expect(repeat.turns.at(-1)!.turnId).toBe(latest!.turnId);
    await appendFile(
      f.path,
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "APPENDED-LATEST" },
      }) + "\n",
    );
    const appended = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    expect(appended.turns.at(-1)!.turnId).toBe(latest!.turnId);
    expect(appended.turns.at(-1)!.items.at(-1)!.item).toMatchObject({ text: "APPENDED-LATEST" });
    const older = await f.reader.readItems(f.lineage, {
      turnId: latest!.turnId,
      anchor: { kind: "before", cursor: latest!.beforeCursor! },
    });
    expect(older.turnId).toBe(latest!.turnId);
    expect(older.items.length).toBeGreaterThan(0);
    let opening = await f.reader.readItems(f.lineage, {
      turnId: latest!.turnId,
      anchor: { kind: "opening" },
    });
    for (let page = 0; opening.opening.availability !== "available" && page < 12; page += 1) {
      expect(opening.turnId).toBe(latest!.turnId);
      expect(opening.items).toEqual([]);
      expect(opening.preparation?.cursor).toBeTruthy();
      // oxlint-disable-next-line no-await-in-loop -- Legacy boundary preparation expands a verified island without renaming its published window
      opening = await f.reader.readItems(f.lineage, {
        turnId: latest!.turnId,
        anchor: { kind: "after", cursor: opening.preparation!.cursor! },
      });
    }
    expect(opening.opening.item).toMatchObject({ text: "legacy opening" });
    expect(opening.turnId).toBe(latest!.turnId);
    expect(opening.boundary?.status).toBe("verified");
    expect(opening.boundary?.identityAliases).toContain(prefixIdentity);
    const resolvedLatest = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    expect(resolvedLatest.turns.at(-1)!.turnId).toBe(latest!.turnId);
    const aliasOpening = await f.reader.readItems(f.lineage, {
      turnId: prefixIdentity,
      anchor: { kind: "opening" },
    });
    expect(aliasOpening.turnId).toBe(prefixIdentity);
    expect(aliasOpening.opening.item).toMatchObject({ text: "legacy opening" });
    await f.store.close();
  });
  it("I1 returns resumable opening preparation when the target is absent from both prefix and newest turn", async () => {
    const records = canonicalRecords();
    records.splice(
      1,
      0,
      ...Array.from({ length: 1500 }, () => ({
        type: "token_usage",
        payload: { padding: "p".repeat(500) },
      })),
    );
    const newer = canonicalRecords("newer answer")
      .slice(1)
      .map((record) =>
        Object.assign({}, record, {
          payload: Object.assign({}, record.payload, { turn_id: "newer" }),
        }),
      );
    newer.splice(
      2,
      0,
      ...Array.from({ length: 5000 }, (_, index) => ({
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "newer",
          item: {
            type: "AgentMessage",
            id: `newer-${index}`,
            content: [{ type: "Text", text: "x".repeat(160) }],
          },
        },
      })),
    );
    records.push(...newer);
    const f = await fixture(records);
    let opening = await f.reader.readItems(f.lineage, {
      turnId: "turn",
      anchor: { kind: "opening" },
    });
    expect(opening.itemsView).toBe("notLoaded");
    expect(opening.preparation?.cursor).toBeTruthy();
    for (let page = 0; opening.opening.availability !== "available" && page < 4; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- An older target is found by the next bounded opening search window
      opening = await f.reader.readItems(f.lineage, {
        turnId: "turn",
        anchor: { kind: "after", cursor: opening.preparation!.cursor! },
      });
    }
    expect(opening.opening.item).toMatchObject({ id: "user", text: "question" });
    await f.store.close();
  });
  it("I2 resolves an unseen second prompt without attaching the file-prefix prompt", async () => {
    const records = [
      { type: "session_meta", payload: { id: "stable", session_id: "root" } },
      { type: "event_msg", payload: { type: "user_message", message: "FIRST PROMPT" } },
      ...Array.from({ length: 4000 }, (_, index) => ({
        type: "event_msg",
        payload: { type: "agent_message", message: `first-${index}-${"x".repeat(80)}` },
      })),
      { type: "event_msg", payload: { type: "user_message", message: "SECOND PROMPT" } },
      ...Array.from({ length: 5000 }, (_, index) => ({
        type: "event_msg",
        payload: { type: "agent_message", message: `second-${index}-${"y".repeat(80)}` },
      })),
      { type: "event_msg", payload: { type: "agent_message", message: "LATEST SECOND" } },
    ];
    const f = await fixture(records);
    const first = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    const prefix = first.turns.at(0)!;
    const latest = first.turns.at(-1)!;
    expect(latest.items.at(-1)!.item).toMatchObject({ text: "LATEST SECOND" });
    expect(latest.opening.availability).toBe("notLoaded");
    let opening = await f.reader.readItems(f.lineage, {
      turnId: latest.turnId,
      anchor: { kind: "opening" },
    });
    for (let page = 0; opening.opening.availability !== "available" && page < 10; page += 1) {
      expect(opening.preparation?.cursor).toBeTruthy();
      // oxlint-disable-next-line no-await-in-loop -- The second prompt must be found by actual contiguous boundary evidence
      opening = await f.reader.readItems(f.lineage, {
        turnId: latest.turnId,
        anchor: { kind: "after", cursor: opening.preparation!.cursor! },
      });
    }
    expect(opening.turnId).toBe(latest.turnId);
    expect(opening.opening.item).toMatchObject({ text: "SECOND PROMPT" });
    expect(opening.boundary?.identityAliases).not.toContain(prefix.turnId);
    await f.store.close();
  });
  it("I4 reconciles a real appended update beyond an older item cursor without moving the item", async () => {
    const records = canonicalRecords();
    const middle = Array.from({ length: 9000 }, (_, index) => ({
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn",
        item: {
          type: "AgentMessage",
          id: `update-${index}`,
          content: [{ type: "Text", text: `original-${index}-${"x".repeat(100)}` }],
        },
      },
    }));
    records.splice(3, 0, ...middle);
    const f = await fixture(records);
    const first = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    const cursor = first.turns.at(0)!.beforeCursor!;
    const originalOffset = Buffer.byteLength(
      records
        .slice(0, 8903)
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const updatedOffset = Buffer.byteLength(
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    await appendFile(
      f.path,
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn",
          item: {
            type: "AgentMessage",
            id: "update-8900",
            content: [{ type: "Text", text: "UPDATED-8900" }],
          },
        },
      }) + "\n",
    );
    const older = await f.reader.readItems(f.lineage, {
      turnId: "turn",
      anchor: { kind: "before", cursor },
    });
    const item = older.items.find((entry) => entry.itemId === "update-8900");
    expect(item).toMatchObject({
      decodedByteStart: originalOffset,
      updatedAtDecodedByte: updatedOffset,
      detail: "full",
      item: { text: "UPDATED-8900" },
    });
    expect(older.historyEpoch).toBe(first.historyEpoch);
    await f.store.close();
  });
  it("I4 never calls an older payload full when an update can be hidden in an unloaded suffix gap", async () => {
    const records = canonicalRecords();
    records.splice(
      3,
      0,
      ...Array.from({ length: 9000 }, (_, index) => ({
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn",
          item: {
            type: "AgentMessage",
            id: `gap-${index}`,
            content: [{ type: "Text", text: `original-${index}-${"x".repeat(100)}` }],
          },
        },
      })),
    );
    const f = await fixture(records);
    const first = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    const cursor = first.turns.at(0)!.beforeCursor!;
    const update = {
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn",
        item: {
          type: "AgentMessage",
          id: "gap-8900",
          content: [{ type: "Text", text: "HIDDEN-UPDATE" }],
        },
      },
    };
    const laterUpdate = {
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn",
        item: {
          type: "AgentMessage",
          id: "gap-8900",
          content: [{ type: "Text", text: "HIDDEN-LATEST" }],
        },
      },
    };
    const padding =
      Array.from({ length: 3000 }, () =>
        JSON.stringify({ type: "token_usage", payload: { padding: "z".repeat(150) } }),
      ).join("\n") + "\n";
    await appendFile(
      f.path,
      JSON.stringify(update) + "\n" + padding + JSON.stringify(laterUpdate) + "\n" + padding,
    );
    let older = await f.reader.readItems(f.lineage, {
      turnId: "turn",
      anchor: { kind: "before", cursor },
    });
    expect(older.items.find((entry) => entry.itemId === "gap-8900")?.detail).toBe("unresolved");
    expect(older.coverage.gaps.some((gap) => gap.reason === "unverified-item-updates")).toBe(true);
    const position = older.items.find((entry) => entry.itemId === "gap-8900")!.decodedByteStart;
    const observedUpdates: { text: string; detail: string }[] = [];
    for (
      let page = 0;
      older.items.some((item) => item.detail === "unresolved") && page < 8;
      page += 1
    ) {
      expect(older.preparation?.kind).toBe("updates");
      expect(older.preparation?.cursor).toBeTruthy();
      // oxlint-disable-next-line no-await-in-loop -- Each preparation request proves one further suffix interval without moving the selected item window
      older = await f.reader.readItems(f.lineage, {
        turnId: "turn",
        anchor: { kind: "after", cursor: older.preparation!.cursor! },
      });
      const intermediate = older.items.find((entry) => entry.itemId === "gap-8900");
      if (intermediate?.item?.type === "agentMessage") {
        observedUpdates.push({ text: intermediate.item.text, detail: intermediate.detail });
      }
    }
    expect(observedUpdates).toContainEqual({ text: "HIDDEN-UPDATE", detail: "unresolved" });
    expect(older.items.find((entry) => entry.itemId === "gap-8900")).toMatchObject({
      detail: "full",
      decodedByteStart: position,
      item: { text: "HIDDEN-LATEST" },
    });
    await f.store.close();
  });
  it("preserves actual page epoch and issued item continuation through equivalent plain-to-compressed history", async () => {
    const records = canonicalRecords();
    records.splice(
      3,
      0,
      ...Array.from({ length: 160 }, (_, index) => ({
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn",
          item: {
            type: "AgentMessage",
            id: `middle-${index}`,
            content: [{ type: "Text", text: `message ${index}` }],
          },
        },
      })),
    );
    const f = await fixture(records);
    const first = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    const cursor = first.turns.at(0)!.beforeCursor!;
    const bytes = await readFile(f.path);
    const compressed = `${f.path}.zst`;
    await writeFile(compressed, zstdCompressSync(bytes));
    await rm(f.path);
    const lineage = fixtureLineage({ ...fixtureRef(compressed), representation: "zstd-jsonl" });
    const next = await f.reader.read(lineage, { anchor: { kind: "latest" } });
    expect(next.historyEpoch).toBe(first.historyEpoch);
    const older = await f.reader.readItems(lineage, {
      turnId: "turn",
      anchor: { kind: "before", cursor },
    });
    expect(older.historyEpoch).toBe(first.historyEpoch);
    expect(older.items.at(-1)!.itemId).toBe("middle-60");
    await f.store.close();
  });
  it("does not label a transcript complete when an interior record cannot be represented", async () => {
    const records = canonicalRecords();
    records.splice(3, 0, {
      type: "future_rollout_event",
      payload: { content: "unknown evidence" },
    });
    const f = await fixture(records);
    const page = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    expect(page.turns.at(0)!.items.at(-1)!.item).toMatchObject({ text: "answer A" });
    expect(page.coverage.status).toBe("partial");
    expect(page.turns.at(0)!.itemsView).toBe("summary");
    expect(page.coverage.gaps.some((gap) => gap.reason === "unresolved-records")).toBe(true);
    await f.store.close();
  });
  it("keeps giant records and unfinished final records explicitly partial without truncating content into a complete item", async () => {
    const records = canonicalRecords();
    records.at(3)!.payload["item"] = {
      type: "AgentMessage",
      id: "giant",
      content: [{ type: "Text", text: "x".repeat(1024 * 1024) }],
    };
    const f = await fixture(records);
    const page = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    expect(page.preparation).toBe("partial");
    expect(page.coverage.total).toBeUndefined();
    expect(page.turns.at(0)!.itemsView).toBe("summary");
    expect(page.turns.at(0)!.items.some((item) => item.itemId === "giant")).toBe(false);
    await appendFile(f.path, '{"unfinished":');
    const pending = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    expect(pending.preparation).toBe("partial");
    expect(pending.coverage.gaps.some((gap) => gap.reason === "unfinished-final-record")).toBe(
      true,
    );
    await f.store.close();
  });
  it("updates existing canonical items without changing their first ordinal or identity", async () => {
    const records = canonicalRecords();
    records.push(canonicalRecords("updated answer").at(3)!);
    const f = await fixture(records);
    const page = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    const answer = page.turns.at(0)!.items.find((item) => item.itemId === "answer");
    expect(answer).toMatchObject({
      ordinal: 3,
      updatedAtOrdinal: 5,
      item: { text: "updated answer" },
    });
    await f.store.close();
  });
  it("carries context across physical inherited segments, proves ordinal origin and invalidates child epochs on ancestor rewrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "inherited-history-"));
    roots.push(root);
    const parentPath = join(root, "parent.jsonl");
    const childPath = join(root, "child.jsonl");
    const parentRecords = [
      { type: "session_meta", payload: { id: "parent", session_id: "root" } },
      { type: "turn_context", payload: { model: "parent-model", cwd: "/parent" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "cross-call",
          name: "inspect",
          arguments: "hidden command",
        },
      },
      { type: "event_msg", payload: { type: "user_message", message: "hidden parent prompt" } },
    ];
    const parentBytes = parentRecords.map((record) => JSON.stringify(record)).join("\r\n") + "\r\n";
    await writeFile(parentPath, parentBytes);
    const childRecords = [
      {
        type: "session_meta",
        payload: {
          id: "child",
          session_id: "root",
          history_base: {
            thread_id: "p",
            end_ordinal_exclusive: 4,
            end_byte_offset: Buffer.byteLength(parentBytes),
          },
          subagent_history_start_ordinal: 5,
        },
      },
      { type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
      { type: "event_msg", payload: { type: "user_message", message: "own prompt" } },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "cross-call", output: "own result" },
      },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "child-turn" } },
    ];
    await writeFile(
      childPath,
      childRecords.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    const store = new RolloutStore({ cacheDirectory: join(root, "cache") });
    const open = (ref: Parameters<typeof store.open>[0], signal?: AbortSignal) =>
      store.open(ref, signal);
    const reader = new RolloutHistoryReader({ open });
    const parent = fixtureRef(parentPath, "p", "parent");
    const child = fixtureRef(childPath, "c", "child");
    const lineage = await resolveSelectedRolloutLineage(child, [parent], undefined, { open });
    expect(lineage.status).toBe("complete");
    const first = await reader.read(lineage, { anchor: { kind: "latest" } });
    expect(first.turns).toHaveLength(1);
    expect(first.turns.at(0)!.items.map((item) => item.ordinal)).toEqual([6, 7]);
    expect(first.turns.at(0)!.context?.model).toBe("parent-model");
    expect(first.turns.at(0)!.items.at(1)!.item).toMatchObject({
      name: "inspect",
      output: "own result",
    });
    expect(JSON.stringify(first.turns)).not.toContain("hidden parent prompt");
    await writeFile(parentPath, parentBytes.replace("parent-model", "change-model"));
    const next = await reader.read(lineage, { anchor: { kind: "latest" } });
    expect(next.historyEpoch).not.toBe(first.historyEpoch);
    expect(next.turns.at(0)!.context?.model).toBe("change-model");
    await store.close();
  });
  it("retains a known-good page explicitly as stale during source disappearance", async () => {
    const f = await fixture(canonicalRecords());
    await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    await rm(f.path);
    const pending = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    expect(pending.stale).toBe(true);
    expect(pending.preparation).toBe("partial");
    expect(pending.coverage.status).toBe("unresolved");
    expect(pending.turns.at(0)!.items.at(-1)!.item).toMatchObject({ text: "answer A" });
    expect(pending.beforeCursor).toBeNull();
    await f.store.close();
  });
  it("uses inherited model/tool context without displaying inherited child prompts or commands", async () => {
    const records = [
      {
        type: "session_meta",
        payload: { id: "stable", session_id: "root", subagent_history_start_ordinal: 4 },
      },
      { type: "turn_context", payload: { model: "parent-model", effort: "high", cwd: "/parent" } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "inherited-call",
          name: "inspect",
          arguments: "private command",
        },
      },
      { type: "event_msg", payload: { type: "user_message", message: "parent prompt" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
      { type: "event_msg", payload: { type: "user_message", message: "child prompt" } },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "inherited-call",
          output: "child result",
        },
      },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "child-turn" } },
    ];
    const f = await fixture(records);
    f.lineage.segments.at(0)!.ref.subagentHistoryStartOrdinal = 4;
    f.lineage.segments.at(0)!.displayStartOrdinal = 4;
    const page = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    expect(page.turns).toHaveLength(1);
    expect(page.turns.at(0)!.context).toMatchObject({
      model: "parent-model",
      effort: "high",
      complete: true,
    });
    expect(page.turns.at(0)!.items.map((item) => item.item?.type)).toEqual([
      "userMessage",
      "functionCallOutput",
    ]);
    expect(page.turns.at(0)!.items.at(1)!.item).toMatchObject({
      name: "inspect",
      output: "child result",
    });
    expect(JSON.stringify(page.turns.at(0)!.items)).not.toContain("parent prompt");
    expect(JSON.stringify(page.turns.at(0)!.items)).not.toContain("private command");
    await f.store.close();
  });
  it("does not borrow an unrelated prefix model across an unloaded middle", async () => {
    const records = canonicalRecords();
    records.splice(1, 0, {
      type: "turn_context",
      payload: { model: "old-model", turn_id: "turn" },
    });
    records.push(
      ...Array.from({ length: 4000 }, () => ({
        type: "token_usage",
        payload: { padding: "x".repeat(300) },
      })),
    );
    records.push(
      ...canonicalRecords("new answer")
        .slice(1)
        .map((record) =>
          Object.assign({}, record, {
            payload: Object.assign({}, record.payload, { turn_id: "new-turn" }),
          }),
        ),
    );
    const f = await fixture(records);
    const page = await f.reader.read(f.lineage, { anchor: { kind: "latest" }, limit: 1 });
    expect(page.turns.at(0)!.turnId).toBe("new-turn");
    expect(page.turns.at(0)!.context?.model).not.toBe("old-model");
    await f.store.close();
  });
  it("pages older and newer turns without repeating loaded turns", async () => {
    const records = canonicalRecords().slice(0, 1);
    for (let index = 0; index < 12; index += 1) {
      records.push(
        ...canonicalRecords(`answer ${index}`)
          .slice(1)
          .map((record) =>
            Object.assign({}, record, {
              payload: Object.assign({}, record.payload, { turn_id: `t-${index}` }),
            }),
          ),
      );
    }
    const f = await fixture(records);
    const latest = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    expect(latest.turns.map((turn) => turn.turnId)).toEqual(["t-7", "t-8", "t-9", "t-10", "t-11"]);
    expect(latest.beforeCursor).toBeTruthy();
    const allOlder = await f.reader.read(f.lineage, {
      anchor: { kind: "before", cursor: latest.beforeCursor! },
      limit: 20,
    });
    expect(allOlder.coverage.status).toBe("partial");
    expect(allOlder.coverage.total).toBeUndefined();
    const older = await f.reader.read(f.lineage, {
      anchor: { kind: "before", cursor: latest.beforeCursor! },
      limit: 3,
    });
    expect(older.turns.map((turn) => turn.turnId)).toEqual(["t-4", "t-5", "t-6"]);
    expect(older.afterCursor).toBeTruthy();
    const newer = await f.reader.read(f.lineage, {
      anchor: { kind: "after", cursor: older.afterCursor! },
      limit: 3,
    });
    expect(newer.turns.map((turn) => turn.turnId)).toEqual(["t-7", "t-8", "t-9"]);
    await f.store.close();
  });
  it("renders canonical-only source and does not duplicate matching raw messages", async () => {
    const records = canonicalRecords();
    records.splice(4, 0, {
      type: "response_item",
      payload: {
        type: "message",
        id: "answer",
        role: "assistant",
        content: [{ type: "output_text", text: "answer A" }],
      },
    });
    const f = await fixture(records);
    const page = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    expect(page.turns).toHaveLength(1);
    expect(page.turns.at(0)!.items.map((entry) => entry.itemId)).toEqual(["user", "answer"]);
    expect(page.turns.at(0)!.opening.item).toMatchObject({ type: "userMessage", text: "question" });
    expect(page.turns.at(0)!.items.at(1)!.item).toMatchObject({
      type: "agentMessage",
      text: "answer A",
    });
    expect(page.coverage.status).toBe("complete");
    await f.store.close();
  });
  it("does not duplicate canonical tool completion with its legacy call/output representation", async () => {
    const records = canonicalRecords();
    records.splice(
      3,
      0,
      {
        type: "response_item",
        payload: { type: "function_call", call_id: "call-1", name: "inspect", arguments: "{}" },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call-1", output: "result" },
      },
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn",
          item: {
            type: "DynamicToolCall",
            id: "call-1",
            tool: "inspect",
            arguments: {},
            status: "completed",
            content_items: [{ type: "input_text", text: "result" }],
            success: true,
          },
        },
      },
    );
    const f = await fixture(records);
    const page = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    expect(page.turns.at(0)!.items.map((item) => item.itemId)).toEqual([
      "user",
      "call-1",
      "answer",
    ]);
    expect(page.turns.at(0)!.items.at(1)!.item).toMatchObject({
      type: "dynamicToolCall",
      status: "completed",
      success: true,
    });
    await f.store.close();
  });
  it("publishes a giant-turn tail independently of its opening without full hash, lineage replay or discovery", async () => {
    const records = canonicalRecords();
    const middle = Array.from({ length: 9000 }, (_, index) => ({
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn",
        item: {
          type: "AgentMessage",
          id: `m-${index}`,
          content: [{ type: "Text", text: `middle-${index}-${"x".repeat(120)}` }],
        },
      },
    }));
    records.splice(3, 0, ...middle);
    const f = await fixture(records);
    const full = vi.spyOn(generations, "validateSourceGeneration");
    const legacy = vi.spyOn(lineageModule, "readPlainRolloutLineage");
    const resolver = vi.spyOn(lineageModule, "filesystemRolloutResolver");
    const page = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    expect(full).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    expect(page.turns).toHaveLength(1);
    const turn = page.turns.at(0)!;
    expect(turn.opening.item).toMatchObject({ id: "user", text: "question" });
    expect(turn.items).toHaveLength(100);
    expect(turn.items.at(-1)!.item).toMatchObject({ id: "answer", text: "answer A" });
    expect(turn.items.at(0)!.itemId).toBe("m-8901");
    expect(turn.itemsView).toBe("summary");
    expect(turn.beforeCursor).toBeTruthy();
    expect(turn.coverage.gaps.length).toBeGreaterThan(0);
    expect(page.coverage.total).toBeUndefined();
    const older = await f.reader.readItems(f.lineage, {
      turnId: turn.turnId,
      anchor: { kind: "before", cursor: turn.beforeCursor! },
    });
    expect(older.items.at(-1)!.itemId).toBe("m-8900");
    expect(older.turnId).toBe(turn.turnId);
    await f.store.close();
  });
  it("keeps raw identities when a complete final record gains its newline", async () => {
    const records = [
      { type: "session_meta", payload: { id: "stable", session_id: "root" } },
      { type: "event_msg", payload: { type: "user_message", message: "prompt" } },
      { type: "event_msg", payload: { type: "agent_message", message: "answer" } },
    ];
    const f = await fixture(records, false);
    const first = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    await appendFile(f.path, "\n");
    const next = await f.reader.read(f.lineage, { anchor: { kind: "latest" } });
    expect(next.turns.at(0)!.turnId).toBe(first.turns.at(0)!.turnId);
    expect(next.turns.at(0)!.items.map((item) => item.itemId)).toEqual(
      first.turns.at(0)!.items.map((item) => item.itemId),
    );
    expect(next.historyEpoch).toBe(first.historyEpoch);
    await f.store.close();
  });
});
