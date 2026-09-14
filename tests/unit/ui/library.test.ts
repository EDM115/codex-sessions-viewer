import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reactive } from "vue";

import LibraryEmptyState from "../../../app/components/library/LibraryEmptyState.vue";
import LibraryPreparationState from "../../../app/components/library/LibraryPreparationState.vue";
import LibrarySearchResults from "../../../app/components/library/LibrarySearchResults.vue";
import LibrarySessionList from "../../../app/components/library/LibrarySessionList.vue";
import { createLibraryWorkspace } from "../../../app/composables/useLibraryWorkspace.ts";
import type { ConversationSummary } from "../../../shared/types/conversation.ts";
import type { ConversationListItem } from "../../../shared/types/library.ts";

function session(id: string, title: string): ConversationSummary {
  return {
    id,
    title,
    scope: "active",
    sourcePath: `C:/codex/sessions/${id}.jsonl`,
    createdAt: "2026-08-15T08:00:00.000Z",
    updatedAt: "2026-08-15T09:00:00.000Z",
    cwd: "C:/repo/viewer",
    gitBranch: "main",
    gitSha: null,
    gitOriginUrl: null,
    models: ["gpt-5"],
    reasoningEfforts: ["high"],
    turnCount: 4,
    assistantMessageCount: 4,
    toolCallCount: 2,
    toolCounts: { exec_command: 2 },
    preview: "Implement the local viewer shell",
    pinned: false,
    sectionName: "Today",
    parentThreadId: null,
    childThreadIds: [],
    hasMedia: false,
    diagnosticCount: 0,
    revision: "revision-1",
  };
}

function item(id: string, title: string): ConversationListItem {
  return {
    summary: session(id, title),
    kind: "root",
    materialization: "ready",
    projectId: "project-1",
    parentThreadId: null,
    agentPath: null,
    agentNickname: null,
    agentDepth: null,
    childCount: 0,
  };
}

class TestEventSource {
  static latest: TestEventSource | null = null;
  readonly listeners = new Map<string, Set<EventListener>>();

