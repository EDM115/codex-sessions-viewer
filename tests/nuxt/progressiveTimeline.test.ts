import { describe, expect, it, vi } from "vitest";

import { mergeHistoryWindows, retainHistoryWindows } from "#shared/timeline/history.ts";
import { historyWindowInspector } from "#shared/timeline/historyPresentation.ts";
import type {
  HistoryPage,
  HistoryTurnWindow,
  HistoryPresentation,
  HistoryPresentationRequest,
} from "#shared/types/history.ts";
import type { ConversationRepository } from "#shared/types/repository.ts";
import { useProgressiveHistoryTimeline } from "~/composables/useConversationTimeline.ts";

function window(turnId = "tail", start = 900): HistoryTurnWindow {
  return {
    turnId,
    physicalRolloutId: "physical",
    historyEpoch: "epoch",
    contentRevision: "a",
    order: start,
    orderKind: "decodedByte",
    status: "unknown",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    opening: { itemId: null, item: null, availability: "notLoaded" },
    items: [
      {
        physicalRolloutId: "physical",
        itemId: "answer",
        ordinal: null,
        updatedAtOrdinal: null,
        decodedByteStart: start,
        decodedByteEnd: start + 10,
        updatedAtDecodedByte: start,
        detail: "full",
        item: {
          id: "answer",
          type: "agentMessage",
          text: "current",
          startedAtMs: null,
          completedAtMs: null,
          evidence: null,
          phase: null,
          memoryCitation: null,
          delivery: null,
          questions: null,
        },
      },
    ],
    itemsView: "summary",
    beforeCursor: "items-before",
    afterCursor: null,
    loadedRanges: [
      {
        physicalRolloutId: "physical",
        startOrdinal: null,
        endOrdinalExclusive: null,
        startDecodedByte: start,
        endDecodedByteExclusive: start + 10,
      },
    ],
    coverage: {
      status: "partial",
      segments: [],
      gaps: [
        {
          physicalRolloutId: "physical",
          turnId,
          reason: "unloaded",
          beforeOrdinal: null,
          afterOrdinal: null,
        },
      ],
    },
    finalAnswerItemId: null,
  };
}
function page(turns = [window()]): HistoryPage {
  return {
    threadId: "thread",
    historyEpoch: "epoch",
    contentRevision: "a",
    metadataRevision: "meta",
    turns,
    beforeCursor: "before",
    afterCursor: null,
    preparation: "partial",
    coverage: { status: "partial", segments: [], gaps: [] },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
function messageText(turn: HistoryTurnWindow, text: string) {
  const item = turn.items[0]?.item;
  if (item?.type !== "agentMessage") {
    throw new Error("Expected fixture agent message");
  }
  item.text = text;
}

describe("progressive timeline publication", () => {
  it("does not prepare a hidden assistant tail as a final answer when native final identity is explicitly absent", async () => {
    const prepare = vi.fn<ConversationRepository["prepareHistoryPresentation"]>();
    const result = page();
    const timeline = useProgressiveHistoryTimeline({
      sessionId: "thread",
      repository: {
        getHistoryPage: async () => result,
        getTurnItems: async () => result.turns[0]!,
        prepareHistoryPresentation: prepare,
      },
    });
    await timeline.refresh();
    expect(prepare).not.toHaveBeenCalled();
    timeline.dispose();
  });
  it("retains raw review evidence without promoting stale or unresolved logical visibility", () => {
    const original = window();
    const record = {
      envelope: { method: "item/autoApprovalReview/started", params: { reviewId: "review" } },
      identity: {
        codexHomeId: "home",
        physicalRolloutId: "physical",
        ordinal: 20,
        decodedByteStart: 900,
        decodedByteEnd: 910,
        rangeSha256: "a".repeat(64),
        correlationKeys: [],
      },
      logicalVisibility: "visible" as const,
    };
    original.reviewEvidence = {
      availability: "partial",
      records: [
        record,
        {
          ...record,
          identity: { ...record.identity, decodedByteStart: 700 },
          logicalVisibility: "context-only",
        },
      ],
    };
    const retained = retainHistoryWindows([original], "b")[0]!;
    expect(retained.reviewEvidence).toMatchObject({
      availability: "unresolved",
      records: [
        { logicalVisibility: "unresolved", envelope: record.envelope },
        { logicalVisibility: "context-only" },
      ],
    });
    const next = { ...window(), contentRevision: "b" };
    const merged = mergeHistoryWindows([original], [next])[0]!;
    expect(merged.reviewEvidence?.records.map((entry) => entry.logicalVisibility)).toEqual([
      "unresolved",
      "context-only",
    ]);
    next.reviewEvidence = { availability: "partial", records: [record] };
    const requalified = mergeHistoryWindows([merged], [next])[0]!;
    expect(requalified.reviewEvidence?.records.map((entry) => entry.logicalVisibility)).toEqual([
      "visible",
      "context-only",
    ]);
    expect(original.reviewEvidence.records[0]?.logicalVisibility).toBe("visible");
  });
  it("keeps omitted items and the opening unresolved across a newer partial revision until bounded item rereads qualify them", async () => {
    const old = window();
    const older = {
      ...old.items[0]!,
      itemId: "older",
      decodedByteStart: 600,
      decodedByteEnd: 610,
      updatedAtDecodedByte: 600,
      item: { ...old.items[0]!.item!, id: "older" },
    };
    old.items.unshift(older);
    old.opening = {
      itemId: "opening",
      availability: "available",
      item: {
        id: "opening",
        type: "userMessage",
        text: "OLD OPENING",
        content: [],
        clientId: null,
        startedAtMs: null,
        completedAtMs: null,
        evidence: null,
      },
    };
    const latest = window();
    latest.contentRevision = "b";
    const items = deferred<HistoryTurnWindow>();
    const prepare = vi.fn<ConversationRepository["prepareHistoryPresentation"]>(async (query) => ({
      ...query,
      body: { type: "document" as const, children: [] },
    }));
    const timeline = useProgressiveHistoryTimeline({
      sessionId: "thread",
      initialPage: page([old]),
      repository: {
        getHistoryPage: async () => ({ ...page([latest]), contentRevision: "b" }),
        getTurnItems: () => items.promise,
        prepareHistoryPresentation: prepare,
      },
    });
    await timeline.refresh();
    const retained = timeline.windows.value[0]!;
    expect(retained.items.find((item) => item.itemId === "older")?.detail).toBe("unresolved");
    expect(retained.opening.availability).toBe("unresolved");
    expect(
      historyWindowInspector("thread", retained, { type: "message", id: "older" })?.historySnapshot
        ?.detail,
    ).toBe("unresolved");
    expect(timeline.stale.value).toBe(true);
    expect(
      prepare.mock.calls.some(([query]) => query.itemId === "older" || query.itemId === "opening"),
    ).toBe(false);
    const pending = timeline.loadItems("tail", { kind: "before", cursor: "items-before" });
    expect(timeline.windows.value[0]!.items.find((item) => item.itemId === "older")?.detail).toBe(
      "unresolved",
    );
    const rechecked = {
      ...latest,
      items: [
        {
          ...older,
          detail: "full" as const,
          updatedAtDecodedByte: 1200,
          item: {
            ...older.item,
            type: "agentMessage" as const,
            text: "UPDATED OLDER",
            phase: null,
            memoryCitation: null,
            delivery: null,
            questions: null,
          },
        },
      ],
      beforeCursor: null,
      opening: {
        ...old.opening,
        item: old.opening.item && { ...old.opening.item, text: "CURRENT OPENING" },
      },
    };
    items.resolve(rechecked);
    await pending;
    expect(timeline.windows.value[0]!.items.find((item) => item.itemId === "older")).toMatchObject({
      detail: "full",
      decodedByteStart: 600,
      updatedAtDecodedByte: 1200,
      item: { text: "UPDATED OLDER" },
    });
    expect(timeline.windows.value[0]!.opening.availability).toBe("available");
    expect(timeline.stale.value).toBe(false);
    expect(
      historyWindowInspector("thread", timeline.windows.value[0]!, { type: "message", id: "older" })
        ?.historySnapshot?.detail,
    ).toBe("full");
    timeline.dispose();
  });
  it("compares native and raw positions only in shared units across updates, ranges and turn order", () => {
    const native = window("tail", 900);
    native.order = 2;
    native.orderKind = "ordinal";
    native.decodedByteOrder = 800;
    native.items[0]!.ordinal = 4;
    native.items[0]!.updatedAtOrdinal = 8;
    native.items[0]!.updatedAtDecodedByte = 1500;
    native.loadedRanges[0]!.startOrdinal = 4;
    native.loadedRanges[0]!.endOrdinalExclusive = 5;
    const raw = window("tail", 600);
    raw.decodedByteOrder = 500;
    raw.items[0]!.updatedAtDecodedByte = 1200;
    const merged = mergeHistoryWindows([native], [raw])[0]!;
    expect(merged.orderKind).toBe("decodedByte");
    expect(merged.order).toBe(600);
    expect(merged.decodedByteOrder).toBe(500);
    expect(merged.items[0]!.updatedAtDecodedByte).toBe(1500);
    expect(merged.items[0]!.decodedByteStart).toBe(900);
    expect(merged.loadedRanges.map((range) => range.startDecodedByte)).toEqual([600, 900]);
    const newer = window("tail", 900);
    newer.items[0]!.updatedAtDecodedByte = 1600;
    expect(mergeHistoryWindows([merged], [newer])[0]!.items[0]!.updatedAtDecodedByte).toBe(1600);
    const laterSegment = { ...window("later", 1), segmentOrder: 1, decodedByteOrder: 1 };
    expect(mergeHistoryWindows([laterSegment], [merged]).map((turn) => turn.turnId)).toEqual([
      "tail",
      "later",
    ]);
  });
  it("keeps unknown persisted coordinates unresolved instead of comparing bytes against ordinals", () => {
    const persisted = window();
    persisted.order = 2;
    persisted.orderKind = "ordinal";
    persisted.items[0]!.ordinal = 4;
    persisted.items[0]!.updatedAtOrdinal = 8;
    delete persisted.items[0]!.decodedByteStart;
    delete persisted.items[0]!.decodedByteEnd;
    delete persisted.items[0]!.updatedAtDecodedByte;
    const incoming = window();
    const merged = mergeHistoryWindows([persisted], [incoming])[0]!;
    expect(merged.items[0]!.ordinal).toBe(4);
    expect(merged.items[0]!.updatedAtDecodedByte).toBeUndefined();
    expect(merged.items[0]!.detail).toBe("unresolved");
    expect(merged.order).toBe(900);
  });
  it("rejects a late formatting response after a newer source revision is displayed", async () => {
    const gate = deferred<HistoryPresentation>();
    let first: HistoryPresentationRequest | undefined;
    const a = window();
    a.finalAnswerItemId = "answer";
    messageText(a, "**A**");
    const b = structuredClone(a);
    b.contentRevision = "b";
    messageText(b, "**B**");
    let current = page([a]);
    const timeline = useProgressiveHistoryTimeline({
      sessionId: "thread",
      repository: {
        getHistoryPage: async () => current,
        getTurnItems: async () => b,
        prepareHistoryPresentation: async (query) => {
          if (query.markdown === "**A**") {
            first = query;
            return gate.promise;
          }
          return { ...query, body: { type: "document", children: [{ type: "text", text: "B" }] } };
        },
      },
    });
    await timeline.refresh();
    current = { ...page([b]), contentRevision: "b" };
    await timeline.refresh();
    await vi.waitFor(() => expect(timeline.presentations.value[0]?.markdown).toBe("**B**"));
    if (!first) {
      throw new Error("Expected pending A presentation");
    }
    gate.resolve({ ...first, body: { type: "document", children: [{ type: "text", text: "A" }] } });
    await gate.promise;
    await nextTick();
    expect(timeline.presentations.value.map((entry) => entry.markdown)).toEqual(["**B**"]);
    expect(timeline.windows.value[0]?.contentRevision).toBe("b");
    expect(timeline.loading.value).toBe(false);
    timeline.dispose();
  });
  it("keeps the existing window key and an actual gap after a proved prefix/tail alias, and does not overwrite qualified detail with unresolved payload", async () => {
    const incoming = window("prefix", 10);
    incoming.boundary = {
      status: "verified",
      sourceTurnId: null,
      decodedByteStart: 10,
      identityAliases: ["tail"],
    };
    if (!incoming.items[0]) {
      throw new Error("Expected fixture prompt position");
    }
    incoming.items[0].itemId = "prompt";
    incoming.items[0].item = {
      id: "prompt",
      type: "userMessage",
      text: "question",
      content: [],
      clientId: null,
      startedAtMs: null,
      completedAtMs: null,
      evidence: null,
    };
    incoming.opening = {
      availability: "available",
      item: incoming.items[0].item,
      itemId: "prompt",
    };
    const repository = {
      getHistoryPage: vi.fn<ConversationRepository["getHistoryPage"]>(async () => ({
        ...page([incoming]),
        beforeCursor: null,
      })),
      getTurnItems: vi.fn<ConversationRepository["getTurnItems"]>(async () => incoming),
    };
    const timeline = useProgressiveHistoryTimeline({
      sessionId: "thread",
      repository,
      initialPage: page(),
    });
    await timeline.loadBefore();
    if (!timeline.windows.value[0]) {
      throw new Error("Expected merged window");
    }
    expect(timeline.windows.value.map((entry) => entry.turnId)).toEqual(["tail"]);
    expect(timeline.windows.value[0].items.map((item) => item.itemId)).toEqual([
      "prompt",
      "answer",
    ]);
    expect(timeline.windows.value[0].loadedRanges).toHaveLength(2);
    expect(timeline.windows.value[0].coverage.gaps).not.toHaveLength(0);
    const stale = window();
    stale.contentRevision = "newer-partial";
    if (!stale.items[0]) {
      throw new Error("Expected fixture answer position");
    }
    stale.items[0].detail = "unresolved";
    messageText(stale, "old");
    repository.getTurnItems.mockResolvedValue(stale);
    await timeline.loadItems("tail", { kind: "latest" });
    if (!timeline.windows.value[0]) {
      throw new Error("Expected preserved window");
    }
    expect(timeline.windows.value[0].items.at(-1)?.item).toMatchObject({ text: "current" });
    expect(timeline.windows.value[0].items.at(-1)?.detail).toBe("unresolved");
    timeline.dispose();
  });

  it("cancels a pending prepend for a target, fences its late response, retains displayed work, and aborts all requests on selection disposal", async () => {
    const before = deferred<HistoryPage>();
    const target = deferred<HistoryPage>();
    const signals: AbortSignal[] = [];
    const repository = {
      getHistoryPage: vi.fn<ConversationRepository["getHistoryPage"]>((_id, query, options) => {
        if (!options?.signal) {
          throw new Error("Expected propagated cancellation");
        }
        signals.push(options.signal);
        return query.anchor.kind === "before" ? before.promise : target.promise;
      }),
      getTurnItems: vi.fn<ConversationRepository["getTurnItems"]>(),
    };
    const timeline = useProgressiveHistoryTimeline({
      sessionId: "thread",
      repository,
      initialPage: page(),
    });
    const pendingBefore = timeline.loadBefore();
    const pendingTarget = timeline.loadTarget("wanted");
    expect(signals[0]?.aborted).toBe(true);
    expect(timeline.windows.value[0]?.turnId).toBe("tail");
    target.resolve(page([window("wanted", 20)]));
    await pendingTarget;
    before.resolve(page([window("obsolete", 0)]));
    await pendingBefore;
    expect(timeline.windows.value.map((entry) => entry.turnId)).toEqual(["wanted", "tail"]);
    const refresh = timeline.refresh();
    timeline.dispose();
    expect(signals.at(-1)?.aborted).toBe(true);
    await refresh;
  });
});

// oxlint-disable no-await-in-loop -- Each page request consumes the source cursor returned by the previous request
describe("bounded progressive retention", () => {
  it("evicts distant turn pages and lets their stable cursor be read again", async () => {
    const makePage = (start: number) => ({
      ...page(Array.from({ length: 20 }, (_, i) => window(`turn-${start + i}`, start + i))),
      beforeCursor: start > 0 ? `page-${start - 20}` : null,
      afterCursor: `page-${start + 20}`,
    });
    const getHistoryPage = vi.fn<ConversationRepository["getHistoryPage"]>(async (_id, query) => {
      const start = "cursor" in query.anchor ? Number(query.anchor.cursor.slice(5)) : 100;
      return makePage(start);
    });
    const timeline = useProgressiveHistoryTimeline({
      sessionId: "thread",
      repository: { getHistoryPage, getTurnItems: async () => window() },
    });
    await timeline.refresh();
    for (let i = 0; i < 5; i++) {
      await timeline.loadBefore();
    }
    expect(timeline.windows.value.length).toBeLessThanOrEqual(60);
    expect(timeline.page.value?.turns.length).toBeLessThanOrEqual(20);
    for (let i = 0; i < 5; i++) {
      await timeline.loadAfter();
    }
    expect(timeline.error.value).toBeNull();
    expect(timeline.windows.value.some((entry) => entry.turnId === "turn-119")).toBe(true);
    expect(timeline.windows.value.length).toBeLessThanOrEqual(60);
    timeline.dispose();
  });
  it("bounds simultaneous rich requests while all requested messages eventually settle", async () => {
    let active = 0;
    let peak = 0;
    const waiting: Array<() => void> = [];
    const prepare = vi.fn<ConversationRepository["prepareHistoryPresentation"]>(async (query) => {
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => waiting.push(resolve));
      active--;
      return { ...query, body: { type: "document", children: [] } };
    });
    const turns = Array.from({ length: 20 }, (_, i) => ({
      ...window(`turn-${i}`, i),
      finalAnswerItemId: "answer",
    }));
    const timeline = useProgressiveHistoryTimeline({
      sessionId: "thread",
      repository: {
        getHistoryPage: async () => page(turns),
        getTurnItems: async () => window(),
        prepareHistoryPresentation: prepare,
      },
    });
    await timeline.refresh();
    expect(peak).toBeLessThanOrEqual(2);
    timeline.dispose();
    waiting.forEach((resolve) => resolve());
  });
});

it("bounds a giant turn's item payloads while retaining opening islands and reloadable cursor owners", async () => {
  function slice(start: number): HistoryTurnWindow {
    const result = window("owner", start);
    result.boundary = {
      status: "verified",
      sourceTurnId: "tail",
      decodedByteStart: 0,
      identityAliases: ["tail"],
    };
    result.items = Array.from({ length: 100 }, (_, i) => {
      const itemId = `item-${start + i}`;
      return {
        ...result.items[0]!,
        itemId,
        decodedByteStart: start + i,
        decodedByteEnd: start + i + 1,
        item: { ...result.items[0]!.item!, id: itemId },
      };
    });
    result.beforeCursor = start > 0 ? `items-${start}` : null;
    result.afterCursor = start < 500 ? `items-${start + 100}` : null;
    result.loadedRanges = [
      {
        physicalRolloutId: "physical",
        startOrdinal: null,
        endOrdinalExclusive: null,
        startDecodedByte: start,
        endDecodedByteExclusive: start + 100,
      },
    ];
    result.finalAnswerItemId = "item-599";
    return result;
  }
  const initial = { ...slice(500), turnId: "tail" };
  const getTurnItems = vi.fn<ConversationRepository["getTurnItems"]>(async (_id, query) => {
    const cursor = "cursor" in query.anchor ? Number(query.anchor.cursor.slice(6)) : 500;
    return slice(query.anchor.kind === "before" ? cursor - 100 : cursor);
  });
  const timeline = useProgressiveHistoryTimeline({
    sessionId: "thread",
    initialPage: page([initial]),
    repository: { getHistoryPage: async () => page([initial]), getTurnItems },
  });
  for (let i = 0; i < 5; i++) {
    const cursor = timeline.windows.value[0]!.beforeCursor!;
    await timeline.loadItems("tail", { kind: "before", cursor });
    expect(timeline.windows.value[0]!.items.length).toBeLessThanOrEqual(300);
  }
  const retained = timeline.windows.value[0]!;
  expect(retained.turnId).toBe("tail");
  expect(retained.finalAnswerItemId).toBe("item-599");
  expect(retained.coverage.status).toBe("partial");
  for (let i = 0; i < 5 && timeline.windows.value[0]!.afterCursor; i++) {
    await timeline.loadItems("tail", {
      kind: "after",
      cursor: timeline.windows.value[0]!.afterCursor,
    });
    expect(timeline.windows.value[0]!.items.length).toBeLessThanOrEqual(300);
  }
  expect(timeline.error.value).toBeNull();
  expect(getTurnItems.mock.calls.some(([, query]) => query.turnId === "owner")).toBe(true);
  expect(timeline.windows.value[0]!.items.some((item) => item.itemId === "item-599")).toBe(true);
  timeline.dispose();
});

it("prepares reasoning only when its expanded source identity is requested", async () => {
  const source = window();
  source.items[0]!.item = {
    id: "answer",
    type: "reasoning",
    summary: ["**Summary**"],
    content: ["Details"],
    startedAtMs: null,
    completedAtMs: null,
    evidence: null,
  };
  const prepare = vi.fn<ConversationRepository["prepareHistoryPresentation"]>(async (query) => ({
    ...query,
    body: { type: "document", children: [{ type: "text", text: query.markdown }] },
  }));
  const timeline = useProgressiveHistoryTimeline({
    sessionId: "thread",
    repository: {
      getHistoryPage: async () => page([source]),
      getTurnItems: async () => source,
      prepareHistoryPresentation: prepare,
    },
  });
  timeline.setVisible([JSON.stringify(["physical", "tail"])]);
  await timeline.refresh();
  expect(prepare).not.toHaveBeenCalled();
  timeline.setExpanded([`${JSON.stringify(["physical", "tail"])}:answer`]);
  await vi.waitFor(() => expect(timeline.presentations.value).toHaveLength(1));
  expect(prepare.mock.calls[0]?.[0]).toMatchObject({
    itemId: "answer",
    markdown: "**Summary**\nDetails",
    contentRevision: "a",
  });
  timeline.dispose();
});

it("keeps repeated-cursor protection for retained items when unrelated turn pages are evicted", async () => {
  let start = 0;
  const initial = { ...page([window("tail", 1000)]), afterCursor: "next-0" };
  const items = { ...window("tail", 1000), beforeCursor: "advanced" };
  const timeline = useProgressiveHistoryTimeline({
    sessionId: "thread",
    initialPage: initial,
    repository: {
      getTurnItems: async () => items,
      getHistoryPage: async () => {
        const result = {
          ...page(
            Array.from({ length: 20 }, (_, i) => ({
              ...window(`filler-${start + i}`, 1001 + start + i),
              beforeCursor: `filler-cursor-${start + i}`,
            })),
          ),
          afterCursor: `next-${start + 20}`,
        };
        start += 20;
        return result;
      },
    },
  });
  timeline.setVisible([JSON.stringify(["physical", "tail"])]);
  await timeline.loadItems("tail", { kind: "before", cursor: "items-before" });
  for (let i = 0; i < 4; i++) {
    await timeline.loadAfter();
  }
  expect(timeline.windows.value.length).toBe(60);
  expect(timeline.windows.value.some((entry) => entry.turnId === "tail")).toBe(true);
  await timeline.loadItems("tail", { kind: "before", cursor: "items-before" });
  expect(timeline.error.value).toContain("cursor did not advance");
  timeline.dispose();
});
