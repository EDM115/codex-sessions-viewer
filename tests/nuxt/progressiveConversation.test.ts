import { mountSuspended, mockComponent } from "@nuxt/test-utils/runtime";
import { flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationAttachment, ConversationInspector, ConversationTurn } from "#components";
import * as activityPresentation from "#shared/timeline/activityPresentation.ts";
import * as codeMode from "#shared/timeline/codeMode.ts";
import { retainHistoryWindows } from "#shared/timeline/history.ts";
import type {
  ConversationTurn as LegacyTurn,
  ConversationSummary,
} from "#shared/types/conversation.ts";
import type {
  HistoryNavigatorPage,
  HistoryPage,
  HistoryTurnWindow,
} from "#shared/types/history.ts";
import { catalogSessionMetadataSchema } from "#shared/types/library.ts";
import type { ResolvedAsset, ViewerInvalidation } from "#shared/types/repository.ts";
import ProgressiveConversationView from "~/components/conversation/ProgressiveConversationView.vue";
import type { useProgressiveHistoryTimeline } from "~/composables/useConversationTimeline.ts";
import type { useMeasuredConversationViewport } from "~/composables/useMeasuredConversationViewport.ts";
import { usePresentationSettings } from "~/composables/usePresentationSettings.ts";
import { useScrollAnchoring } from "~/composables/useScrollAnchoring.ts";
import { LiveApiConversationRepository } from "~/repositories/live.ts";
import { StaticConversationRepository } from "~/repositories/static.ts";

mockComponent("MediaViewer", () => ({
  name: "MediaViewer",
  props: ["item"],
  template: "<aside data-progressive-media>{{ item.filename }}</aside>",
}));

// Happy DOM has no layout, semantic mounts provide a viewport for the real measured virtualizer
beforeEach(() => {
  clearNuxtState("conversation-positions");
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
});

const summary: ConversationSummary = {
  id: "thread",
  title: "Visible immediately",
  scope: "active",
  sourcePath: "C:/fixture/source.jsonl",
  createdAt: "2026-10-29T08:00:00.000Z",
  updatedAt: "2026-10-29T08:00:00.000Z",
  cwd: null,
  gitBranch: null,
  gitSha: null,
  gitOriginUrl: null,
  models: [],
  reasoningEfforts: [],
  turnCount: 0,
  assistantMessageCount: 0,
  toolCallCount: 0,
  toolCounts: {},
  preview: "",
  pinned: false,
  sectionName: null,
  parentThreadId: null,
  childThreadIds: [],
  hasMedia: false,
  diagnosticCount: 0,
  revision: "rev",
};

function disjointWindow(): HistoryTurnWindow {
  const prefix = {
    id: "prefix",
    type: "userMessage" as const,
    text: "PREFIX QUESTION",
    content: [],
    clientId: null,
    startedAtMs: null,
    completedAtMs: null,
    evidence: { source: "prefix evidence" },
  };
  const tail = {
    id: "tail",
    type: "agentMessage" as const,
    text: "TAIL ANSWER",
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
    questions: null,
    startedAtMs: null,
    completedAtMs: null,
    evidence: { source: "tail evidence" },
  };
  return {
    turnId: "turn",
    physicalRolloutId: "physical",
    historyEpoch: "epoch",
    contentRevision: "A",
    order: 1,
    status: "completed",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    opening: { itemId: "prefix", item: prefix, availability: "available" },
    items: [prefix, tail].map((item, index) => ({
      physicalRolloutId: "physical",
      itemId: item.id,
      item,
      ordinal: null,
      updatedAtOrdinal: null,
      decodedByteStart: index === 0 ? 10 : 900,
      decodedByteEnd: index === 0 ? 20 : 910,
      updatedAtDecodedByte: index === 0 ? 10 : 900,
      detail: "full" as const,
    })),
    itemsView: "summary",
    beforeCursor: null,
    afterCursor: null,
    finalAnswerItemId: "tail",
    loadedRanges: [10, 900].map((start) => ({
      physicalRolloutId: "physical",
      startOrdinal: null,
      endOrdinalExclusive: null,
      startDecodedByte: start,
      endDecodedByteExclusive: start + 10,
    })),
    coverage: {
      status: "partial",
      segments: [],
      gaps: [
        {
          physicalRolloutId: "physical",
          turnId: "turn",
          reason: "unloaded",
          beforeOrdinal: null,
          afterOrdinal: null,
        },
      ],
    },
  };
}
function historyPage(window: HistoryTurnWindow): HistoryPage {
  return {
    threadId: "thread",
    historyEpoch: window.historyEpoch,
    contentRevision: window.contentRevision,
    metadataRevision: "meta",
    turns: [window],
    beforeCursor: null,
    afterCursor: null,
    preparation: "partial",
    coverage: window.coverage,
  };
}
function pageRepository(window: HistoryTurnWindow) {
  return new LiveApiConversationRepository(async (path) => {
    if (path.includes("/turns")) {
      return historyPage(window);
    }
    if (path.includes("/navigator")) {
      return { ...historyPage(window), turns: [] };
    }
    throw new Error(`Unexpected request ${path}`);
  });
}

// Deterministic retention controls update the producer's ref behind its readonly consumer facade
function publishRetainedWindows(
  timeline: ReturnType<typeof useProgressiveHistoryTimeline>,
  windows: HistoryTurnWindow[],
) {
  expect(Reflect.set(toRaw(timeline.windows), "value", windows)).toBe(true);
}

function pairedMessageWindows(order: "canonical-first" | "echo-first") {
  const source = disjointWindow();
  const tail = source.items[1]!;
  if (tail.item?.type !== "agentMessage") {
    throw new Error("Expected fixture answer");
  }
  const canonical = {
    ...tail,
    itemId: "canonical",
    item: {
      ...tail.item,
      id: "canonical",
      evidence: {
        source: {
          type: "response_item",
          payload: { type: "message", id: "canonical", role: "assistant", phase: "final_answer" },
        },
      },
    },
  };
  const echo = {
    ...tail,
    itemId: "echo",
    item: {
      ...tail.item,
      id: "echo",
      evidence: {
        source: { type: "event_msg", payload: { type: "agent_message", phase: "final_answer" } },
      },
    },
  };
  const ordered = (order === "canonical-first" ? [canonical, echo] : [echo, canonical]).map(
    (item, index) => ({
      ...item,
      decodedByteStart: 900 + index * 10,
      decodedByteEnd: 910 + index * 10,
      updatedAtDecodedByte: 900 + index * 10,
    }),
  );
  const initial = ordered[0]!;
  const selected = ordered[1]!;
  const first: HistoryTurnWindow = {
    ...source,
    finalAnswerItemId: initial.itemId,
    items: [source.items[0]!, initial],
    itemIslands: [["prefix"], [initial.itemId]],
  };
  const joined: HistoryTurnWindow = {
    ...source,
    finalAnswerItemId: selected.itemId,
    items: [source.items[0]!, ...ordered],
    itemIslands: [["prefix"], ordered.map((item) => item.itemId)],
  };
  return { first, joined, initial, selected };
}

function inventoryWindow() {
  const source = disjointWindow();
  const sentinel = '{"unrelatedSentinel":"do not decode for membership"}';
  source.items.push({
    ...source.items[1]!,
    itemId: "outer-output",
    item: {
      id: "outer-output",
      type: "functionCallOutput",
      name: "exec",
      namespace: "functions",
      output: sentinel,
      startedAtMs: null,
      completedAtMs: null,
      evidence: {
        source: {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "outer",
            name: "exec",
            namespace: "functions",
            output: sentinel,
            internal_chat_message_metadata_passthrough: {
              cell_id: "cell",
              executed_tool_calls: [{ name: "read_file", arguments: { path: "benign.txt" } }],
              tool_calls_complete: true,
            },
          },
        },
      },
    },
  });
  return { source, sentinel };
}

