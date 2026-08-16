import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, reactive } from "vue";

import LibraryProjectTree from "../../../app/components/library/LibraryProjectTree.vue";
import LibrarySessionItem from "../../../app/components/library/LibrarySessionItem.vue";
import {
  createLibraryWorkspace,
  provideLibraryWorkspace,
  type LibraryWorkspaceState,
} from "../../../app/composables/useLibraryWorkspace.ts";
import type { ConversationSummary } from "../../../shared/types/conversation.ts";
import type { ConversationListItem } from "../../../shared/types/library.ts";

function summary(id: string): ConversationSummary {
  return {
    id,
    title: `Conversation ${id}`,
    scope: "active",
    sourcePath: `C:/codex/sessions/${id}.jsonl`,
    createdAt: "2026-08-16T08:00:00.000Z",
    updatedAt: "2026-08-16T09:00:00.000Z",
    cwd: "C:/repo/viewer",
    gitBranch: null,
    gitSha: null,
    gitOriginUrl: null,
    models: [],
    reasoningEfforts: [],
    turnCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
    toolCounts: {},
    preview: "Catalog metadata",
    pinned: false,
    sectionName: "Today",
    parentThreadId: null,
    childThreadIds: [],
    hasMedia: false,
    diagnosticCount: 0,
    revision: "catalog:1",
  };
}

function item(id: string, overrides: Partial<ConversationListItem> = {}): ConversationListItem {
  return {
    summary: summary(id),
    kind: "root",
    materialization: "cold",
    projectId: "project-1",
    parentThreadId: null,
    agentPath: null,
    agentNickname: null,
    agentDepth: null,
    childCount: 0,
    ...overrides,
  };
}

function stubWorkspaceGlobals(requestFetch: ReturnType<typeof vi.fn>) {
  const route = reactive({ path: "/", query: {}, params: {} });
  vi.stubGlobal("useRoute", () => route);
  vi.stubGlobal("useRouter", () => ({ replace: vi.fn() }));
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: { viewerMode: "live", pagefindEnabled: false },
  }));
  vi.stubGlobal("useRequestFetch", () => requestFetch);
  return route;
}

function mountWithWorkspace(workspace: LibraryWorkspaceState, render: () => ReturnType<typeof h>) {
  return mount(
    defineComponent({
      setup() {
        provideLibraryWorkspace(workspace);
        return render;
      },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("project and preparation library tree", () => {
  it("pages 20 roots per project and loads nested subagents only from their parent disclosure", async () => {
    const roots = Array.from({ length: 21 }, (_, index) =>
      item(`root-${index}`, index === 0 ? { childCount: 1 } : {}),
    );
    const child = item("child-1", {
      kind: "subagent",
      parentThreadId: "root-0",
      agentDepth: 1,
      agentNickname: "Fermat",
    });
    child.summary.parentThreadId = "root-0";
    const requestFetch = vi.fn(async (path: string) => {
      if (path === "/api/status") {
        return { state: "ready", message: null };
      }
      if (path.startsWith("/api/sessions?")) {
        const query = new URL(path, "http://viewer.test").searchParams;
        if (query.get("parentThreadId") === "root-0") {
          return { items: [child], nextCursor: null, total: 1 };
        }
        if (query.get("cursor") === "20") {
          return { items: roots.slice(20), nextCursor: null, total: 21 };
        }
        return { items: roots.slice(0, 20), nextCursor: "20", total: 21 };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    stubWorkspaceGlobals(requestFetch);
    const workspace = createLibraryWorkspace();
    workspace.projects.value = [
      {
        id: "project-1",
        name: "Viewer",
        source: "cwd",
        hint: "C:/repo/viewer",
        activeCount: 21,
        archivedCount: 0,
      },
    ];
    const wrapper = mountWithWorkspace(workspace, () => h(LibraryProjectTree));

    await wrapper.get(".library-project-folder__toggle").trigger("click");
    await flushPromises();
    expect(wrapper.findAll(".library-session-item")).toHaveLength(20);
    expect(requestFetch.mock.calls[0]?.[0]).toContain("limit=20");
    expect(requestFetch.mock.calls[0]?.[0]).toContain("parentThreadId=__root__");

    await wrapper.get(".library-project-folder__more").trigger("click");
    await flushPromises();
    expect(wrapper.findAll(".library-session-item")).toHaveLength(21);
    expect(requestFetch.mock.calls[1]?.[0]).toContain("cursor=20");

    await wrapper.get('[aria-label="Expand subagents for Conversation root-0"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Conversation child-1");
    expect(requestFetch.mock.calls[2]?.[0]).toContain("parentThreadId=root-0");
    wrapper.unmount();
  });

  it("deduplicates intersecting cold rows into one bounded preparation batch", async () => {
    let observerCallback!: IntersectionObserverCallback;
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    class TestIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    const requestFetch = vi.fn(async (path: string, options: { body?: unknown } = {}) => {
      if (path === "/api/sessions/prepare") {
        const ids = (options.body as { ids: string[] }).ids;
        return ids.map((id) => ({ id, state: "ready", error: null }));
      }
      throw new Error(`Unexpected request ${path}`);
    });
    stubWorkspaceGlobals(requestFetch);
    const workspace = createLibraryWorkspace();
    const items = Array.from({ length: 5 }, (_, index) => item(`visible-${index}`));
    workspace.items.value = items;
    const wrapper = mountWithWorkspace(workspace, () =>
      h(
        "div",
        items.map((entry) => h(LibrarySessionItem, { item: entry, selected: false })),
      ),
    );
    const rows = wrapper.findAll(".library-session-row").map(({ element }) => element);
    const entries = rows.map(
      (target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry,
    );
    observerCallback(entries, {} as IntersectionObserver);
    observerCallback(entries, {} as IntersectionObserver);
    await flushPromises();

    expect(requestFetch).toHaveBeenCalledOnce();
    expect(requestFetch).toHaveBeenCalledWith(
      "/api/sessions/prepare",
      expect.objectContaining({
        method: "POST",
        body: { ids: items.map((item) => item.summary.id) },
      }),
    );
    expect(items.every(({ materialization }) => materialization === "ready")).toBe(true);
    wrapper.unmount();
  });
});