  constructor(_url: string) {
    TestEventSource.latest = this;
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {}

  emit(type: string, payload: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

afterEach(() => {
  TestEventSource.latest = null;
  vi.unstubAllGlobals();
});

describe("library presentation components", () => {
  it("does not refetch for empty or unrelated invalidations and refreshes for an affected library event", async () => {
    const route = reactive({ path: "/", query: {} });
    let activeCount = 1;
    let visibleItems = [item("affected-session", "Initial title")];
    const requester = vi.fn(async (path: string) => {
      if (path === "/api/projects") {
        return [
          {
            id: "project-1",
            name: "Viewer",
            source: "codex",
            hint: null,
            activeCount,
            archivedCount: 0,
          },
        ];
      }
      if (path === "/api/status") {
        return { state: "ready", message: null };
      }
      if (path.startsWith("/api/sessions?")) {
        return { items: visibleItems, nextCursor: null, total: visibleItems.length };
      }
      throw new Error(`Unexpected UI request: ${path}`);
    });
    vi.stubGlobal("useRoute", () => route);
    vi.stubGlobal("useRouter", () => ({ replace: vi.fn(async () => undefined) }));
    vi.stubGlobal("useRuntimeConfig", () => ({
      public: { pagefindEnabled: false, viewerMode: "live" },
    }));
    vi.stubGlobal("useRequestFetch", () => requester);
    vi.stubGlobal("EventSource", TestEventSource);
    const workspace = createLibraryWorkspace();

    try {
      workspace.start();
      await vi.waitFor(() => expect(workspace.runtimeStatus.value.state).toBe("ready"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await workspace.toggleProject("project-1");
      expect(workspace.projectPages.get("project-1")?.items[0]?.summary.title).toBe(
        "Initial title",
      );
      requester.mockClear();
      const source = TestEventSource.latest;
      if (source === null) {
        throw new Error("Expected the live repository to subscribe to invalidations.");
      }

      source.emit("library.updated", { type: "library.updated", ids: [], revision: "live:1" });
      source.emit("session.updated", {
        type: "session.updated",
        ids: ["unrelated-session"],
        revision: "live:2",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(requester).not.toHaveBeenCalled();

      activeCount = 2;
      visibleItems = [item("affected-session", "Updated title")];
      source.emit("library.updated", {
        type: "library.updated",
        ids: ["affected-session"],
        revision: "live:3",
      });
      await vi.waitFor(() => {
        expect(workspace.counts.active).toBe(2);
        expect(workspace.projectPages.get("project-1")?.items[0]?.summary.title).toBe(
          "Updated title",
        );
      });
      expect(requester).toHaveBeenCalledTimes(3);

      requester.mockClear();
      activeCount = 0;
      visibleItems = [];
      source.emit("library.updated", {
        type: "library.updated",
        ids: ["affected-session"],
        revision: "live:4",
      });
      await vi.waitFor(() => {
        expect(workspace.counts.active).toBe(0);
        expect(workspace.projectPages.get("project-1")?.items).toEqual([]);
      });
      expect(requester).toHaveBeenCalledTimes(3);
    } finally {
      workspace.stop();
    }
  });

  it("shows a session skeleton while the read-only live cache is preparing and a visible failure if preparation stops", async () => {
    const wrapper = mount(LibraryPreparationState, {
      props: { state: "preparing", message: null },
    });

    expect(wrapper.get('[role="status"]').text()).toContain("Preparing your local archive");
    expect(wrapper.text()).toContain("Codex source files remain read-only");
    expect(wrapper.findAll(".library-skeleton__row")).toHaveLength(4);

    await wrapper.setProps({
      state: "error",
      message: "The local session cache could not be prepared.",
    });
    expect(wrapper.get('[role="alert"]').text()).toContain(
      "The local session cache could not be prepared.",
    );
    expect(wrapper.find(".library-skeleton").exists()).toBe(false);
  });

  it("renders safe highlighted excerpts with exact turn destinations", () => {
    const wrapper = mount(LibrarySearchResults, {
      props: {
        hits: [
          {
            sessionId: "session/1",
            parentThreadId: "parent/1",
            turnId: "turn 3",
            messageId: null,
            scope: "active",
            title: "Build the viewer — Turn 3",
            excerpt: "The <mark>viewer</mark> &lt;script&gt; stays read-only.",
            score: 1,
          },
        ],
        query: "viewer",
      },
    });

    expect(wrapper.get("a").attributes("href")).toBe(
      "/session/session%2F1?turn=turn%203#turn-turn%203",
    );
    expect(wrapper.get("mark").text()).toBe("viewer");
    expect(wrapper.find("script").exists()).toBe(false);
    expect(wrapper.text()).toContain("<script> stays read-only.");
    expect(wrapper.text()).toContain("Subagent ·");
    expect(wrapper.get('a[href="/session/parent%2F1"]').text()).toBe("Open parent conversation");
  });

  it("marks the selected session and supports arrow-key focus movement", async () => {
    const wrapper = mount(LibrarySessionList, {
      attachTo: document.body,
      props: {
        items: [item("session-1", "First"), item("session-2", "Second")],
        selectedId: "session-1",
      },
    });
    const links = wrapper.findAll("a");
    const firstLink = links[0];
    const secondLink = links[1];
    if (firstLink === undefined || secondLink === undefined) {
      throw new Error("Expected two session links.");
    }

    expect(firstLink.attributes("aria-current")).toBe("page");
    await firstLink.trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(secondLink.element);
    await secondLink.trigger("keydown", { key: "ArrowUp" });
    expect(document.activeElement).toBe(firstLink.element);

    wrapper.unmount();
  });

  it("groups dated sessions, clamps focus movement, ignores unrelated keys, and virtualizes large archives", async () => {
    const dated = [
      item("session-1", "First"),
      item("session-2", "Second"),
      item("session-3", "Third"),
    ];
    dated[0].summary.sectionName = null;
    dated[1].summary.sectionName = null;
    dated[2].summary.sectionName = null;
    dated[2].summary.updatedAt = "2026-08-14T09:00:00.000Z";
    const wrapper = mount(LibrarySessionList, {
      attachTo: document.body,
      props: { items: dated },
    });
    const links = wrapper.findAll("a");
    expect(wrapper.findAll(".library-session-group").map((group) => group.text())).toEqual([
      "2026-08-15",
      "2026-08-14",
    ]);
    await links[0].trigger("keydown", { key: "Escape" });
    expect(document.activeElement).not.toBe(links[1].element);
    await links[0].trigger("keydown", { key: "ArrowUp" });
    expect(document.activeElement).toBe(links[0].element);
    await links[2].trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(links[2].element);
    wrapper.unmount();

    const virtual = mount(LibrarySessionList, {
      attachTo: document.body,
      props: {
        items: Array.from({ length: 41 }, (_, index) =>
          item(`session-${index}`, `Session ${index}`),
        ),
      },
    });
    expect(virtual.find(".library-session-list__virtual").exists()).toBe(true);
    expect(virtual.findAll(".library-session-list__virtual-row").length).toBeGreaterThan(0);
    virtual.unmount();
  });

  it("offers retry only when an empty state is recoverable", async () => {
    const wrapper = mount(LibraryEmptyState, {
      props: {
        title: "The source could not be read",
        description: "Check the diagnostic and try again.",
        recoverable: true,
      },
    });

    await wrapper.get("button").trigger("click");
    expect(wrapper.emitted("retry")).toHaveLength(1);
    await wrapper.setProps({ recoverable: false });
    expect(wrapper.find("button").exists()).toBe(false);
  });
});
