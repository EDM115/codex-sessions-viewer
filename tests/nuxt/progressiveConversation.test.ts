import { mountSuspended, mockComponent } from "@nuxt/test-utils/runtime";
import { flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationInspector, ConversationTurn, ConversationMessage } from "#components";
import type {
  ConversationTurn as LegacyTurn,
  ConversationSummary,
} from "#shared/types/conversation.ts";
import type { HistoryPage, HistoryTurnWindow } from "#shared/types/history.ts";
import { catalogSessionMetadataSchema } from "#shared/types/library.ts";
import type { ViewerInvalidation } from "#shared/types/repository.ts";
import ProgressiveConversationView from "~/components/conversation/ProgressiveConversationView.vue";
import { LiveApiConversationRepository } from "~/repositories/live.ts";
import { StaticConversationRepository } from "~/repositories/static.ts";

mockComponent("MediaViewer", () => ({
  name: "MediaViewer",
  props: ["item"],
  template: "<aside data-progressive-media>{{ item.filename }}</aside>",
}));

// Happy DOM has no layout, semantic mounts provide a viewport for the real measured virtualizer
beforeEach(() => {
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

describe("progressive and legacy presentation paths", () => {
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
      invalidate({ type: "session.updated", ids: ["thread"], revision: "A" });
      await flushPromises();
      const updated = wrapper
        .findAllComponents(ConversationMessage)
        .find((component) => component.props("message").id === selected.itemId)!;
      expect(wrapper.get(`[data-message-id="${selected.itemId}"]`).element).toBe(original);
      expect(wrapper.findAll(`[data-message-id="${selected.itemId}"]`)).toHaveLength(1);
      expect(wrapper.find(`[data-entry-id="${initial.itemId}"]`).exists()).toBe(false);
      expect(wrapper.findAll(".conversation-message--assistant")).toHaveLength(1);
      expect(joined.finalAnswerItemId).toBe(selected.itemId);
      await updated.get('[aria-label="Open message info"]').trigger("click");
      expect(wrapper.getComponent(ConversationInspector).props("record")?.target).toEqual({
        type: "message",
        id: selected.itemId,
      });
      expect(legacyInspector).not.toHaveBeenCalled();
      wrapper.unmount();
    },
  );
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