describe("progressive and legacy presentation paths", () => {
  it.each(["canonical-first", "echo-first"] as const)(
    "keeps distinct current keys and the selected second reading entry after a same-ID qualification split: %s",
    async (order) => {
      const { first, joined, initial, selected } = pairedMessageWindows(order);
      const repository = pageRepository(first);
      vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
        queueMicrotask(() => callback(performance.now()));
        return 1;
      });
      const wrapper = await mountSuspended(ProgressiveConversationView, {
        props: {
          metadata: catalogSessionMetadataSchema.parse(summary),
          repository,
          targetTurnId: null,
        },
      });
      try {
        await flushPromises();
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- VTU exposes the actual component's retained producer and viewport
        const state = wrapper.vm as unknown as {
          timeline: ReturnType<typeof useProgressiveHistoryTimeline>;
          viewport: ReturnType<typeof useMeasuredConversationViewport>;
          entryRetained(key: string, entry: string): boolean | undefined;
        };
        const originalKey = wrapper
          .get(`[data-message-id="${initial.itemId}"]`)
          .attributes("data-anchor-entry");
        publishRetainedWindows(state.timeline, [joined]);
        await nextTick();
        expect(
          wrapper.get(`[data-message-id="${selected.itemId}"]`).attributes("data-anchor-entry"),
        ).toBe(originalKey);
        const rows = state.viewport.rows.value;
        const mountedRows = vi.spyOn(state.viewport.rows, "value", "get").mockReturnValue([]);
        publishRetainedWindows(
          state.timeline,
          retainHistoryWindows(state.timeline.windows.value, "B"),
        );
        await nextTick();
        expect(wrapper.find("[data-history-turn]").exists()).toBe(false);
        expect(state.timeline.windows.value[0]!.items.map((item) => item.itemId)).toEqual(
          joined.items.map((item) => item.itemId),
        );
        mountedRows.mockReturnValue(rows);
        publishRetainedWindows(
          state.timeline,
          state.timeline.windows.value.map((window) => ({ ...window })),
        );
        await nextTick();
        const keys = wrapper.getComponent(ConversationTurn).props("messageKeys")!;
        expect.soft(new Set([keys[initial.itemId], keys[selected.itemId]]).size).toBe(2);
        expect(`message:${keys[selected.itemId]}`).toBe(originalKey);
        const disclosure = wrapper.get<HTMLDetailsElement>(".conversation-work-stream");
        disclosure.element.open = true;
        await disclosure.trigger("toggle");
        await flushPromises();
        await state.viewport.settle();
        const container = wrapper.get<HTMLElement>(".progressive-conversation").element;
        const canvas = wrapper.get<HTMLElement>(".history-canvas").element;
        const turn = wrapper.get<HTMLElement>("[data-history-turn]").element;
        const reading = wrapper.get<HTMLElement>(`[data-message-id="${selected.itemId}"]`).element;
        let growth = 0;
        container.getBoundingClientRect = () => new DOMRect(0, 0, 800, 800);
        canvas.getBoundingClientRect = () =>
          new DOMRect(0, -container.scrollTop, 800, 3000 + growth);
        turn.getBoundingClientRect = canvas.getBoundingClientRect;
        for (const element of turn.querySelectorAll<HTMLElement>(
          "[data-anchor-entry], [data-message-id]",
        )) {
          element.getBoundingClientRect = () =>
            new DOMRect(
              0,
              (element === reading ? 700 + growth : 100) - container.scrollTop,
              800,
              element === reading ? 1000 : 100,
            );
        }
        container.scrollTop = 800;
        const rowKey = turn.dataset["anchorTurnId"]!;
        const readingSnapshot = useScrollAnchoring(
          ref(container),
          () => 0,
          () => ({ turnId: rowKey, top: -container.scrollTop }),
        ).capture();
        expect(readingSnapshot?.entry).toEqual({ key: originalKey, top: -100 });
        growth = 150;
        await state.viewport.target(rowKey, -800, undefined, readingSnapshot!);
        expect(reading.getBoundingClientRect().top).toBe(-100);
        expect(container.scrollTop).toBe(950);
        expect(state.viewport.follow.value).toBe(false);
        mountedRows.mockRestore();
      } finally {
        wrapper.unmount();
      }
    },
  );
  it.each(["canonical-first", "echo-first"] as const)(
    "bounds current alias ownership through mounted splits, merges, successor eviction and returning seed collisions: %s",
    async (order) => {
      const { first, joined, initial, selected } = pairedMessageWindows(order);
      const wrapper = await mountSuspended(ProgressiveConversationView, {
        props: {
          metadata: catalogSessionMetadataSchema.parse(summary),
          repository: pageRepository(first),
          targetTurnId: null,
        },
      });
      try {
        await flushPromises();
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- VTU checks the production alias registry through immutable retained-window publications
        const state = wrapper.vm as unknown as {
          timeline: ReturnType<typeof useProgressiveHistoryTimeline>;
          messageKeysByIdentity: Map<string, string>;
          entryRetained(key: string, entry: string): boolean | undefined;
        };
        const originalKey = wrapper.getComponent(ConversationTurn).props("messageKeys")![
          initial.itemId
        ]!;
        const keys = () => wrapper.getComponent(ConversationTurn).props("messageKeys")!;
        publishRetainedWindows(state.timeline, [joined]);
        await nextTick();
        for (const change of ["text", "phase", "text", "phase"] as const) {
          const split = {
            ...joined,
            items: joined.items.map((item) =>
              item.itemId === initial.itemId && item.item?.type === "agentMessage"
                ? {
                    ...item,
                    item: {
                      ...item.item,
                      ...(change === "text"
                        ? { text: "Different same-ID content" }
                        : { phase: "commentary" }),
                    },
                  }
                : item,
            ),
          };
          publishRetainedWindows(state.timeline, [split]);
          // oxlint-disable-next-line no-await-in-loop -- Each split must be observed before the following merge
          await nextTick();
          expect(keys()[selected.itemId]).toBe(originalKey);
          expect(new Set([keys()[initial.itemId], keys()[selected.itemId]]).size).toBe(2);
          expect(state.messageKeysByIdentity.size).toBe(3);
          publishRetainedWindows(state.timeline, [joined]);
          // oxlint-disable-next-line no-await-in-loop -- Re-prove the pair before the next same-ID change
          await nextTick();
          expect(keys()[selected.itemId]).toBe(originalKey);
          expect(Object.keys(keys())).toEqual(["prefix", selected.itemId]);
          expect(state.messageKeysByIdentity.size).toBe(3);
        }
        publishRetainedWindows(state.timeline, [
          {
            ...joined,
            finalAnswerItemId: initial.itemId,
            items: joined.items.filter((item) => item.itemId !== selected.itemId),
          },
        ]);
        await nextTick();
        expect(keys()[initial.itemId]).toBe(originalKey);
        expect(state.messageKeysByIdentity.size).toBe(2);
        publishRetainedWindows(state.timeline, [joined]);
        await nextTick();
        expect(keys()[selected.itemId]).toBe(originalKey);
        publishRetainedWindows(state.timeline, [
          { ...joined, items: joined.items.filter((item) => item.itemId !== initial.itemId) },
        ]);
        await nextTick();
        expect(keys()[selected.itemId]).toBe(originalKey);
        expect(state.messageKeysByIdentity.size).toBe(2);
        const returned = {
          ...joined,
          items: joined.items.map((item) =>
            item.itemId === initial.itemId && item.item?.type === "agentMessage"
              ? { ...item, item: { ...item.item, text: "Returning seed is a distinct message" } }
              : item,
          ),
        };
        publishRetainedWindows(state.timeline, [returned]);
        await nextTick();
        expect(keys()[selected.itemId]).toBe(originalKey);
        expect(keys()[initial.itemId]).not.toBe(originalKey);
        expect(new Set(Object.values(keys())).size).toBe(3);
        publishRetainedWindows(state.timeline, [joined]);
        await nextTick();
        publishRetainedWindows(state.timeline, [
          {
            ...joined,
            items: joined.items.map((item) =>
              item.itemId === selected.itemId
                ? {
                    ...item,
                    item: {
                      id: selected.itemId,
                      type: "reasoning" as const,
                      summary: ["Changed kind"],
                      content: [],
                      startedAtMs: null,
                      completedAtMs: null,
                      evidence: null,
                    },
                  }
                : item,
            ),
          },
        ]);
        await nextTick();
        expect(keys()[initial.itemId]).not.toBe(originalKey);
        expect(
          state.entryRetained(
            JSON.stringify([joined.physicalRolloutId, joined.turnId]),
            `message:${originalKey}`,
          ),
        ).toBe(false);
        expect(state.messageKeysByIdentity.size).toBe(2);
      } finally {
        wrapper.unmount();
      }
    },
  );
  it("retires an evicted alias owner when two distinct current classes are possible successors", async () => {
    const { first, joined } = pairedMessageWindows("canonical-first");
    const echo = joined.items.find((item) => item.itemId === "echo")!;
    const echo2 = { ...echo, itemId: "echo-2", item: { ...echo.item!, id: "echo-2" } };
    const grouped = {
      ...joined,
      finalAnswerItemId: "canonical",
      items: [...joined.items, echo2],
      itemIslands: [["prefix"], ["canonical", "echo", "echo-2"]],
    };
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: {
        metadata: catalogSessionMetadataSchema.parse(summary),
        repository: pageRepository(first),
        targetTurnId: null,
      },
    });
    try {
      await flushPromises();
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- VTU publishes the real retained alias class before owner eviction
      const state = wrapper.vm as unknown as {
        timeline: ReturnType<typeof useProgressiveHistoryTimeline>;
        entryRetained(key: string, entry: string): boolean | undefined;
        messageKeysByIdentity: Map<string, string>;
      };
      publishRetainedWindows(state.timeline, [grouped]);
      await nextTick();
      const oldKey = wrapper.getComponent(ConversationTurn).props("messageKeys")!["canonical"]!;
      expect(wrapper.getComponent(ConversationTurn).props("turn").assistantMessages).toHaveLength(
        1,
      );
      publishRetainedWindows(state.timeline, [
        {
          ...grouped,
          finalAnswerItemId: "echo-2",
          items: grouped.items.filter((item) => item.itemId !== "canonical"),
        },
      ]);
      await nextTick();
      const keys = wrapper.getComponent(ConversationTurn).props("messageKeys")!;
      expect(new Set([keys["echo"], keys["echo-2"]]).size).toBe(2);
      expect(Object.values(keys)).not.toContain(oldKey);
      expect(
        state.entryRetained(
          JSON.stringify([joined.physicalRolloutId, joined.turnId]),
          `message:${oldKey}`,
        ),
      ).toBe(false);
      expect(state.messageKeysByIdentity.size).toBe(3);
    } finally {
      wrapper.unmount();
    }
  });
  it("checks hidden message membership without decoding unrelated tool output or Code Mode inventory", async () => {
    const { source, sentinel } = inventoryWindow();
    const repository = pageRepository(source);
    const getPage = vi.spyOn(repository, "getHistoryPage");
    const getItems = vi.spyOn(repository, "getTurnItems");
    const prepare = vi.spyOn(repository, "prepareHistoryPresentation");
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: {
        metadata: catalogSessionMetadataSchema.parse(summary),
        repository,
        targetTurnId: null,
      },
    });
    try {
      await flushPromises();
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- VTU exercises the actual pending-entry predicate with no mounted row
      const state = wrapper.vm as unknown as {
        timeline: ReturnType<typeof useProgressiveHistoryTimeline>;
        viewport: ReturnType<typeof useMeasuredConversationViewport>;
        entryRetained(key: string, entry: string): boolean | undefined;
      };
      const anchorKey = wrapper.get('[data-message-id="tail"]').attributes("data-anchor-entry");
      if (!anchorKey) {
        throw new Error("Expected the rendered message anchor");
      }
      const mountedRows = vi.spyOn(state.viewport.rows, "value", "get").mockReturnValue([]);
      publishRetainedWindows(
        state.timeline,
        state.timeline.windows.value.map((window) => ({ ...window })),
      );
      await nextTick();
      expect(wrapper.find("[data-history-turn]").exists()).toBe(false);
      const requests = [
        getPage.mock.calls.length,
        getItems.mock.calls.length,
        prepare.mock.calls.length,
      ];
      const parse = vi.spyOn(JSON, "parse").mockClear();
      const activity = vi.spyOn(activityPresentation, "historyActivity").mockClear();
      const expand = vi.spyOn(codeMode, "expandRecordedCells").mockClear();
      expect(
        state.entryRetained(JSON.stringify([source.physicalRolloutId, source.turnId]), anchorKey),
      ).toBe(true);
      expect(
        state.entryRetained(JSON.stringify([source.physicalRolloutId, source.turnId]), anchorKey),
      ).toBe(true);
      expect(parse.mock.calls.filter(([value]) => value === sentinel)).toHaveLength(0);
      expect(activity).not.toHaveBeenCalled();
      expect(expand).not.toHaveBeenCalled();
      expect([
        getPage.mock.calls.length,
        getItems.mock.calls.length,
        prepare.mock.calls.length,
      ]).toEqual(requests);
      parse.mockRestore();
      activity.mockRestore();
      expand.mockRestore();
      mountedRows.mockRestore();
    } finally {
      wrapper.unmount();
    }
  });
  it.each(["outer-output", "code-mode:outer-output:attempt:0"])(
    "uses already-published activity identity and returns unknown across hidden qualification changes: %s",
    async (id) => {
      const { source, sentinel } = inventoryWindow();
      const repository = pageRepository(source);
      const getPage = vi.spyOn(repository, "getHistoryPage");
      const getItems = vi.spyOn(repository, "getTurnItems");
      const prepare = vi.spyOn(repository, "prepareHistoryPresentation");
      const wrapper = await mountSuspended(ProgressiveConversationView, {
        props: {
          metadata: catalogSessionMetadataSchema.parse(summary),
          repository,
          targetTurnId: null,
        },
      });
      try {
        await flushPromises();
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- VTU queries the real component's one-entry provenance through retained-window changes
        const state = wrapper.vm as unknown as {
          timeline: ReturnType<typeof useProgressiveHistoryTimeline>;
          viewport: ReturnType<typeof useMeasuredConversationViewport>;
          entryRetained(key: string, entry: string): boolean | undefined;
        };
        const rowKey = JSON.stringify([source.physicalRolloutId, source.turnId]);
        const entryKey = `activity:${id}`;
        expect(
          wrapper
            .getComponent(ConversationTurn)
            .props("turn")
            .activities.some((activity) => activity.id === id),
        ).toBe(true);
        expect(state.entryRetained(rowKey, entryKey)).toBe(true);
        const mountedRows = vi.spyOn(state.viewport.rows, "value", "get").mockReturnValue([]);
        publishRetainedWindows(state.timeline, [...state.timeline.windows.value]);
        await nextTick();
        expect(wrapper.find("[data-history-turn]").exists()).toBe(false);
        const requests = [
          getPage.mock.calls.length,
          getItems.mock.calls.length,
          prepare.mock.calls.length,
        ];
        const parse = vi.spyOn(JSON, "parse").mockClear();
        const activity = vi.spyOn(activityPresentation, "historyActivity").mockClear();
        const expand = vi.spyOn(codeMode, "expandRecordedCells").mockClear();
        expect(state.entryRetained(rowKey, entryKey)).toBe(true);
        publishRetainedWindows(
          state.timeline,
          retainHistoryWindows(state.timeline.windows.value, "B"),
        );
        await nextTick();
        expect(state.entryRetained(rowKey, entryKey)).toBeUndefined();
        publishRetainedWindows(
          state.timeline,
          state.timeline.windows.value.map((window) => ({
            ...window,
            items: window.items.filter((item) => item.itemId !== "outer-output"),
          })),
        );
        await nextTick();
        expect(state.entryRetained(rowKey, entryKey)).toBe(false);
        expect(parse.mock.calls.filter(([value]) => value === sentinel)).toHaveLength(0);
        expect(activity).not.toHaveBeenCalled();
        expect(expand).not.toHaveBeenCalled();
        expect([
          getPage.mock.calls.length,
          getItems.mock.calls.length,
          prepare.mock.calls.length,
        ]).toEqual(requests);
        parse.mockRestore();
        activity.mockRestore();
        expand.mockRestore();
        mountedRows.mockRestore();
      } finally {
        wrapper.unmount();
      }
    },
  );
  it.each([false, true])(
    "finishes owned Latest on an automatic replacement page while reader cancellation still wins (cancelled=%s)",
    async (cancelled) => {
      const source = disjointWindow();
      const repository = pageRepository(source);
      const requests: Array<{ signal?: AbortSignal; resolve: (page: HistoryPage) => void }> = [];
      vi.spyOn(repository, "getHistoryPage").mockImplementation(
        (_id, _query, options) =>
          new Promise<HistoryPage>((resolve, reject) => {
            requests.push({ signal: options?.signal, resolve });
            options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), {
              once: true,
            });
          }),
      );
      let invalidate!: Parameters<typeof repository.subscribe>[0];
      vi.spyOn(repository, "subscribe").mockImplementation((listener) => {
        invalidate = listener;
        return () => {};
      });
      vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
        queueMicrotask(() => callback(performance.now()));
        return 1;
      });
      let preferences!: ReturnType<typeof usePresentationSettings>;
      let previousFollow = true;
      const wrapper = await mountSuspended({
        setup() {
          preferences = usePresentationSettings();
          previousFollow = preferences.settings.liveFollow;
          onMounted(() => preferences.setLiveFollow(false));
          return () =>
            h(ProgressiveConversationView, {
              metadata: catalogSessionMetadataSchema.parse(summary),
              repository,
              targetTurnId: null,
            });
        },
      });
      try {
        const component = wrapper.getComponent(ProgressiveConversationView);
        const surface = component.get<HTMLElement>(".progressive-conversation").element;
        let position = 0;
        const total = () =>
          Number(surface.dataset.retainedTurns) > 0 ? 2000 : surface.clientHeight;
        vi.spyOn(surface, "scrollHeight", "get").mockImplementation(total);
        Object.defineProperty(surface, "scrollTop", {
          get: () => position,
          set: (value: number) => {
            position = Math.max(0, Math.min(total() - surface.clientHeight, value));
          },
        });
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- VTU exposes the mounted production script-setup methods
        const state = component.vm as unknown as {
          readInput(event: Event): void;
          viewport: ReturnType<typeof useMeasuredConversationViewport>;
        };
        const latest = vi.spyOn(state.viewport, "latest");
        expect(requests).toHaveLength(1);
        invalidate({ type: "session.updated", ids: ["thread"], revision: "initial-notification" });
        if (cancelled) {
          state.readInput(new WheelEvent("wheel", { deltaY: -10 }));
        }
        await flushPromises();
        expect(requests).toHaveLength(2);
        expect(requests[0]?.signal?.aborted).toBe(true);
        expect(latest).not.toHaveBeenCalled();
        requests[1]!.resolve(historyPage(source));
        await flushPromises();
        expect(surface.dataset.retainedTurns).toBe("1");
        expect(surface.scrollTop).toBe(cancelled ? 0 : 1200);
        expect(latest).toHaveBeenCalledTimes(cancelled ? 0 : 1);
      } finally {
        preferences.setLiveFollow(previousFollow);
        wrapper.unmount();
      }
    },
  );
  it("captures unobserved reader movement before a delayed navigator changes surface geometry", async () => {
    const source = disjointWindow();
    const repository = pageRepository(source);
    let resolveNavigator!: (value: HistoryNavigatorPage) => void;
    const navigation = new Promise<HistoryNavigatorPage>((resolve) => {
      resolveNavigator = resolve;
    });
    vi.spyOn(repository, "getHistoryNavigator").mockImplementation(() => navigation);
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => callback(performance.now()));
      return 1;
    });
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: {
        metadata: catalogSessionMetadataSchema.parse(summary),
        repository,
        targetTurnId: source.turnId,
      },
    });
    try {
      await flushPromises();
      const surface = wrapper.get<HTMLElement>(".progressive-conversation").element;
      const canvas = wrapper.get<HTMLElement>(".history-canvas").element;
      const target = wrapper.get<HTMLElement>("[data-history-turn]").element;
      const surfaceTop = () => (wrapper.find("nav").exists() ? 161.59375 : 100);
      surface.getBoundingClientRect = () => new DOMRect(0, surfaceTop(), 800, 800);
      canvas.getBoundingClientRect = () =>
        new DOMRect(0, surfaceTop() + 32 - surface.scrollTop, 800, 2000);
      target.getBoundingClientRect = () =>
        new DOMRect(0, surfaceTop() + 32 - surface.scrollTop, 800, 1000);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- VTU exposes the mounted production script-setup methods
      const state = wrapper.vm as unknown as {
        viewport: ReturnType<typeof useMeasuredConversationViewport>;
      };
      await state.viewport.target(JSON.stringify([source.physicalRolloutId, source.turnId]));
      surface.scrollTop += 96;
      const before = target.getBoundingClientRect().top;
      resolveNavigator({ ...historyPage(source), turns: [] });
      await flushPromises();
      await state.viewport.settle();
      expect(wrapper.find("nav").exists()).toBe(true);
      expect(target.getBoundingClientRect().top).toBe(before);
      expect(state.viewport.follow.value).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });
  it("processes automatic history for a direct target while explicit Latest still requests navigation", async () => {
    const selected = disjointWindow();
    const latest = { ...structuredClone(selected), turnId: "latest", order: 2 };
    const repository = pageRepository(selected);
    const read = vi
      .spyOn(repository, "getHistoryPage")
      .mockImplementation(async (_id, query) =>
        historyPage(query.anchor.kind === "turn" ? selected : latest),
      );
    let invalidate!: Parameters<typeof repository.subscribe>[0];
    vi.spyOn(repository, "subscribe").mockImplementation((listener) => {
      invalidate = listener;
      return () => {};
    });
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: {
        metadata: catalogSessionMetadataSchema.parse(summary),
        repository,
        targetTurnId: selected.turnId,
      },
    });
    try {
      await flushPromises();
      expect(wrapper.get(".progressive-conversation").attributes("data-retained-turns")).toBe("1");
      invalidate({ type: "session.updated", ids: ["thread"], revision: "notification" });
      await flushPromises();
      expect(read).toHaveBeenCalledTimes(2);
      expect(wrapper.get(".progressive-conversation").attributes("data-retained-turns")).toBe("2");
      await wrapper
        .findAll("button")
        .find((button) => button.text() === "Latest content")!
        .trigger("click");
      await flushPromises();
      expect(read).toHaveBeenCalledTimes(3);
      expect(wrapper.get(".progressive-conversation").attributes("data-retained-turns")).toBe("2");
    } finally {
      wrapper.unmount();
    }
  });
  it("refreshes navigator append and epoch changes while preserving a deliberately paged slice and exposing retry", async () => {
    const window = disjointWindow();
    const repository = pageRepository(window);
    let epoch = "epoch";
    let revision = "A";
    let failOlder = false;
    const history = vi
      .spyOn(repository, "getHistoryPage")
      .mockImplementation(async () =>
        historyPage({ ...window, historyEpoch: epoch, contentRevision: revision }),
      );
    let invalidate!: Parameters<typeof repository.subscribe>[0];
    vi.spyOn(repository, "subscribe").mockImplementation((listener) => {
      invalidate = listener;
      return () => {};
    });
    const navigate = vi
      .spyOn(repository, "getHistoryNavigator")
      .mockImplementation(async (_id, query) => {
        if (query.anchor.kind === "before" && failOlder) {
          throw new Error("history.invalid_cursor");
        }
        const older = query.anchor.kind === "before";
        return {
          ...historyPage({ ...window, historyEpoch: epoch, contentRevision: revision }),
          beforeCursor: older ? null : "older-navigation",
          turns: [
            {
              turnId: older ? "older-turn" : `latest-${revision}`,
              physicalRolloutId: "physical",
              order: older ? 0 : 2,
              status: "completed",
              promptPreview: older ? "OLDER NAVIGATION" : `LATEST ${revision}`,
            },
          ],
        };
      });
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: {
        metadata: catalogSessionMetadataSchema.parse(summary),
        repository,
        targetTurnId: null,
      },
    });
    try {
      await flushPromises();
      expect(wrapper.get('nav[aria-label="Loaded turn navigation"]').text()).toContain("LATEST A");
      revision = "B";
      invalidate({ type: "session.updated", ids: ["thread"], revision });
      await flushPromises();
      expect(wrapper.get('nav[aria-label="Loaded turn navigation"]').text()).toContain("LATEST B");
      const older = wrapper
        .findAll("button")
        .find((button) => button.text() === "Older navigation")!;
      failOlder = true;
      await older.trigger("click");
      await flushPromises();
      expect(wrapper.text()).toContain("Retry navigation");
      failOlder = false;
      await wrapper
        .findAll("button")
        .find((button) => button.text() === "Retry navigation")!
        .trigger("click");
      await flushPromises();
      expect(wrapper.get('nav[aria-label="Loaded turn navigation"]').text()).toContain(
        "OLDER NAVIGATION",
      );
      revision = "C";
      invalidate({ type: "session.updated", ids: ["thread"], revision });
      await flushPromises();
      expect(wrapper.get('nav[aria-label="Loaded turn navigation"]').text()).toContain(
        "OLDER NAVIGATION",
      );
      expect(wrapper.get('nav[aria-label="Loaded turn navigation"]').text()).toContain("LATEST C");
      epoch = "replacement";
      revision = "D";
      invalidate({ type: "session.updated", ids: ["thread"], revision });
      await flushPromises();
      expect(wrapper.get('nav[aria-label="Loaded turn navigation"]').text()).toContain("LATEST D");
      expect(wrapper.get('nav[aria-label="Loaded turn navigation"]').text()).not.toContain(
        "OLDER NAVIGATION",
      );
      let finishLate!: (page: HistoryNavigatorPage) => void;
      const late = new Promise<HistoryNavigatorPage>((resolve) => {
        finishLate = resolve;
      });
      navigate.mockImplementationOnce(() => late);
      revision = "E";
      invalidate({ type: "session.updated", ids: ["thread"], revision });
      await flushPromises();
      await wrapper
        .findAll("button")
        .find((button) => button.text() === "Older navigation")!
        .trigger("click");
      await flushPromises();
      finishLate({ ...historyPage({ ...window, historyEpoch: "retired-owner" }), turns: [] });
      await flushPromises();
      revision = "F";
      invalidate({ type: "session.updated", ids: ["thread"], revision });
      await flushPromises();
      expect(wrapper.get('nav[aria-label="Loaded turn navigation"]').text()).toContain(
        "OLDER NAVIGATION",
      );
      expect(wrapper.get('nav[aria-label="Loaded turn navigation"]').text()).toContain("LATEST F");
      expect(navigate).toHaveBeenCalled();
      expect(history).toHaveBeenCalled();
    } finally {
      wrapper.unmount();
    }
  });
  it("waits for a real attachment ID while still resolving a known missing asset", async () => {
    const resolveAsset = vi.fn<(id: string) => Promise<ResolvedAsset>>(async (id) => ({
      id,
      url: id === "known-missing" ? null : "/assets/prepared.png",
      status: id === "known-missing" ? "missing" : "available",
      mimeType: "image/png",
      byteSize: 1,
      sha256: null,
      width: 1,
      height: 1,
      originalPath: "prepared.png",
    }));
    const wrapper = await mountSuspended(ConversationAttachment, {
      props: { assetId: "", resolveAsset },
    });
    try {
      await flushPromises();
      expect(resolveAsset).not.toHaveBeenCalled();
      expect(wrapper.text()).toContain("Cached attachment is unavailable");
      await wrapper.setProps({ assetId: "known-missing" });
      await flushPromises();
      expect(resolveAsset).toHaveBeenCalledExactlyOnceWith("known-missing");
      expect(wrapper.text()).toContain("Cached media is unavailable");
      await wrapper.setProps({ assetId: "" });
      await flushPromises();
      expect(resolveAsset).toHaveBeenCalledTimes(1);
      await wrapper.setProps({ assetId: "prepared" });
      await flushPromises();
      expect(resolveAsset).toHaveBeenLastCalledWith("prepared");
      expect(wrapper.get("img").attributes("src")).toBe("/assets/prepared.png");
    } finally {
      wrapper.unmount();
    }
  });
  it("prepares only visible attachment references and renders generated media after work expansion", async () => {
    const source = disjointWindow();
    const generated = {
      id: "generated",
      type: "imageGeneration" as const,
      result: "aW1hZ2U=",
      savedPath: null,
      fileId: null,
      startedAtMs: null,
      completedAtMs: null,
      evidence: null,
    };
    source.items.splice(1, 0, {
      ...source.items[0]!,
      itemId: generated.id,
      item: generated,
      decodedByteStart: 30,
      decodedByteEnd: 40,
    });
    source.opening.item = {
      ...source.opening.item!,
      type: "userMessage",
      text: "PREFIX QUESTION",
      clientId: null,
      content: [{ type: "image", url: "sediment:cloud-only" }],
    };
    source.items[0]!.item = source.opening.item;
    const repository = pageRepository(source);
    const prepare = vi
      .spyOn(repository, "prepareHistoryPresentation")
      .mockImplementation(async (query) => ({
        ...query,
        body: {
          type: "document",
          children: [
            { type: "text", text: query.markdown },
            ...(query.attachments ?? []).map(() => ({
              type: "media" as const,
              mediaType: "image" as const,
              source: "asset" as const,
              assetId: `saved-${query.itemId}`,
              originalSource: "retained.png",
              alt: "Recorded image",
              title: null,
            })),
          ],
        },
      }));
    const resolveAsset = vi.spyOn(repository, "resolveAsset").mockImplementation(async (id) => ({
      id,
      url: `/assets/${id}.png`,
      status: "available",
      mimeType: "image/png",
      byteSize: 5,
      sha256: null,
      width: 1,
      height: 1,
      originalPath: null,
    }));
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: {
        metadata: catalogSessionMetadataSchema.parse(summary),
        repository,
        targetTurnId: null,
      },
    });
    try {
      await vi.waitFor(() =>
        expect(
          prepare.mock.calls.some(
            ([query]) =>
              query.itemId === "prefix" && query.attachments?.[0]?.source === "sediment:cloud-only",
          ),
        ).toBe(true),
      );
      expect(prepare.mock.calls.some(([query]) => query.itemId === "generated")).toBe(false);
      const work = wrapper.get("details.conversation-work-stream");
      work.element.setAttribute("open", "");
      await work.trigger("toggle");
      await vi.waitFor(() =>
        expect(
          prepare.mock.calls.some(
            ([query]) =>
              query.itemId === "generated" &&
              query.attachments?.[0]?.source === "data:image/png;base64,aW1hZ2U=",
          ),
        ).toBe(true),
      );
      await vi.waitFor(() =>
        expect(wrapper.find('img[src="/assets/saved-generated.png"]').exists()).toBe(true),
      );
      expect(resolveAsset).not.toHaveBeenCalledWith("unavailable-generated");
      expect(resolveAsset).toHaveBeenCalledWith("saved-generated");
    } finally {
      wrapper.unmount();
    }
  });
  it("keeps reader intent when latest content finishes after wheel input", async () => {
    const source = disjointWindow();
    const repository = pageRepository(source);
    let resolve!: (value: HistoryPage) => void;
    const gate = new Promise<HistoryPage>((done) => {
      resolve = done;
    });
    vi.spyOn(repository, "getHistoryPage")
      .mockResolvedValueOnce(historyPage(source))
      .mockImplementation(() => gate);
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: {
        metadata: catalogSessionMetadataSchema.parse(summary),
        repository,
        targetTurnId: null,
      },
    });
    await flushPromises();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- VTU exposes the mounted production script-setup methods
    const state = wrapper.vm as unknown as {
      latest(): Promise<void>;
      readInput(event: Event): void;
      viewport: ReturnType<typeof useMeasuredConversationViewport>;
    };
    state.readInput(new WheelEvent("wheel", { deltaY: 80 }));
    const loading = state.latest();
    state.readInput(new WheelEvent("wheel", { deltaY: 80 }));
    resolve(historyPage(source));
    await loading;
    expect(state.viewport.follow.value).toBe(false);
    wrapper.unmount();
  });

  it("does not start restored-position measurement after reader input cancels its pending fetch", async () => {
    const source = disjointWindow();
    const repository = pageRepository(source);
    let resolve!: (value: HistoryPage) => void;
    const gate = new Promise<HistoryPage>((done) => {
      resolve = done;
    });
    vi.spyOn(repository, "getHistoryPage").mockImplementation(() => gate);
    const wrapper = await mountSuspended({
      setup() {
        useState("conversation-positions", () => ({})).value = {
          thread: { turnId: JSON.stringify(["physical", "turn"]), top: -176 },
        };
        return () =>
          h(ProgressiveConversationView, {
            metadata: catalogSessionMetadataSchema.parse(summary),
            repository,
            targetTurnId: null,
          });
      },
    });
    const child = wrapper.getComponent(ProgressiveConversationView);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- VTU exposes the mounted production script-setup methods
    const state = child.vm as unknown as {
      readInput(event: Event): void;
      viewport: ReturnType<typeof useMeasuredConversationViewport>;
    };
    const target = vi.spyOn(state.viewport, "target");
    state.readInput(new WheelEvent("wheel", { deltaY: 80 }));
    resolve(historyPage(source));
    await flushPromises();
    expect(target).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it("prunes evicted alias identities while an independently cloned Inspector snapshot outlives its page", async () => {
    const source = disjointWindow();
    const repository = pageRepository(source);
    let start = 20;
    vi.spyOn(repository, "getHistoryPage").mockImplementation(async (_id, query) => {
      if (query.anchor.kind === "latest") {
        return { ...historyPage(source), afterCursor: "next-20" };
      }
      expect(query.limit).toBe(20);
      const turns = Array.from({ length: 20 }, (_, offset) => {
        const index = start + offset;
        const entry = disjointWindow();
        entry.turnId = `other-${index}`;
        entry.order = index;
        return entry;
      });
      start += 20;
      return { ...historyPage(turns[0]!), turns, afterCursor: `next-${start}` };
    });
    const legacyInspector = vi.spyOn(repository, "getInspector");
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: {
        metadata: catalogSessionMetadataSchema.parse(summary),
        repository,
        targetTurnId: null,
      },
    });
    await flushPromises();
    await wrapper.get('[aria-label="Open message info"]').trigger("click");
    const selected = wrapper.getComponent(ConversationInspector).props("record");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Vue Test Utils exposes the mounted component's actual script-setup stores
    const state = wrapper.vm as unknown as {
      timeline: ReturnType<typeof useProgressiveHistoryTimeline>;
      messageKeysByIdentity: Map<string, string>;
    };
    expect(state.messageKeysByIdentity.size).toBe(2);
    expect(selected?.rawRecords).toEqual([{ source: "tail evidence" }]);
    for (let index = 0; index < 4; index++) {
      state.timeline.setVisible([]);
      // oxlint-disable-next-line no-await-in-loop -- Each bounded page advances the retained window
      await state.timeline.loadAfter();
      // oxlint-disable-next-line no-await-in-loop -- Render the new measured window before checking its cache
      await flushPromises();
      expect(state.messageKeysByIdentity.size).toBeLessThanOrEqual(
        state.timeline.windows.value.length * 2,
      );
    }
    expect(state.timeline.windows.value).toHaveLength(60);
    expect(state.timeline.windows.value.some((entry) => entry.turnId === "turn")).toBe(false);
    expect(
      [...state.messageKeysByIdentity.keys()].some((key) =>
        key.startsWith('["physical","turn","epoch"]:'),
      ),
    ).toBe(false);
    expect(wrapper.getComponent(ConversationInspector).props("record")).toBe(selected);
    source.items[1]!.item!.evidence = { source: "caller mutation" };
    expect(selected?.rawRecords).toEqual([{ source: "tail evidence" }]);
    expect(legacyInspector).not.toHaveBeenCalled();
    await wrapper.setProps({
      metadata: { ...catalogSessionMetadataSchema.parse(summary), id: "other-selection" },
    });
    expect(wrapper.findComponent(ConversationInspector).exists()).toBe(false);
    wrapper.unmount();
  });
  it.each(["echo-first", "canonical-first"] as const)(
    "I1 preserves first-page final DOM and original Info identity through a real overlapping merge: %s",
    async (order) => {
      const window = disjointWindow();
      const tail = window.items.at(-1)!;
      if (tail.item?.type !== "agentMessage") {
        throw new Error("Expected fixture answer");
      }
      const canonical = {
        ...tail,
        itemId: "canonical",
        decodedByteStart: 910,
        decodedByteEnd: 920,
        updatedAtDecodedByte: 910,
        item: {
          ...tail.item,
          id: "canonical",
          evidence: {
            source: {
              type: "response_item",
              payload: {
                type: "message",
                id: "canonical",
                role: "assistant",
                phase: "final_answer",
              },
            },
          },
        },
      };
      const echo = {
        ...tail,
        itemId: "echo",
        item: {
          ...tail.item,
          id: "echo",
          evidence: {
            source: {
              type: "event_msg",
              payload: { type: "agent_message", phase: "final_answer" },
            },
          },
        },
      };
      const ordered =
        order === "echo-first"
          ? [echo, canonical]
          : [
              {
                ...canonical,
                decodedByteStart: 900,
                decodedByteEnd: 910,
                updatedAtDecodedByte: 900,
              },
              { ...echo, decodedByteStart: 910, decodedByteEnd: 920, updatedAtDecodedByte: 910 },
            ];
      const initial = ordered[0];
      const selected = ordered[1];
      if (!initial || !selected) {
        throw new Error("Expected both ordered source envelopes");
      }
      const first = {
        ...window,
        finalAnswerItemId: initial.itemId,
        items: [window.items[0]!, initial],
        itemIslands: [["prefix"], [initial.itemId]],
      };
      const joined = {
        ...window,
        finalAnswerItemId: selected.itemId,
        items: [window.items[0]!, ...ordered],
        itemIslands: [["prefix"], ordered.map((entry) => entry.itemId)],
        loadedRanges: [
          window.loadedRanges[0]!,
          { ...window.loadedRanges[1]!, endDecodedByteExclusive: 920 },
        ],
      };
      const repository = pageRepository(joined);
      vi.spyOn(repository, "getHistoryPage")
        .mockResolvedValueOnce(historyPage(first))
        .mockResolvedValue(historyPage(joined));
      let invalidate!: Parameters<typeof repository.subscribe>[0];
      vi.spyOn(repository, "subscribe").mockImplementation((listener) => {
        invalidate = listener;
        return () => {};
      });
      const legacyInspector = vi.spyOn(repository, "getInspector");
      const wrapper = await mountSuspended(ProgressiveConversationView, {
        props: {
          metadata: catalogSessionMetadataSchema.parse(summary),
          repository,
          targetTurnId: null,
        },
      });
      await flushPromises();
      const original = wrapper.get(`[data-message-id="${initial.itemId}"]`).element;
      const anchorKey = original.getAttribute("data-anchor-entry");
      invalidate({ type: "session.updated", ids: ["thread"], revision: "A" });
      await flushPromises();
      expect(wrapper.get(`[data-message-id="${selected.itemId}"]`).element).toBe(original);
      expect(anchorKey).toBeTruthy();
      expect(
        wrapper.get(`[data-message-id="${selected.itemId}"]`).attributes("data-anchor-entry"),
      ).toBe(anchorKey);
      expect(wrapper.findAll(`[data-message-id="${selected.itemId}"]`)).toHaveLength(1);
      expect(wrapper.find(`[data-entry-id="${initial.itemId}"]`).exists()).toBe(false);
      expect(wrapper.findAll(".conversation-message--assistant")).toHaveLength(1);
      expect(joined.finalAnswerItemId).toBe(selected.itemId);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- VTU exposes the actual producer's retained-entry predicate
      const state = wrapper.vm as unknown as {
        entryRetained(key: string, entry: string): boolean | undefined;
        timeline: ReturnType<typeof useProgressiveHistoryTimeline>;
        viewport: ReturnType<typeof useMeasuredConversationViewport>;
        messageKeysByIdentity: Map<string, string>;
      };
      const rowKey = JSON.stringify([joined.physicalRolloutId, joined.turnId]);
      expect(state.entryRetained(rowKey, anchorKey!)).toBe(true);
      const rows = state.viewport.rows.value;
      const mountedRows = vi.spyOn(state.viewport.rows, "value", "get");
      for (let cycle = 0; cycle < 3; cycle++) {
        mountedRows.mockReturnValue([]);
        publishRetainedWindows(
          state.timeline,
          state.timeline.windows.value.map((current) => ({ ...current })),
        );
        // oxlint-disable-next-line no-await-in-loop -- Each cycle must publish the virtual unmount before its remount
        await nextTick();
        expect(wrapper.find("[data-history-turn]").exists()).toBe(false);
        expect(state.entryRetained(rowKey, anchorKey!)).toBe(true);
        expect(state.messageKeysByIdentity.size).toBeLessThanOrEqual(3);
        mountedRows.mockReturnValue(rows);
        publishRetainedWindows(
          state.timeline,
          state.timeline.windows.value.map((current) => ({ ...current })),
        );
        // oxlint-disable-next-line no-await-in-loop -- Observe the key used by each remounted production message
        await nextTick();
        expect(
          wrapper.get(`[data-message-id="${selected.itemId}"]`).attributes("data-anchor-entry"),
        ).toBe(anchorKey);
      }
      mountedRows.mockRestore();
      await wrapper
        .get(`[data-message-id="${selected.itemId}"] [aria-label="Open message info"]`)
        .trigger("click");
      expect(wrapper.getComponent(ConversationInspector).props("record")?.target).toEqual({
        type: "message",
        id: selected.itemId,
      });
      expect(legacyInspector).not.toHaveBeenCalled();
      const retained = state.timeline.windows.value[0]!;
      for (let revision = 0; revision < 3; revision++) {
        const replacementId = `replacement-${revision}`;
        publishRetainedWindows(state.timeline, [
          {
            ...retained,
            contentRevision: `revision-${revision}`,
            finalAnswerItemId: replacementId,
            items: [
              retained.items[0]!,
              { ...selected, itemId: replacementId, item: { ...selected.item, id: replacementId } },
            ],
          },
        ]);
        // oxlint-disable-next-line no-await-in-loop -- Each revision replaces retained identity ownership before the bound is checked
        await nextTick();
        expect(state.messageKeysByIdentity.size).toBe(2);
        expect(state.entryRetained(rowKey, anchorKey!)).toBe(false);
      }
      publishRetainedWindows(
        state.timeline,
        state.timeline.windows.value.map((current) => ({ ...current, historyEpoch: "next-epoch" })),
      );
      await nextTick();
      expect(state.messageKeysByIdentity.size).toBe(2);
      expect(
        [...state.messageKeysByIdentity.keys()].every((key) =>
          key.startsWith('["physical","turn","next-epoch"]:'),
        ),
      ).toBe(true);
      expect(state.entryRetained(rowKey, anchorKey!)).toBe(false);
      wrapper.unmount();
    },
  );
  it.each(["evicted", "unmounted", "unknown"] as const)(
    "uses actual progressive entry ownership while the selected turn is retained: %s",
    async (retention) => {
      const source = disjointWindow();
      const repository = pageRepository(source);
      const getPage = vi.spyOn(repository, "getHistoryPage");
      const getItems = vi.spyOn(repository, "getTurnItems");
      vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
        queueMicrotask(() => callback(performance.now()));
        return 1;
      });
      const wrapper = await mountSuspended(ProgressiveConversationView, {
        props: {
          metadata: catalogSessionMetadataSchema.parse(summary),
          repository,
          targetTurnId: null,
        },
      });
      try {
        await flushPromises();
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- VTU exposes the mounted production viewport and retained data store
        const state = wrapper.vm as unknown as {
          timeline: ReturnType<typeof useProgressiveHistoryTimeline>;
          viewport: ReturnType<typeof useMeasuredConversationViewport>;
          entryRetained(key: string, entry: string): boolean | undefined;
        };
        const container = wrapper.get<HTMLElement>(".progressive-conversation").element;
        const canvas = wrapper.get<HTMLElement>(".history-canvas").element;
        const turn = wrapper.get<HTMLElement>("[data-history-turn]").element;
        const entry = wrapper.get<HTMLElement>('[data-message-id="tail"]').element;
        const prefix = wrapper.get<HTMLElement>('[data-message-id="prefix"]').element;
        let height = 1600;
        let position = 0;
        let entryOffset = 300;
        Object.defineProperty(container, "scrollTop", {
          get: () => position,
          set: (value: number) => {
            position = Math.max(0, Math.min(height - 800, value));
          },
        });
        vi.spyOn(container, "scrollHeight", "get").mockImplementation(() => height);
        container.getBoundingClientRect = () => new DOMRect(0, 0, 800, 800);
        canvas.getBoundingClientRect = () => new DOMRect(0, -position, 800, height);
        turn.getBoundingClientRect = () => new DOMRect(0, -position, 800, height);
        prefix.getBoundingClientRect = () => new DOMRect(0, -position, 800, 200);
        entry.getBoundingClientRect = () => new DOMRect(0, entryOffset - position, 800, 1000);
        container.scrollTop = 600;
        state.viewport.scroll();
        state.viewport.capture();
        height = 1200;
        container.scrollTop = 400;
        await state.viewport.settle();
        expect(position).toBe(400);
        const rowKey = turn.dataset["anchorTurnId"]!;
        const anchorKey = entry.dataset["anchorEntry"]!;
        const retained = state.timeline.windows.value[0]!;
        const requests = [getPage.mock.calls.length, getItems.mock.calls.length];
        if (retention === "unmounted") {
          entry.remove();
        } else {
          publishRetainedWindows(state.timeline, [
            {
              ...retained,
              items:
                retention === "evicted"
                  ? retained.items.slice(0, 1)
                  : retained.items.map((item) =>
                      item.itemId === "tail"
                        ? Object.assign({}, item, { item: null, detail: "unresolved" as const })
                        : item,
                    ),
            },
          ]);
          await nextTick();
        }
        expect(state.entryRetained(rowKey, anchorKey)).toBe(
          retention === "evicted" ? false : retention === "unknown" ? undefined : true,
        );
        expect(state.timeline.windows.value[0]?.turnId).toBe("turn");
        state.viewport.capture();
        await state.viewport.settle();
        height = 1600;
        await state.viewport.settle();
        state.viewport.capture();
        if (retention !== "evicted") {
          entryOffset = 400;
          turn.append(entry);
          await state.viewport.settle();
        }
        expect(position).toBe(retention === "evicted" ? 400 : 700);
        expect(state.viewport.follow.value).toBe(false);
        expect([getPage.mock.calls.length, getItems.mock.calls.length]).toEqual(requests);
      } finally {
        wrapper.unmount();
      }
    },
  );
  it("qualifies retained activity keys and unknown payloads without presentation requests", async () => {
    const source = disjointWindow();
    source.items.push({
      ...source.items[1]!,
      itemId: "thought",
      item: {
        id: "thought",
        type: "reasoning",
        summary: ["Reason"],
        content: [],
        startedAtMs: null,
        completedAtMs: null,
        evidence: null,
      },
    });
    const repository = pageRepository(source);
    const getPage = vi.spyOn(repository, "getHistoryPage");
    const getItems = vi.spyOn(repository, "getTurnItems");
    const prepare = vi.spyOn(repository, "prepareHistoryPresentation");
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: {
        metadata: catalogSessionMetadataSchema.parse(summary),
        repository,
        targetTurnId: null,
      },
    });
    try {
      await flushPromises();
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- VTU exposes the actual producer's data-owned predicate
      const state = wrapper.vm as unknown as {
        timeline: ReturnType<typeof useProgressiveHistoryTimeline>;
        entryRetained(key: string, entry: string): boolean | undefined;
      };
      const rowKey = JSON.stringify([source.physicalRolloutId, source.turnId]);
      const requests = [
        getPage.mock.calls.length,
        getItems.mock.calls.length,
        prepare.mock.calls.length,
      ];
      expect(state.entryRetained(rowKey, "activity:thought")).toBe(true);
      expect(state.entryRetained(rowKey, "activity:absent")).toBe(false);
      expect(state.entryRetained(rowKey, "future:unknown-kind")).toBeUndefined();
      const retained = state.timeline.windows.value[0]!;
      publishRetainedWindows(state.timeline, [
        {
          ...retained,
          items: retained.items.map((item) =>
            item.itemId === "thought" ? { ...item, item: null, detail: "unresolved" } : item,
          ),
        },
      ]);
      expect(state.entryRetained(rowKey, "activity:thought")).toBeUndefined();
      publishRetainedWindows(state.timeline, [
        { ...retained, items: retained.items.filter((item) => item.itemId !== "thought") },
      ]);
      expect(state.entryRetained(rowKey, "activity:thought")).toBe(false);
      expect([
        getPage.mock.calls.length,
        getItems.mock.calls.length,
        prepare.mock.calls.length,
      ]).toEqual(requests);
    } finally {
      wrapper.unmount();
    }
  });
  it("opens supplied progressive media through the existing lazy viewer", async () => {
    const window = disjointWindow();
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: {
        metadata: catalogSessionMetadataSchema.parse(summary),
        repository: pageRepository(window),
        targetTurnId: null,
      },
      attachTo: document.body,
    });
    await flushPromises();
    wrapper.getComponent(ConversationTurn).vm.$emit("openMedia", {
      kind: "svg",
      alt: "Diagram",
      filename: "diagram.svg",
      width: null,
      height: null,
      mimeType: "image/svg+xml",
      source: "<svg/>",
      svg: "<svg/>",
    });
    await flushPromises();
    await vi.waitFor(() =>
      expect(document.querySelector("[data-progressive-media]")?.textContent).toContain(
        "diagram.svg",
      ),
    );
    wrapper.unmount();
  });
  it("loads approvals only on explicit request and keeps source availability and stale request ownership", async () => {
    const window = disjointWindow();
    const repository = pageRepository(window);
    let resolve!: (
      value: Awaited<ReturnType<NonNullable<typeof repository.getApprovalEvidence>>>,
    ) => void;
    const approvals = vi.spyOn(repository, "getApprovalEvidence").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: {
        metadata: catalogSessionMetadataSchema.parse(summary),
        repository,
        targetTurnId: null,
      },
    });
    await flushPromises();
    expect(approvals).not.toHaveBeenCalled();
    await wrapper.get("[data-approval-evidence] button").trigger("click");
    expect(approvals).toHaveBeenCalledOnce();
    await wrapper.setProps({
      metadata: catalogSessionMetadataSchema.parse({ ...summary, id: "other" }),
    });
    resolve({
      sessionId: "thread",
      matched: [],
      unattached: [],
      parentSource: {
        availability: "partial",
        historyEpoch: "raw-epoch",
        contentRevision: "raw-revision",
        coverage: null,
      },
    });
    await flushPromises();
    expect(wrapper.text()).not.toContain("Approval source: partial");
    wrapper.unmount();
  });
  it("opens the reused Info control from loaded evidence and fences the snapshot on selection changes", async () => {
    const window = disjointWindow();
    const repository = pageRepository(window);
    const legacyInspector = vi.spyOn(repository, "getInspector");
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: {
        metadata: catalogSessionMetadataSchema.parse(summary),
        repository,
        targetTurnId: null,
      },
    });
    await flushPromises();
    await wrapper.get('[aria-label="Open message info"]').trigger("click");
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    const record = wrapper.getComponent(ConversationInspector).props("record");
    expect(record).toMatchObject({
      sessionId: "thread",
      target: { type: "message", id: "tail" },
      timeToFirstTokenMs: null,
      tokenDelta: null,
      eventIds: [],
    });
    expect(record?.rawRecords).toEqual([{ source: "tail evidence" }]);
    expect(wrapper.get('[role="dialog"]').text()).toContain("Unavailable");
    expect(wrapper.get('[role="dialog"]').text()).toContain("History epoch");
    expect(legacyInspector).not.toHaveBeenCalled();
    await wrapper.setProps({
      metadata: { ...catalogSessionMetadataSchema.parse(summary), id: "different-selection" },
    });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    await wrapper.get('[aria-label="Open message info"]').trigger("click");
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    wrapper.unmount();
  });
  it.each(["close", "related", "selection", "unmount", "newer-action"] as const)(
    "restores progressive Info focus only for the current close lifecycle: %s",
    async (transition) => {
      const repository = pageRepository(disjointWindow());
      const wrapper = await mountSuspended(ProgressiveConversationView, {
        attachTo: document.body,
        props: {
          metadata: catalogSessionMetadataSchema.parse(summary),
          repository,
          targetTurnId: null,
        },
      });
      const other = document.createElement("button");
      document.body.append(other);
      try {
        await flushPromises();
        const opener = wrapper.get<HTMLButtonElement>('[aria-label="Open message info"]');
        opener.element.focus();
        await opener.trigger("click");
        const inspector = wrapper.getComponent(ConversationInspector);
        expect(document.activeElement).toBe(wrapper.get('[role="dialog"]').element);
        if (transition === "related") {
          inspector.vm.$emit("inspect", { type: "message", id: "prefix" });
          await flushPromises();
        }
        expect(inspector.props("record")?.target.id).toBe(
          transition === "related" ? "prefix" : "tail",
        );
        inspector.vm.$emit("close");
        if (transition === "selection") {
          other.focus();
          await wrapper.setProps({
            metadata: { ...catalogSessionMetadataSchema.parse(summary), id: "replacement" },
          });
        } else if (transition === "unmount") {
          other.focus();
          wrapper.unmount();
        } else if (transition === "newer-action") {
          opener.element.click();
          other.focus();
        }
        await flushPromises();
        expect(document.activeElement).toBe(
          transition === "close" || transition === "related" ? opener.element : other,
        );
      } finally {
        if (transition !== "unmount") {
          wrapper.unmount();
        }
        other.remove();
      }
    },
  );
  it("renders the intervening gap from a single page with disjoint prefix and tail evidence", async () => {
    const window = disjointWindow();
    const repository = pageRepository(window);
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: {
        metadata: catalogSessionMetadataSchema.parse(summary),
        repository,
        targetTurnId: null,
      },
    });
    await flushPromises();
    const turn = wrapper.get(".conversation-turn");
    expect(turn.find(".history-gap").exists()).toBe(true);
    expect(turn.get(".history-gap").text()).toBe("History between these items is not loaded.");
    const html = turn.html();
    expect(html.indexOf("PREFIX QUESTION")).toBeLessThan(
      html.indexOf("History between these items"),
    );
    expect(html.indexOf("History between these items")).toBeLessThan(html.indexOf("TAIL ANSWER"));
    wrapper.unmount();
  });
  it("rereads an unresolved opening directly when latest, target and older-tail responses all omit it", async () => {
    const old = disjointWindow();
    const latest = {
      ...disjointWindow(),
      contentRevision: "B",
      opening: { itemId: null, item: null, availability: "notLoaded" as const },
      items: old.items.slice(1),
      beforeCursor: "older-B",
    };
    const repository = pageRepository(old);
    const getHistory = vi
      .spyOn(repository, "getHistoryPage")
      .mockResolvedValueOnce(historyPage(old))
      .mockResolvedValue(historyPage(latest));
    let publish: ((event: ViewerInvalidation) => void) | undefined;
    vi.spyOn(repository, "subscribe").mockImplementation((callback) => {
      publish = callback;
      return () => {};
    });
    let finish!: (window: HistoryTurnWindow) => void;
    const getItems = vi.spyOn(repository, "getTurnItems").mockImplementation((_id, query) =>
      query.anchor.kind === "opening"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ ...latest, beforeCursor: null }),
    );
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: {
        metadata: catalogSessionMetadataSchema.parse(summary),
        repository,
        targetTurnId: null,
      },
    });
    await flushPromises();
    await wrapper.get('[aria-label="Open message info"]').trigger("click");
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    publish?.({ type: "session.updated", ids: ["thread"], revision: "B" });
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("PREFIX QUESTION");
    expect(wrapper.text()).toContain(
      "Previously loaded item details are awaiting source verification.",
    );
    await wrapper.setProps({ targetTurnId: "turn" });
    await flushPromises();
    expect(getHistory).toHaveBeenLastCalledWith(
      "thread",
      { anchor: { kind: "turn", turnId: "turn" }, limit: 5 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const older = wrapper.findAll("button").find((button) => button.text() === "Load older items");
    expect(older).toBeDefined();
    await older!.trigger("click");
    await flushPromises();
    expect(getItems).toHaveBeenLastCalledWith(
      "thread",
      { turnId: "turn", anchor: { kind: "before", cursor: "older-B" }, limit: 100 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(wrapper.text()).toContain("PREFIX QUESTION");
    expect(wrapper.text()).toContain("awaiting source verification");
    expect(wrapper.findAll("button").some((button) => button.text().startsWith("Continue"))).toBe(
      false,
    );
    const opening = wrapper.findAll("button").find((button) => button.text() === "Load opening");
    expect(opening).toBeDefined();
    await opening!.trigger("click");
    expect(getItems).toHaveBeenLastCalledWith(
      "thread",
      { turnId: "turn", anchor: { kind: "opening" }, limit: 2 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(wrapper.text()).toContain("PREFIX QUESTION");
    expect(wrapper.text()).toContain("awaiting source verification");
    const updated = {
      ...old.opening.item!,
      type: "userMessage" as const,
      content: [],
      clientId: null,
      text: "UPDATED OPENING",
    };
    finish({
      ...latest,
      opening: { itemId: "prefix", item: updated, availability: "available" },
      items: [{ ...old.items[0]!, item: updated, updatedAtDecodedByte: 1200 }],
      beforeCursor: null,
    });
    await flushPromises();
    expect(wrapper.text()).toContain("UPDATED OPENING");
    expect(wrapper.text()).not.toContain("PREFIX QUESTION");
    expect(wrapper.text()).not.toContain("awaiting source verification");
    expect(wrapper.getComponent(ConversationTurn).props("turn").userMessage?.id).toBe("prefix");
    expect(wrapper.getComponent(ConversationTurn).props("turn").id).toBe("turn");
    wrapper.unmount();
  });
  it("keeps the existing not-loaded opening action and its bounded preparation continuation", async () => {
    const complete = disjointWindow();
    const tail = {
      ...complete,
      opening: { itemId: null, item: null, availability: "notLoaded" as const },
      items: complete.items.slice(1),
      beforeCursor: null,
    };
    const repository = pageRepository(tail);
    const getItems = vi
      .spyOn(repository, "getTurnItems")
      .mockResolvedValueOnce({
        ...tail,
        items: [],
        preparation: { kind: "opening", cursor: "opening-preparation" },
      })
      .mockResolvedValueOnce({
        ...tail,
        opening: complete.opening,
        items: complete.items.slice(0, 1),
      });
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: {
        metadata: catalogSessionMetadataSchema.parse(summary),
        repository,
        targetTurnId: null,
      },
    });
    await flushPromises();
    const opening = wrapper.findAll("button").find((button) => button.text() === "Load opening");
    expect(opening).toBeDefined();
    await opening!.trigger("click");
    await flushPromises();
    expect(getItems).toHaveBeenLastCalledWith(
      "thread",
      { turnId: "turn", anchor: { kind: "opening" }, limit: 2 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const continuation = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Continue finding the opening"));
    expect(continuation).toBeDefined();
    await continuation!.trigger("click");
    await flushPromises();
    expect(getItems).toHaveBeenLastCalledWith(
      "thread",
      { turnId: "turn", anchor: { kind: "after", cursor: "opening-preparation" }, limit: 100 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(wrapper.text()).toContain("PREFIX QUESTION");
    expect(
      wrapper
        .findAll("button")
        .some((button) => button.text().includes("Continue finding the opening")),
    ).toBe(false);
    wrapper.unmount();
  });
  it("paints metadata while both history and navigator are pending and cancels the actual client requests on selection disposal", async () => {
    const signals: AbortSignal[] = [];
    const paths: string[] = [];
    const repository = new LiveApiConversationRepository((path, options) => {
      paths.push(path);
      if (path === "/api/sessions/thread") {
        return Promise.resolve(catalogSessionMetadataSchema.parse(summary));
      }
      if (path.includes("legacy=1")) {
        throw new Error("Full summary/navigator must not run");
      }
      signals.push(options!.signal!);
      return new Promise((_resolve, reject) =>
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {
          once: true,
        }),
      );
    });
    const metadata = await repository.getSessionMetadata("thread");
    const wrapper = await mountSuspended(ProgressiveConversationView, {
      props: { metadata, repository, targetTurnId: null },
    });
    await flushPromises();
    expect(wrapper.get("h1").text()).toBe("Visible immediately");
    expect(wrapper.text()).toContain("Loading history");
    expect(paths).toHaveLength(3);
    expect(signals).toHaveLength(2);
    wrapper.unmount();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await flushPromises();
  });

  it("keeps the supported static summary, navigator and target chunk path operational without asserting native source history", async () => {
    const paths: string[] = [];
    const turn: LegacyTurn = {
      id: "older",
      sourceTurnId: "older",
      sessionId: "thread",
      index: 20,
      userMessage: null,
      assistantMessages: [
        {
          id: "exported-answer",
          turnId: "older",
          role: "assistant",
          phase: "final",
          createdAt: summary.createdAt,
          sourceMarkdown: "**unchanged rich text**",
          body: {
            type: "document",
            children: [
              {
                type: "element",
                tagName: "strong",
                attributes: {},
                children: [{ type: "text", text: "unchanged rich text" }],
              },
            ],
          },
          attachmentIds: [],
          rawEventIds: [],
        },
      ],
      activities: [],
      startedAt: null,
      completedAt: null,
      durationMs: null,
      timeToFirstTokenMs: null,
      tokenDelta: null,
      models: [],
      reasoningEfforts: [],
      toolCounts: {},
      diagnosticIds: [],
    };
    const chunk = {
      sessionId: "thread",
      revision: "rev",
      turns: [turn],
      previousCursor: null,
      nextCursor: null,
    };
    const repository = new StaticConversationRepository(async (path) => {
      paths.push(path);
      if (path.endsWith("summary.json")) {
        return { summary };
      }
      if (path.endsWith("navigator.json")) {
        return {
          version: 2,
          chunkSize: 20,
          sessionId: "thread",
          revision: "rev",
          items: [
            {
              turnId: "older",
              index: 20,
              userMessageId: null,
              promptPreview: "Old prompt",
              assistantPreview: "",
              proseLengthBucket: 1,
              createdAt: null,
            },
          ],
          chunkCount: 2,
          turnChunks: { older: 1 },
          inspectorChunks: {},
        };
      }
      if (path.endsWith("turn-1.json")) {
        return chunk;
      }
      if (path.endsWith("history-index.json")) {
        throw Object.assign(new Error("Old archive has no history manifest"), { statusCode: 404 });
      }
      throw new Error(`Unexpected static request ${path}`);
    });
    expect(repository.capabilities().progressiveHistory).toBe(false);
    expect((await repository.getSessionMetadata("thread")).title).toBe(summary.title);
    expect((await repository.getSession("thread")).title).toBe(summary.title);
    expect((await repository.getTurnNavigator("thread"))[0]?.turnId).toBe("older");
    expect(await repository.getTurns("thread", { targetTurnId: "older" })).toEqual(chunk);
    await expect(
      repository.getHistoryPage("thread", { anchor: { kind: "latest" } }),
    ).rejects.toMatchObject({
      code: "history.unsupported",
      coverage: { status: "unsupported" },
      preparation: "unavailable",
    });
    expect(paths.some((path) => path.endsWith("turn-1.json"))).toBe(true);
    expect(paths.every((path) => path.startsWith("/payloads/sessions/thread/"))).toBe(true);
    const rendered = await mountSuspended(ConversationTurn, {
      props: {
        turn: (await repository.getTurns("thread", { targetTurnId: "older" })).turns[0]!,
        reasoningDefault: "collapsed",
        timestampFormat: "absolute",
        toolCallsDefault: "collapsed",
      },
    });
    expect(rendered.get("strong").text()).toBe("unchanged rich text");
    rendered.unmount();
  });
});
