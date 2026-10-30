import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { getCachedAsset } from "#server/cache/assetStore.ts";
import { openCacheDatabase } from "#server/cache/database.ts";
import { storeEmbeddedMedia } from "#server/content/extractMedia.ts";
import * as richText from "#server/content/parseRichText.ts";
import { HistoryPager } from "#server/history/historyPager.ts";
import { prepareHistoryPresentation } from "#server/history/historyPresentation.ts";
import { JsonlStreamParser, type JsonlRecord } from "#server/ingestion/jsonlStream.ts";
import { RolloutStore } from "#server/ingestion/rolloutStream.ts";
import { normalizeSession } from "#server/normalization/normalizeSession.ts";
import {
  historyWindowInspector,
  historyWindowPresentation,
} from "#shared/timeline/historyPresentation.ts";
import type { HistoryTurnWindow } from "#shared/types/history.ts";

import { canonicalRecords, fixtureRef } from "../../fixtures/history/nativeHistory.ts";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
describe("immutable history formatting", () => {
  it("projects no asset authority until generated media has a matching prepared presentation", () => {
    const item = {
      id: "generated",
      type: "imageGeneration" as const,
      result: "aW1hZ2U=",
      savedPath: null,
      fileId: null,
      startedAtMs: null,
      completedAtMs: null,
      evidence: null,
    };
    const window: HistoryTurnWindow = {
      turnId: "turn",
      physicalRolloutId: "physical",
      historyEpoch: "epoch",
      contentRevision: "revision",
      order: 0,
      status: "completed",
      startedAt: null,
      completedAt: null,
      durationMs: null,
      opening: { itemId: null, item: null, availability: "absent" },
      items: [
        {
          physicalRolloutId: "physical",
          itemId: item.id,
          item,
          ordinal: 0,
          updatedAtOrdinal: 0,
          detail: "full",
        },
      ],
      itemsView: "full",
      beforeCursor: null,
      afterCursor: null,
      loadedRanges: [],
      coverage: { status: "complete", segments: [], gaps: [] },
      finalAnswerItemId: null,
    };
    expect(historyWindowPresentation("stable", window).activities).toEqual([
      expect.objectContaining({ kind: "media", assetId: "" }),
    ]);
    const prepared = {
      threadId: "stable",
      physicalRolloutId: "physical",
      historyEpoch: "epoch",
      contentRevision: "revision",
      turnId: "turn",
      itemId: "generated",
      markdown: "",
      attachments: [{ mediaType: "image" as const, source: "data:image/png;base64,aW1hZ2U=" }],
      body: {
        type: "document" as const,
        children: [
          {
            type: "media" as const,
            mediaType: "image" as const,
            source: "asset" as const,
            assetId: "saved-generated",
            originalSource: "retained.png",
            alt: "Generated image",
            title: null,
          },
        ],
      },
    };
    expect(historyWindowPresentation("stable", window, [prepared]).activities).toEqual([
      expect.objectContaining({ kind: "media", assetId: "saved-generated" }),
    ]);
    expect(
      historyWindowPresentation("stable", window, [{ ...prepared, contentRevision: "stale" }])
        .activities,
    ).toEqual([expect.objectContaining({ kind: "media", assetId: "" })]);
  });
  it("notifies selected-content enrichment from the actual rich document on fresh and cached presentation", async () => {
    const onDocument = vi.fn();
    const query = {
      threadId: "links",
      historyEpoch: "links-epoch",
      contentRevision: "links-v1",
      physicalRolloutId: "links-physical",
      turnId: "turn",
      itemId: "item",
      markdown: "[Example](https://example.com/path)",
    };
    const options = {
      cacheScope: "selected-links",
      storeEmbeddedMedia: async () => undefined,
      onDocument,
    };
    const result = await prepareHistoryPresentation(query, undefined, options);
    expect(onDocument).toHaveBeenCalledExactlyOnceWith(result.body);
    await prepareHistoryPresentation(query, undefined, options);
    expect(onDocument).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    controller.abort();
    await expect(async () =>
      prepareHistoryPresentation(query, controller.signal, options),
    ).rejects.toThrow();
    expect(onDocument).toHaveBeenCalledTimes(2);
  });
  it("registers only supplied embedded media without requiring a normalized session or reading local image references", async () => {
    const root = await mkdtemp(join(tmpdir(), "history-embedded-"));
    const database = openCacheDatabase(":memory:");
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const store = vi.fn<(sources: Parameters<typeof storeEmbeddedMedia>[1]) => Promise<void>>(
      async (sources) => {
        await storeEmbeddedMedia(database, sources, { assetRoot: root, sessionId: null });
      },
    );
    const query = {
      threadId: "thread",
      historyEpoch: "embedded-epoch",
      contentRevision: "a",
      physicalRolloutId: "physical",
      turnId: "turn",
      itemId: "image",
      markdown: `![Pixel](data:image/png;base64,${png})\n\n![Local](file:///C:/private/not-loaded.png)`,
    };
    try {
      const result = await prepareHistoryPresentation(query, undefined, {
        cacheScope: root,
        storeEmbeddedMedia: store,
      });
      const media = result.body.children
        .flatMap((node) => ("children" in node ? node.children : [node]))
        .find((node) => node.type === "media" && node.assetId !== null);
      if (media?.type !== "media" || media.assetId === null) {
        throw new Error("Expected embedded image");
      }
      expect(getCachedAsset(database, media.assetId)?.status).toBe("available");
      expect(database.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toMatchObject({
        count: 0,
      });
      expect(store).toHaveBeenCalledOnce();
      expect(store.mock.calls.at(0)?.at(0)).toHaveLength(1);
      await prepareHistoryPresentation(query, undefined, {
        cacheScope: root,
        storeEmbeddedMedia: store,
      });
      expect(store).toHaveBeenCalledOnce();
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("finishes an actual gated A parse after source B is ready without republishing A authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "history-format-fence-"));
    const path = join(root, "source.jsonl");
    const source = (answer: string) =>
      canonicalRecords(answer)
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n";
    await writeFile(path, source("**A**"));
    const database = openCacheDatabase(":memory:");
    const store = new RolloutStore({ cacheDirectory: join(root, "cache") });
    const pager = new HistoryPager({ database, open: (ref, signal) => store.open(ref, signal) });
    const ref = fixtureRef(path);
    const entered = deferred<void>();
    const release = deferred<void>();
    const original = richText.parseRichText;
    const spy = vi.spyOn(richText, "parseRichText").mockImplementation(async (text, options) => {
      if (text === "**A**") {
        entered.resolve();
        await release.promise;
      }
      return original(text, options);
    });
    try {
      const a = await pager.read(ref, [ref], { anchor: { kind: "latest" } });
      const pending = prepareHistoryPresentation({
        threadId: a.threadId,
        historyEpoch: a.historyEpoch,
        contentRevision: a.contentRevision,
        physicalRolloutId: "physical",
        turnId: "turn",
        itemId: "answer",
        markdown: "**A**",
      });
      await entered.promise;
      await writeFile(path, source("**B**"));
      const b = await pager.read(ref, [ref], { anchor: { kind: "latest" } });
      if (b.turns.length === 0) {
        throw new Error(JSON.stringify(b.coverage));
      }
      expect(b.turns[0]?.items.at(-1)?.item).toMatchObject({ text: "**B**" });
      const authority = database.prepare("SELECT * FROM history_semantic_epochs").all();
      const selectedWindow = b.turns[0];
      if (!selectedWindow) {
        throw new Error("Expected the selected history window");
      }
      const inspection = historyWindowInspector(b.threadId, selectedWindow, {
        type: "message",
        id: "answer",
      });
      expect(inspection).toMatchObject({
        sessionId: b.threadId,
        target: { type: "message", id: "answer" },
        timeToFirstTokenMs: null,
        tokenDelta: null,
        eventIds: [],
        historySnapshot: {
          threadId: b.threadId,
          physicalRolloutId: "physical",
          turnId: "turn",
          itemId: "answer",
          historyEpoch: b.historyEpoch,
          contentRevision: b.contentRevision,
          detail: "full",
          evidenceAvailable: true,
        },
      });
      expect(JSON.stringify(inspection?.rawRecords)).toContain("**B**");
      expect(
        historyWindowInspector(b.threadId, selectedWindow, { type: "activity", id: "answer" }),
      ).toBeNull();
      expect(
        historyWindowInspector(b.threadId, selectedWindow, { type: "message", id: "not-loaded" }),
      ).toBeNull();
      expect(database.prepare("SELECT count(*) AS count FROM sessions").get()?.["count"]).toBe(0);
      release.resolve();
      const formattedA = await pending;
      expect(formattedA.contentRevision).toBe(a.contentRevision);
      expect(formattedA.contentRevision).not.toBe(b.contentRevision);
      expect(JSON.stringify(formattedA.body)).toContain("strong");
      expect(database.prepare("SELECT * FROM history_semantic_epochs").all()).toEqual(authority);
    } finally {
      release.resolve();
      spy.mockRestore();
      await pager.close();
      await store.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("deduplicates immutable rich content versions and detaches a cancelled formatting subscriber", async () => {
    const gate = deferred<void>();
    const parse = richText.parseRichText;
    const spy = vi.spyOn(richText, "parseRichText").mockImplementation(async (text, options) => {
      await gate.promise;
      return parse(text, options);
    });
    const query = {
      threadId: "dedup",
      historyEpoch: "epoch",
      contentRevision: "revision",
      physicalRolloutId: "physical",
      turnId: "turn",
      itemId: "item",
      markdown: "**shared**<script>bad()</script>",
    };
    const controller = new AbortController();
    const first = prepareHistoryPresentation(query, controller.signal).catch(
      (error: unknown) => error,
    );
    const second = prepareHistoryPresentation(query);
    controller.abort();
    expect(await first).toBeInstanceOf(Error);
    gate.resolve();
    try {
      const result = await second;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result.body)).not.toContain("bad()");
      expect((await prepareHistoryPresentation(query)).body).toEqual(result.body);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
  });
});

it("carries real loaded raw Code Mode evidence through the progressive bridge and static normalization with the same unknown child outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-tool-evidence-"));
  const path = join(root, "source.jsonl");
  const record = (type: string, payload: Record<string, unknown>) => ({
    timestamp: "2026-01-01T00:00:00.000Z",
    type,
    payload,
  });
  const values = [
    record("session_meta", { id: "stable" }),
    record("event_msg", { type: "task_started", turn_id: "turn" }),
    record("event_msg", { type: "user_message", message: "Run commands" }),
    record("response_item", {
      type: "custom_tool_call",
      call_id: "outer",
      namespace: "functions",
      name: "exec",
      input: "try { await tools[name]({cmd:'fails'}) } catch {}",
    }),
    record("response_item", {
      type: "custom_tool_call_output",
      call_id: "outer",
      output: { exit_code: 0, output: "wrapper succeeded" },
      internal_chat_message_metadata_passthrough: {
        cell_id: "cell",
        executed_tool_calls: [{ name: "exec_command", arguments: { cmd: "fails" } }],
      },
    }),
    record("response_item", {
      type: "function_call",
      call_id: "wait",
      namespace: "functions",
      name: "wait",
      arguments: { cell_id: "cell" },
    }),
    record("response_item", {
      type: "function_call_output",
      call_id: "wait",
      output: "done",
      internal_chat_message_metadata_passthrough: {
        cell_id: "cell",
        executed_tool_calls: [{ name: "read_file", arguments: { path: "later.txt" } }],
        tool_calls_complete: true,
      },
    }),
    record("event_msg", {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        id: "native-child",
        command: ["node", "job"],
        cwd: "C:/repo",
        parsed_cmd: [],
        status: "failed",
        exit_code: 8,
        aggregated_output: "native failure",
      },
    }),
    record("event_msg", { type: "task_complete", turn_id: "turn" }),
  ];
  const bytes = Buffer.from(values.map((value) => JSON.stringify(value)).join("\n") + "\n");
  await writeFile(path, bytes);
  const database = openCacheDatabase(":memory:");
  const store = new RolloutStore({ cacheDirectory: join(root, "cache") });
  const pager = new HistoryPager({ database, open: (ref, signal) => store.open(ref, signal) });
  try {
    const ref = fixtureRef(path);
    const page = await pager.read(ref, [ref], { anchor: { kind: "latest" } });
    if (page.turns.length === 0) {
      throw new Error(JSON.stringify(page.coverage));
    }
    const window = page.turns[0];
    if (!window) {
      throw new Error("Expected a loaded turn");
    }
    const progressive = historyWindowPresentation("stable", window);
    const records: JsonlRecord[] = [];
    const parser = new JsonlStreamParser({ onRecord: (value) => records.push(value) });
    parser.write(bytes, 0);
    parser.finish();
    const legacy = normalizeSession({
      records,
      sourcePath: path,
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
    }).session!;
    for (const activities of [
      progressive.activities,
      legacy.turns.flatMap((turn) => turn.activities),
    ]) {
      const attempts = activities.filter(
        (activity) => activity.presentation?.evidenceKind === "host-attempt",
      );
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({
        name: "exec_command",
        status: "unknown",
        output: null,
        durationMs: null,
        callId: null,
        presentation: { cellId: "cell" },
      });
      expect(activities.find((activity) => activity.id === "native-child")).toMatchObject({
        status: "failed",
        output: "native failure",
        callId: null,
        presentation: { evidenceKind: "native" },
      });
      expect(
        activities.find((activity) => activity.kind === "tool" && activity.name === "exec"),
      ).toMatchObject({
        input: expect.stringContaining("try {"),
        codeMode: { completeness: "complete" },
      });
    }
    expect(
      progressive.entryOrder
        ?.filter((entry) => entry.kind === "activity")
        .map((entry) => {
          const activity = progressive.activities.find((candidate) => candidate.id === entry.id);
          return activity?.kind === "tool" ? activity.name : activity?.kind;
        }),
    ).toEqual(["exec", "exec_command", "wait", "read_file", "exec_command"]);
    const terminalOnly = {
      ...window,
      itemsView: "summary" as const,
      coverage: { ...window.coverage, status: "partial" as const },
      items: window.items.filter((entry) =>
        entry.item?.type === "dynamicToolCall"
          ? entry.item.tool === "wait"
          : entry.item?.type === "functionCallOutput" && entry.item.name === "wait",
      ),
    };
    const terminal = historyWindowPresentation("stable", terminalOnly);
    expect(
      terminal.activities.find((activity) => activity.kind === "tool" && activity.name === "wait"),
    ).toMatchObject({ codeMode: { completeness: "complete", loadedCoverage: "partial" } });
    expect(
      terminal.activities.filter(
        (activity) => activity.presentation?.evidenceKind === "host-attempt",
      ),
    ).toMatchObject([{ name: "read_file", status: "unknown", output: null }]);
    const attempt = progressive.activities.find(
      (activity) => activity.presentation?.evidenceKind === "host-attempt",
    )!;
    expect(progressive.entryOrder).toContainEqual({ kind: "activity", id: attempt.id });
    const outerActivity = progressive.activities.find(
      (activity) => activity.kind === "tool" && activity.callId === "outer",
    );
    expect(outerActivity?.id).not.toBe("outer");
    const tailOnly = {
      ...window,
      items: window.items.filter((entry) => entry.itemId !== outerActivity?.id),
    };
    expect(
      historyWindowPresentation("stable", tailOnly).activities.find(
        (activity) => activity.presentation?.evidenceKind === "host-attempt",
      )?.id,
    ).toBe(attempt.id);
    const details = attempt.presentation?.details;
    const deltaId =
      details !== null && typeof details === "object" && !Array.isArray(details)
        ? details["sourceEventId"]
        : null;
    expect(typeof deltaId).toBe("string");
    const unresolved = {
      ...window,
      contentRevision: "new-partial",
      items: window.items.map((entry) =>
        entry.itemId === deltaId ? { ...entry, detail: "unresolved" as const } : entry,
      ),
    };
    expect(
      historyWindowInspector("stable", unresolved, { type: "activity", id: attempt.id })
        ?.historySnapshot,
    ).toMatchObject({ detail: "unresolved", contentRevision: "new-partial" });
    const inspection = historyWindowInspector("stable", window, {
      type: "activity",
      id: attempt.id,
    });
    expect(inspection?.historySnapshot).toMatchObject({
      historyEpoch: page.historyEpoch,
      contentRevision: page.contentRevision,
      physicalRolloutId: "physical",
      itemId: outerActivity?.id,
    });
    expect(JSON.stringify(inspection?.rawRecords)).toContain("try {");
    expect(JSON.stringify(inspection?.rawRecords)).toContain("executed_tool_calls");
    expect(
      window.items.find((item) => item.itemId === "native-child")?.decodedByteStart,
    ).toBeGreaterThan(0);
  } finally {
    await pager.close();
    await store.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
