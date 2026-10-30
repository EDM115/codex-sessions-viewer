import { mountSuspended as mount, mockNuxtImport } from "@nuxt/test-utils/runtime";
import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { catalogProjectGroupFromLegacy } from "#shared/types/library.ts";
import type { LibraryEntry } from "#shared/types/library.ts";
import LibraryProjectTree from "~/components/library/LibraryProjectTree.vue";
import LibrarySessionItem from "~/components/library/LibrarySessionItem.vue";
import {
  createLibraryWorkspace,
  provideLibraryWorkspace,
  type LibraryWorkspaceState,
} from "~/composables/useLibraryWorkspace.ts";

function item(id: string, overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id,
    title: `Conversation ${id}`,
    scope: "active",
    orderKey: "2026-08-16T09:00:00.000Z",
    kind: "root",
    projectId: "project-1",
    parentThreadId: null,
    childCount: 0,
    ...overrides,
  };
}

function stubWorkspaceGlobals(requestFetch: ReturnType<typeof vi.fn>) {
  const route = reactive({ path: "/", query: {}, params: {} });
  nuxtMocks.useRoute.mockImplementation(() => route);
  nuxtMocks.useRouter.mockImplementation(() => ({ replace: vi.fn() }));
  nuxtMocks.useRuntimeConfig.mockImplementation(() => ({
    public: { viewerMode: "live", pagefindEnabled: false },
  }));
  nuxtMocks.useRequestFetch.mockImplementation(() => requestFetch);
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
  it("renders saved empty projects first, populated custom sections once, and projectless Recents last", async () => {
    stubWorkspaceGlobals(vi.fn());
    const workspace = createLibraryWorkspace();
    workspace.projects.value = [
      catalogProjectGroupFromLegacy({
        id: "saved",
        name: "Saved empty",
        source: "codex",
        hint: null,
        activeCount: 0,
        archivedCount: 0,
        sidebar: { kind: "project", sectionId: null, sectionName: null },
      }),
      catalogProjectGroupFromLegacy({
        id: "section",
        name: "Review",
        source: "none",
        hint: null,
        activeCount: 1,
        archivedCount: 0,
        sidebar: { kind: "section", sectionId: "section", sectionName: "Review" },
      }),
      catalogProjectGroupFromLegacy({
        id: "in-section",
        name: "Section project",
        source: "codex",
        hint: null,
        activeCount: 0,
        archivedCount: 0,
        sidebar: { kind: "project", sectionId: "section", sectionName: "Review" },
      }),
      catalogProjectGroupFromLegacy({
        id: "none",
        name: "Recents",
        source: "none",
        hint: null,
        activeCount: 1,
        archivedCount: 0,
        sidebar: { kind: "recents", sectionId: null, sectionName: null },
      }),
    ];
    const wrapper = await mountWithWorkspace(workspace, () => h(LibraryProjectTree));
    expect(wrapper.findAll(".library-project-folder__label").map((label) => label.text())).toEqual([
      "Saved empty",
      "Chats",
      "Section project",
      "Recents",
    ]);
    expect(wrapper.findAll('[aria-label="Review"]')).toHaveLength(1);
    expect(wrapper.findAll("h3").map((heading) => heading.text())).toEqual(["Review"]);
    wrapper.unmount();
  });
  it("pages 20 roots per project and loads nested subagents only from their parent disclosure", async () => {
    const roots = Array.from({ length: 21 }, (_, index) =>
      item(`root-${index}`, index === 0 ? { childCount: 1 } : {}),
    );
    const child = item("child-1", {
      kind: "subagent",
      parentThreadId: "root-0",
    });
    child.parentThreadId = "root-0";
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
      catalogProjectGroupFromLegacy({
        id: "project-1",
        name: "Viewer",
        source: "cwd",
        hint: "C:/repo/viewer",
        activeCount: 21,
        archivedCount: 0,
      }),
    ];
    const wrapper = await mountWithWorkspace(workspace, () => h(LibraryProjectTree));

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

  it("mounts and scrolls library rows without creating preparation observers or requests", async () => {
    const observer = vi.fn<() => void>();
    vi.stubGlobal("IntersectionObserver", observer);
    const requestFetch = vi.fn<(...args: unknown[]) => Promise<unknown>>();
    stubWorkspaceGlobals(requestFetch);
    const workspace = createLibraryWorkspace();
    const items = Array.from({ length: 5 }, (_, index) => item(`visible-${index}`));
    workspace.items.value = items;
    const wrapper = await mountWithWorkspace(workspace, () =>
      h(
        "div",
        items.map((entry) => h(LibrarySessionItem, { item: entry, selected: false })),
      ),
    );
    await wrapper.trigger("scroll");
    await flushPromises();
    expect(observer).not.toHaveBeenCalled();
    expect(requestFetch).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

const nuxtMocks = vi.hoisted(() => ({
  useRoute: vi.fn<() => unknown>(),
  useRouter: vi.fn<() => unknown>(),
  useRuntimeConfig: vi.fn<() => unknown>(),
  useRequestFetch: vi.fn<() => unknown>(),
}));
mockNuxtImport("useRoute", async () => {
  const actual =
    await vi.importActual<typeof import("#app/composables/router")>("#app/composables/router");
  return () => nuxtMocks.useRoute() ?? actual.useRoute();
});
mockNuxtImport("useRequestFetch", async () => {
  const actual =
    await vi.importActual<typeof import("#app/composables/ssr")>("#app/composables/ssr");
  return () => nuxtMocks.useRequestFetch() ?? actual.useRequestFetch();
});
mockNuxtImport("useRuntimeConfig", async () => {
  const actual = await vi.importActual<typeof import("#app/nuxt")>("#app/nuxt");
  return () => ({ ...actual.useRuntimeConfig(), ...Object(nuxtMocks.useRuntimeConfig()) });
});
mockNuxtImport("useRouter", async () => {
  const actual =
    await vi.importActual<typeof import("#app/composables/router")>("#app/composables/router");
  return () => ({ ...actual.useRouter(), ...Object(nuxtMocks.useRouter()) });
});
