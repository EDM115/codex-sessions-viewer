import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { CACHE_PARSER_VERSION } from "#server/cache/sourceManifest.ts";
import { writeStaticPayloads } from "#server/export/writeStaticPayloads.ts";
import { completeHistoryPage } from "#server/history/completeHistory.ts";
import { RolloutHistoryReader } from "#server/history/rolloutHistoryReader.ts";
import { readCompleteRollout } from "#server/ingestion/completeRollout.ts";
import { RolloutStore } from "#server/ingestion/rolloutStream.ts";
import { StaticConversationRepository } from "~/repositories/static.ts";

import { normalizedRolloutFixture } from "../../fixtures/cache/normalized.ts";
import {
  canonicalRecords,
  fixtureLineage,
  fixtureRef,
} from "../../fixtures/history/nativeHistory.ts";

it("caches genuine HTTP 404 absence from the default browser requester", async () => {
  const requester = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("not found", { status: 404 }));
  try {
    const repository = new StaticConversationRepository();
    await expect(repository.supportsHistory("stable")).resolves.toBe(false);
    await expect(repository.supportsHistory("stable")).resolves.toBe(false);
    expect(requester).toHaveBeenCalledTimes(1);
  } finally {
    requester.mockRestore();
  }
});
it.each(["500", "invalid-json", "null", "malformed", "wrong-owner", "abort"])(
  "distinguishes genuine absence from recoverable failures through the default browser requester (%s)",
  async (kind) => {
    const manifest = {
      version: 1,
      threadId: "stable",
      metadataRevision: null,
      historyEpoch: "epoch",
      contentRevision: "revision",
      preparation: "ready",
      coverage: { status: "complete", segments: [], gaps: [] },
      turns: [],
    };
    const requester = vi.spyOn(globalThis, "fetch");
    requester.mockImplementationOnce(async () => {
      if (kind === "abort") {
        throw new DOMException("aborted", "AbortError");
      }
      if (kind === "500") {
        return new Response("unavailable", { status: Number(kind) });
      }
      return new Response(
        kind === "invalid-json"
          ? "{truncated"
          : kind === "null"
            ? "null"
            : kind === "malformed"
              ? "{}"
              : JSON.stringify({ ...manifest, threadId: "foreign" }),
        { status: 200 },
      );
    });
    requester.mockImplementation(async () => Response.json(manifest));
    try {
      const repository = new StaticConversationRepository();
      await expect(repository.supportsHistory("stable")).rejects.toBeInstanceOf(Error);
      await expect(repository.supportsHistory("stable")).resolves.toBe(true);
      expect(requester).toHaveBeenCalledTimes(2);
    } finally {
      requester.mockRestore();
    }
  },
);

it.each([
  Object.assign(new Error("server"), { statusCode: 500 }),
  new SyntaxError("truncated JSON"),
  new DOMException("cancelled", "AbortError"),
])("propagates history manifest failures and retries after %s", async (failure) => {
  let calls = 0;
  const repository = new StaticConversationRepository(async () => {
    calls += 1;
    if (calls === 1) {
      throw failure;
    }
    throw Object.assign(new Error("not found"), { statusCode: 404 });
  });
  await expect(repository.supportsHistory("stable")).rejects.toBe(failure);
  await expect(repository.supportsHistory("stable")).resolves.toBe(false);
  expect(calls).toBe(2);
});

