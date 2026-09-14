import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LibrarySubagentPanel from "../../../app/components/library/LibrarySubagentPanel.vue";
import type { ConversationSummary } from "../../../shared/types/conversation.ts";
import type { ConversationListItem } from "../../../shared/types/library.ts";
import type { ConversationRepository, CursorPage } from "../../../shared/types/repository.ts";

const repository = vi.hoisted(() => ({
  listSessions: vi.fn<ConversationRepository["listSessions"]>(),
  getSession: vi.fn<ConversationRepository["getSession"]>(),
  getTurnNavigator: vi.fn<ConversationRepository["getTurnNavigator"]>(),
  getTurns: vi.fn<ConversationRepository["getTurns"]>(),
  subscribe: vi.fn<ConversationRepository["subscribe"]>(),
}));
vi.mock("../../../app/repositories/index.ts", () => ({
  createConversationRepository: () => repository,
}));
vi.mock("../../../app/components/conversation/ConversationView.vue", () => ({
  default: {
    name: "ConversationView",
    props: ["summary", "navigator", "initialChunk", "initialTargetTurnId", "embedded", "mode"],
    emits: ["openChild"],
    template:
      "<div class=\"embedded-transcript\">{{ summary.title }}<button @click=\"$emit('openChild', 'grandchild')\">Open nested subagent</button></div>",
  },
}));

function summary(id: string): ConversationSummary {
  return {
    id,
    title: `Task ${id}`,
    scope: "active",
    sourcePath: `/${id}.jsonl`,
    createdAt: "2026-09-14T10:00:00.000Z",
    updatedAt: "2026-09-14T10:00:00.000Z",
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
    preview: "Read the source",
    pinned: false,
    sectionName: null,
    parentThreadId: "parent",
    childThreadIds: [],
    hasMedia: false,
    diagnosticCount: 0,
    revision: "r1",
  };
}
function item(id: string, nickname: string | null = null): ConversationListItem {
  return {
    summary: summary(id),
    kind: "subagent",
    materialization: "ready",
    projectId: "project",
    parentThreadId: "parent",
    agentPath: id,
    agentNickname: nickname,
    agentDepth: 1,
    childCount: 0,
  };
}
function panel(selectedId: string | null = null) {
  return mount(LibrarySubagentPanel, {
    props: { parentId: "parent", selectedId, mode: "live" },
    global: {
      stubs: { NuxtLink: { props: ["to", "prefetch"], template: '<a :href="to"><slot /></a>' } },
    },
  });
}