it("serves saved source-qualified history and rich text through the actual static repository without manufacturing old archive history", async () => {
  const root = await mkdtemp(join(tmpdir(), "static-history-"));
  const path = join(root, "source.jsonl");
  const store = new RolloutStore({ cacheDirectory: join(root, "decoded") });
  try {
    await writeFile(
      path,
      canonicalRecords("**Saved answer**")
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const ref = fixtureRef(path);
    const page = await new RolloutHistoryReader({
      open: (source, signal) => store.open(source, signal),
    }).read(fixtureLineage(ref), { anchor: { kind: "latest" } });
    expect(page.turns).toHaveLength(1);
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: path,
      scope: "active",
      revision: "summary",
      root: true,
    });
    conversation.summary.id = "stable";
    await writeStaticPayloads([conversation], {
      generatedRoot: root,
      histories: new Map([["stable", page]]),
    });
    const requested: string[] = [];
    const repository = new StaticConversationRepository(async (request) => {
      requested.push(request);
      return JSON.parse(await readFile(join(root, request), "utf8")) as unknown;
    });
    const saved = await repository.getHistoryPage("stable", { anchor: { kind: "latest" } });
    expect(saved.historyEpoch).toBe(page.historyEpoch);
    expect(saved.turns[0]?.items).toEqual(page.turns[0]?.items);
    expect(saved.turns[0]?.loadedRanges).toEqual(page.turns[0]?.loadedRanges);
    const window = saved.turns[0]!;
    const rich = await repository.prepareHistoryPresentation({
      threadId: "stable",
      historyEpoch: page.historyEpoch,
      contentRevision: page.contentRevision,
      physicalRolloutId: window.physicalRolloutId,
      turnId: window.turnId,
      itemId: "answer",
      markdown: "**Saved answer**",
    });
    expect(JSON.stringify(rich.body)).toContain('"tagName":"strong"');
    await expect(
      repository.prepareHistoryPresentation({ ...rich, markdown: "changed" }),
    ).rejects.toThrow();
    expect(requested.some((request) => request.includes("history"))).toBe(true);
    const legacy = new StaticConversationRepository(async () => {
      throw Object.assign(new Error("Not available in this v1 archive"), { statusCode: 404 });
    });
    await expect(
      legacy.getHistoryPage("old", { anchor: { kind: "latest" } }),
    ).rejects.toMatchObject({ code: "history.unsupported" });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("pages giant saved turns with exact requested item limits and rejects foreign cursors", async () => {
  const root = await mkdtemp(join(tmpdir(), "static-items-"));
  const path = join(root, "source.jsonl");
  const store = new RolloutStore({ cacheDirectory: join(root, "decoded") });
  try {
    const records = canonicalRecords("final");
    const extra = Array.from({ length: 205 }, (_, index) => ({
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn",
        item: {
          type: "AgentMessage",
          id: `message-${index}`,
          content: [{ type: "Text", text: `message ${index}` }],
          phase: "commentary",
        },
      },
    }));
    await writeFile(
      path,
      [...records.slice(0, 3), ...extra, ...records.slice(3)]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const full = await readCompleteRollout(
      { ...fixtureRef(path), stableThreadId: "stable" },
      { resolve: async () => null },
      (ref, signal) => store.open(ref, signal),
      CACHE_PARSER_VERSION,
    );
    const history = completeHistoryPage(full);
    expect(history.turns[0]?.items).toHaveLength(207);
    const conversation = await normalizedRolloutFixture({
      name: "modern.jsonl",
      sourcePath: path,
      scope: "active",
      revision: "items",
      root: true,
    });
    conversation.summary.id = "stable";
    await writeStaticPayloads([conversation], {
      generatedRoot: root,
      histories: new Map([["stable", history]]),
    });
    const repository = new StaticConversationRepository(
      async (request) => JSON.parse(await readFile(join(root, request), "utf8")) as unknown,
    );
    const opening = await repository.getTurnItems("stable", {
      turnId: "turn",
      anchor: { kind: "opening" },
      limit: 2,
    });
    expect(opening.items).toHaveLength(2);
    expect(opening.opening.item).toMatchObject({ type: "userMessage", text: "question" });
    const latest = await repository.getTurnItems("stable", {
      turnId: "turn",
      anchor: { kind: "latest" },
      limit: 80,
    });
    expect(latest.items).toHaveLength(80);
    expect(latest.items.at(-1)?.itemId).toBe("answer");
    expect(latest.beforeCursor).not.toBeNull();
    const older = await repository.getTurnItems("stable", {
      turnId: "turn",
      anchor: { kind: "before", cursor: latest.beforeCursor! },
      limit: 80,
    });
    expect(older.items).toHaveLength(80);
    expect(
      older.items.some((item) => latest.items.some((other) => item.itemId === other.itemId)),
    ).toBe(false);
    await expect(
      repository.getHistoryPage("stable", {
        anchor: { kind: "before", cursor: latest.beforeCursor! },
      }),
    ).rejects.toThrow("owner_mismatch");
    expect(latest.coverage.status).toBe("partial");
    const directory = join(root, "payloads/sessions/stable");
    expect((await readdir(directory)).filter((name) => name.startsWith("history-"))).toHaveLength(
      4,
    );
    await writeStaticPayloads([conversation], {
      generatedRoot: root,
      histories: new Map([
        [
          "stable",
          {
            ...history,
            turns: [{ ...history.turns[0]!, items: history.turns[0]!.items.slice(0, 2) }],
          },
        ],
      ]),
    });
    expect((await readdir(directory)).filter((name) => name.startsWith("history-"))).toEqual([
      "history-0-0.json",
      "history-index.json",
    ]);
    await writeStaticPayloads([conversation], { generatedRoot: root });
    expect((await readdir(directory)).filter((name) => name.startsWith("history-"))).toEqual([]);
    const unavailable = new StaticConversationRepository(
      async (request) => JSON.parse(await readFile(join(root, request), "utf8")) as unknown,
    );
    expect(await unavailable.supportsHistory("stable")).toBe(false);
    await expect(
      unavailable.getHistoryPage("stable", { anchor: { kind: "latest" } }),
    ).rejects.toMatchObject({ code: "history.unsupported" });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