beforeEach(() => {
  vi.stubGlobal("useRequestFetch", () => vi.fn<() => Promise<unknown>>());
  repository.subscribe.mockReturnValue(() => undefined);
  repository.listSessions.mockResolvedValue({
    items: [item("child", "Ada")],
    nextCursor: null,
    total: 1,
  });
  repository.getSession.mockImplementation(async (id: string) => summary(id));
  repository.getTurnNavigator.mockResolvedValue([]);
  repository.getTurns.mockImplementation(async (id: string) => ({
    sessionId: id,
    turns: [],
    previousCursor: null,
    nextCursor: null,
    revision: "r1",
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("LibrarySubagentPanel", () => {
  it("loads the recent child chunk and refreshes every loaded list page on invalidation", async () => {
    const unsubscribe = vi.fn<() => void>();
    repository.subscribe.mockReturnValue(unsubscribe);
    repository.listSessions
      .mockResolvedValueOnce({ items: [item("child")], nextCursor: "page2", total: 2 })
      .mockResolvedValueOnce({ items: [item("second")], nextCursor: null, total: 2 })
      .mockResolvedValueOnce({
        items: [item("child", "Updated")],
        nextCursor: "new-page2",
        total: 3,
      })
      .mockResolvedValueOnce({
        items: [item("second"), item("third")],
        nextCursor: null,
        total: 3,
      });
    repository.getSession.mockResolvedValue({ ...summary("child"), turnCount: 55 });
    const wrapper = panel();
    await flushPromises();
    await wrapper.get(".ui-button").trigger("click");
    await flushPromises();
    repository.subscribe.mock.calls[0][0]({
      type: "library.updated",
      ids: ["parent"],
      revision: "r2",
    });
    expect(wrapper.findAll(".subagent-panel__item")).toHaveLength(2);
    await flushPromises();
    expect(repository.listSessions).toHaveBeenLastCalledWith({
      scope: "active",
      parentThreadId: "parent",
      limit: 20,
      cursor: "new-page2",
    });
    expect(wrapper.findAll(".subagent-panel__item")).toHaveLength(3);
    expect(wrapper.text()).toContain("Updated");
    await wrapper.setProps({ selectedId: "child" });
    await flushPromises();
    expect(repository.getTurns).toHaveBeenLastCalledWith("child", { cursor: "2", limit: 20 });
    wrapper.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("lists associated named children and emits local selections without navigating", async () => {
    const wrapper = panel();
    await flushPromises();
    expect(repository.listSessions).toHaveBeenCalledWith({
      scope: "active",
      parentThreadId: "parent",
      limit: 20,
    });
    expect(wrapper.get("h2").text()).toBe("Subagents");
    expect(wrapper.get(".subagent-panel__item").text()).toContain("Ada");
    expect(wrapper.text()).not.toContain("completed");
    await wrapper.get(".subagent-panel__item").trigger("click");
    expect(wrapper.emitted("select")).toEqual([["child"]]);
    expect(wrapper.find("a").exists()).toBe(false);
    await wrapper.get('[aria-label="Close subagents"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("paginates and retries a failed next page without discarding loaded children", async () => {
    repository.listSessions
      .mockResolvedValueOnce({ items: [item("child")], nextCursor: "page2", total: 2 })
      .mockRejectedValueOnce(new Error("Page unavailable"))
      .mockResolvedValueOnce({ items: [item("second")], nextCursor: null, total: 2 });
    const wrapper = panel();
    await flushPromises();
    await wrapper.get(".ui-button").trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain("Page unavailable");
    expect(wrapper.findAll(".subagent-panel__item")).toHaveLength(1);
    await wrapper.get('[role="alert"] button').trigger("click");
    await flushPromises();
    expect(repository.listSessions).toHaveBeenLastCalledWith({
      scope: "active",
      parentThreadId: "parent",
      limit: 20,
      cursor: "page2",
    });
    expect(wrapper.findAll(".subagent-panel__item")).toHaveLength(2);
    wrapper.unmount();
  });

  it("embeds the selected transcript and supports full-session, nested, and back actions", async () => {
    const wrapper = panel("child");
    expect(wrapper.text()).toContain("Loading subagent conversation");
    await flushPromises();
    const conversation = wrapper.getComponent({ name: "ConversationView" });
    expect(repository.getTurns).toHaveBeenCalledWith("child", { cursor: "0", limit: 20 });
    expect(conversation.props("embedded")).toBe("");
    expect(conversation.props("initialTargetTurnId")).toBe(null);
    expect(wrapper.get("h2").text()).toBe("Ada");
    expect(wrapper.get("a").attributes("href")).toBe("/session/child");
    await conversation.get("button").trigger("click");
    expect(wrapper.emitted("select")?.at(-1)).toEqual(["grandchild"]);
    await wrapper.get('[aria-label="Back to subagents"]').trigger("click");
    expect(wrapper.emitted("select")?.at(-1)).toEqual([null]);
    await wrapper.setProps({ selectedId: null });
    expect(wrapper.find(".embedded-transcript").exists()).toBe(false);
    expect(wrapper.get("h2").text()).toBe("Subagents");
    wrapper.unmount();
  });

  it("rejects stale transcripts after selection changes and retries the selected failure", async () => {
    let resolveFirst!: (value: ConversationSummary) => void;
    repository.getSession
      .mockImplementationOnce(
        () =>
          new Promise<ConversationSummary>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("Cannot read second"));
    const wrapper = panel("first");
    await wrapper.setProps({ selectedId: "second" });
    await flushPromises();
    resolveFirst(summary("first"));
    await flushPromises();
    expect(wrapper.find(".embedded-transcript").exists()).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toContain("Cannot read second");
    await wrapper.get('[role="alert"] button').trigger("click");
    await flushPromises();
    expect(wrapper.get(".embedded-transcript").text()).toContain("Task second");
    wrapper.unmount();
  });

  it("ignores a previous parent's late list response", async () => {
    let resolveFirst!: (value: CursorPage<ConversationListItem>) => void;
    repository.listSessions
      .mockImplementationOnce(
        () =>
          new Promise<CursorPage<ConversationListItem>>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ items: [], nextCursor: null, total: 0 });
    const wrapper = panel();
    await wrapper.setProps({ parentId: "different-parent" });
    await flushPromises();
    resolveFirst({ items: [item("old-child")], nextCursor: null, total: 1 });
    await flushPromises();
    expect(wrapper.text()).toContain("No associated subagent sessions.");
    expect(wrapper.findAll(".subagent-panel__item")).toHaveLength(0);
    wrapper.unmount();
  });
});
