import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, effectScope, nextTick, reactive } from "vue";

import {
  createLibraryWorkspace,
  useLibraryWorkspace,
  useOptionalLibraryWorkspace,
} from "../../../app/composables/useLibraryWorkspace.ts";
import type { ConversationSummary } from "../../../shared/types/conversation.ts";
import type {
  ConversationListItem,
  ConversationProject,
  DeepSearchJob,
} from "../../../shared/types/library.ts";

function session(id: string, scope: "active" | "archived"): ConversationSummary {
  return {
    id,
    title: id,
    scope,
    sourcePath: `C:/${id}.jsonl`,
    createdAt: "2026-08-16T08:00:00.000Z",
    updatedAt: "2026-08-16T09:00:00.000Z",
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
    revision: "static:1",
  };
}

function item(
  id: string,
  scope: "active" | "archived" = "active",
  materialization: ConversationListItem["materialization"] = "ready",
  parentThreadId: string | null = null,
): ConversationListItem {
  return {
    summary: { ...session(id, scope), parentThreadId },
    kind: parentThreadId === null ? "root" : "subagent",
    materialization,
    projectId: "project-1",
    parentThreadId,
    agentPath: parentThreadId === null ? null : "agent-1",
    agentNickname: parentThreadId === null ? null : "Worker",
    agentDepth: parentThreadId === null ? null : 1,
    childCount: parentThreadId === null ? 1 : 0,
  };
}

const project: ConversationProject = {
  id: "project-1",
  name: "Viewer",
  source: "cwd",
  hint: "C:/repo/viewer",
  activeCount: 2,
  archivedCount: 1,
};

type RequestFetch = (path: string, options?: Record<string, unknown>) => Promise<unknown>;

function deepSearchJob(state: DeepSearchJob["state"] = "queued"): DeepSearchJob {
  return {
    id: "search-1",
    scope: "active",
    query: "needle",
    state,
    total: 2,
    completed: state === "completed" ? 2 : 0,
    failed: 0,
    resultCount: state === "completed" ? 2 : 0,
    error: null,
    createdAt: "2026-08-16T08:00:00.000Z",
    updatedAt: "2026-08-16T08:00:01.000Z",
  };
}

function stubWorkspaceGlobals(
  route: { path: string; query: Record<string, unknown> },
  requestFetch: RequestFetch,
  options: { mode?: "live" | "static"; pagefindEnabled?: boolean } = {},
) {
  const replace = vi.fn<(location: unknown) => void>();
  vi.stubGlobal("useRoute", () => route);
  vi.stubGlobal("useRouter", () => ({ replace }));
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: {
      viewerMode: options.mode ?? "live",
      pagefindEnabled: options.pagefindEnabled ?? false,
    },
  }));
  vi.stubGlobal("useRequestFetch", () => requestFetch);
  return { replace };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("persistent library workspace state", () => {
  it("settles delayed static counts once and retains them across session navigation", async () => {
    const route = reactive({ path: "/", query: {}, params: {} });
    let resolveProjects!: (value: unknown) => void;
    const delayedProjects = new Promise<unknown>((resolve) => {
      resolveProjects = resolve;
    });
    const requestFetch = vi.fn<RequestFetch>(async (path) => {
      if (path === "/payloads/sessions/index.json") {
        return {
          version: 1,
          sessions: [session("active-1", "active"), session("archived-1", "archived")],
        };
      }
      if (path === "/payloads/projects.json") {
        return delayedProjects;
      }
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal("useRoute", () => route);
    vi.stubGlobal("useRouter", () => ({ replace: vi.fn<(location: unknown) => void>() }));
    vi.stubGlobal("useRuntimeConfig", () => ({
      public: { viewerMode: "static", pagefindEnabled: true },
    }));
    vi.stubGlobal("useRequestFetch", () => requestFetch);

    const scope = effectScope();
    const workspace = scope.run(() => createLibraryWorkspace());
    if (workspace === undefined) {
      throw new Error("Expected a workspace state.");
    }
    const pending = workspace.loadPayload();
    expect(workspace.counts).toEqual({ active: 0, archived: 0 });
    resolveProjects({
      version: 1,
      projects: [
        {
          id: "project-1",
          name: "Viewer",
          source: "cwd",
          hint: "C:/repo/viewer",
          activeCount: 12,
          archivedCount: 4,
        },
      ],
      entries: {
        "active-1": {
          kind: "root",
          projectId: "project-1",
          parentThreadId: null,
          agentPath: null,
          agentNickname: null,
          agentDepth: null,
          childCount: 0,
        },
        "archived-1": {
          kind: "root",
          projectId: "project-1",
          parentThreadId: null,
          agentPath: null,
          agentNickname: null,
          agentDepth: null,
          childCount: 0,
        },
      },
    });
    workspace.hydrate(await pending);
    expect(workspace.counts).toEqual({ active: 12, archived: 4 });

    route.path = "/session/active-1";
    expect(workspace.counts).toEqual({ active: 12, archived: 4 });
    expect(workspace.selectedId.value).toBe("active-1");
    route.path = "/";
    expect(workspace.counts).toEqual({ active: 12, archived: 4 });
    scope.stop();
  });

  it("loads exact live-search filters and keeps payload kinds separate", async () => {
    const route = reactive({
      path: "/session/session%2Fencoded/details",
      query: {
        scope: "archived",
        q: "  needle  ",
        model: "gpt-5",
        cwd: "C:/repo/viewer",
        tool: "exec_command",
        media: "1",
      },
    });
    const requestFetch = vi.fn<RequestFetch>(async (path) => {
      if (path === "/api/projects") {
        return [project];
      }
      if (path === "/api/status") {
        return { state: "ready", message: null };
      }
      if (path.startsWith("/api/search?")) {
        return {
          items: [
            {
              sessionId: "archived-1",
              turnId: "turn-1",
              messageId: null,
              scope: "archived",
              title: "Needle",
              excerpt: "needle",
              score: 1,
            },
          ],
          nextCursor: "cursor-2",
          total: 1,
        };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    stubWorkspaceGlobals(route, requestFetch, { pagefindEnabled: false });
    const scope = effectScope();
    const workspace = scope.run(() => createLibraryWorkspace());
    if (workspace === undefined) {
      throw new Error("Expected a workspace state.");
    }

    const payload = await workspace.loadPayload({}, "cursor-1");

    expect(requestFetch.mock.calls.map(([path]) => path)).toContain(
      "/api/search?scope=archived&limit=20&parentThreadId=__root__&cursor=cursor-1&query=needle&model=gpt-5&cwd=C%3A%2Frepo%2Fviewer&tool=exec_command&hasMedia=true",
    );
    expect(payload).toMatchObject({
      counts: { active: 2, archived: 1 },
      hits: [expect.objectContaining({ sessionId: "archived-1" })],
      items: [],
      nextCursor: "cursor-2",
      total: 1,
    });
    expect(workspace.scope.value).toBe("archived");
    expect(workspace.selectedId.value).toBe("session/encoded");
    route.path = "/session/";
    expect(workspace.selectedId.value).toBeNull();
    route.path = "/";
    expect(workspace.selectedId.value).toBeNull();
    scope.stop();
  });

  it("uses static list filtering when exact turn search is unavailable", async () => {
    const route = reactive({ path: "/", query: { q: "active" } });
    const requestFetch = vi.fn<RequestFetch>(async (path) => {
      if (path === "/payloads/sessions/index.json") {
        return { version: 1, sessions: [session("active-1", "active")] };
      }
      if (path === "/payloads/projects.json") {
        return {
          version: 1,
          projects: [project],
          entries: {
            "active-1": {
              kind: "root",
              projectId: "project-1",
              parentThreadId: null,
              agentPath: null,
              agentNickname: null,
              agentDepth: null,
              childCount: 0,
            },
          },
        };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    stubWorkspaceGlobals(route, requestFetch, { mode: "static", pagefindEnabled: false });
    const scope = effectScope();
    const workspace = scope.run(() => createLibraryWorkspace());
    if (workspace === undefined) {
      throw new Error("Expected a workspace state.");
    }

    const payload = await workspace.loadPayload();

    expect(payload.hits).toEqual([]);
    expect(payload.items).toEqual([
      expect.objectContaining({ summary: session("active-1", "active") }),
    ]);
    expect(workspace.searchExactTurns).toBe(false);
    expect(workspace.hasSettledContent.value).toBe(false);
    workspace.hydrate(payload);
    expect(workspace.hasSettledContent.value).toBe(true);
    workspace.start();
    workspace.stop();
    scope.stop();
  });

  it("paginates project and child pages, handles failures, and toggles expansion", async () => {
    const route = reactive({ path: "/", query: {} });
    const projectFirst = item("project-first");
    const projectSecond = item("project-second");
    const childFirst = item("child-first", "active", "ready", "parent-1");
    let failProject = false;
    const requestFetch = vi.fn<RequestFetch>(async (path) => {
      if (!path.startsWith("/api/sessions?")) {
        throw new Error(`Unexpected request ${path}`);
      }
      if (path.includes("projectId=broken")) {
        if (failProject) {
          throw "non-error failure";
        }
        return { items: [], nextCursor: null, total: 0 };
      }
      if (path.includes("parentThreadId=parent-1")) {
        return path.includes("cursor=child-2")
          ? {
              items: [item("child-second", "active", "ready", "parent-1")],
              nextCursor: null,
              total: 2,
            }
          : { items: [childFirst], nextCursor: "child-2", total: 2 };
      }
      return path.includes("cursor=page-2")
        ? { items: [projectSecond], nextCursor: null, total: 2 }
        : { items: [projectFirst], nextCursor: "page-2", total: 2 };
    });
    stubWorkspaceGlobals(route, requestFetch);
    const scope = effectScope();
    const workspace = scope.run(() => createLibraryWorkspace());
    if (workspace === undefined) {
      throw new Error("Expected a workspace state.");
    }

    await workspace.loadProject("project-1");
    await workspace.loadProject("project-1", true);
    await workspace.loadProject("project-1", true);
    expect(workspace.projectPages.get("project-1")).toMatchObject({
      items: [projectFirst, projectSecond],
      nextCursor: null,
      total: 2,
    });
    await workspace.toggleProject("project-1");
    expect(workspace.expandedProjectIds.value.has("project-1")).toBe(true);
    await workspace.toggleProject("project-1");
    expect(workspace.expandedProjectIds.value.has("project-1")).toBe(false);

    const parent = item("parent-1", "active", "ready");
    await workspace.loadChildren(parent);
    await workspace.loadChildren(parent, true);
    await workspace.loadChildren(parent, true);
    expect(workspace.childPages.get("parent-1")?.items).toEqual([
      childFirst,
      item("child-second", "active", "ready", "parent-1"),
    ]);
    await workspace.toggleSession(parent);
    expect(workspace.expandedSessionIds.value.has("parent-1")).toBe(true);
    await workspace.toggleSession(parent);
    expect(workspace.expandedSessionIds.value.has("parent-1")).toBe(false);

    failProject = true;
    await workspace.loadProject("broken");
    expect(workspace.projectPages.get("broken")?.error).toBe(
      "The local session source could not be read.",
    );
    scope.stop();
  });

  it("keeps the latest refresh, surfaces real failures, and appends the next page", async () => {
    const route = reactive({ path: "/", query: { q: "needle" } });
    let searchCall = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const requestFetch = vi.fn<RequestFetch>(async (path) => {
      if (path === "/api/projects") {
        return [project];
      }
      if (path === "/api/status") {
        return { state: "ready", message: null };
      }
      if (path.startsWith("/api/search?")) {
        searchCall += 1;
        if (searchCall === 1) {
          await firstGate;
        }
        if (searchCall === 3) {
          throw new Error("search failed");
        }
        return {
          items: [
            {
              sessionId: `session-${searchCall}`,
              turnId: "turn-1",
              messageId: null,
              scope: "active",
              title: "Needle",
              excerpt: "needle",
              score: 1,
            },
          ],
          nextCursor: searchCall === 2 ? "next" : null,
          total: 2,
        };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    stubWorkspaceGlobals(route, requestFetch);
    const scope = effectScope();
    const workspace = scope.run(() => createLibraryWorkspace());
    if (workspace === undefined) {
      throw new Error("Expected a workspace state.");
    }

    const stale = workspace.refresh();
    const latest = workspace.refresh();
    await latest;
    releaseFirst();
    await stale;
    expect(workspace.hits.value.map(({ sessionId }) => sessionId)).toEqual(["session-2"]);
    await workspace.refresh();
    expect(workspace.error.value).toBe("search failed");
    await workspace.refresh(true);
    expect(workspace.hits.value.map(({ sessionId }) => sessionId)).toEqual([
      "session-2",
      "session-4",
    ]);
    await workspace.refresh(true);
    expect(workspace.hits.value.map(({ sessionId }) => sessionId)).toEqual([
      "session-2",
      "session-4",
      "session-5",
    ]);
    expect(workspace.loading.value).toBe(false);
    scope.stop();
  });

  it("prepares observed sessions, retries failures, and controls deep search", async () => {
    const route = reactive({ path: "/", query: { q: "needle" } });
    let preparationFails = false;
    const requestFetch = vi.fn<RequestFetch>(async (path, options) => {
      if (path === "/api/sessions/prepare") {
        const body = options?.["body"];
        if (
          typeof body !== "object" ||
          body === null ||
          !("ids" in body) ||
          !Array.isArray(body.ids) ||
          !body.ids.every((id) => typeof id === "string")
        ) {
          throw new Error("Expected a preparation request body.");
        }
        const ids = body.ids;
        if (preparationFails) {
          throw new Error("preparation failed");
        }
        return ids.map((id) => ({ id, state: "ready", error: null }));
      }
      if (path === "/api/search/materialize" && options?.["method"] === "POST") {
        return deepSearchJob();
      }
      if (path === "/api/search/materialize/search-1" && options?.["method"] === "DELETE") {
        return {};
      }
      throw new Error(`Unexpected request ${path}`);
    });
    stubWorkspaceGlobals(route, requestFetch);
    let observerCallback!: IntersectionObserverCallback;
    const observe = vi.fn<(target: Element) => void>();
    const unobserve = vi.fn<(target: Element) => void>();
    const disconnect = vi.fn<() => void>();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          observerCallback = callback;
        }
        observe = observe;
        unobserve = unobserve;
        disconnect = disconnect;
      },
    );
    const scope = effectScope();
    const workspace = scope.run(() => createLibraryWorkspace());
    if (workspace === undefined) {
      throw new Error("Expected a workspace state.");
    }
    const coldItems = Array.from({ length: 21 }, (_, index) =>
      item(`cold-${index + 1}`, "active", "cold"),
    );
    const cold = coldItems[0];
    if (cold === undefined) {
      throw new Error("Expected one cold session.");
    }
    workspace.hydrate({
      counts: { active: 21, archived: 0 },
      hits: [],
      items: coldItems,
      nextCursor: null,
      projects: [project],
      runtimeStatus: { state: "ready", message: null },
      total: 21,
    });
    const elements = coldItems.map(() => document.createElement("article"));
    const firstElement = elements[0];
    if (firstElement === undefined) {
      throw new Error("Expected one observed element.");
    }
    const stopObserving = workspace.observeSession(firstElement, cold);
    coldItems.slice(1).forEach((candidate, index) => {
      const element = elements[index + 1];
      if (element !== undefined) {
        workspace.observeSession(element, candidate);
      }
    });
    expect(observe).toHaveBeenCalledTimes(21);
    const unknownElement = document.createElement("article");
    const intersectionEntry = (
      target: Element,
      isIntersecting: boolean,
    ): IntersectionObserverEntry => ({
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRatio: isIntersecting ? 1 : 0,
      intersectionRect: target.getBoundingClientRect(),
      isIntersecting,
      rootBounds: null,
      target,
      time: 0,
    });
    const observer: IntersectionObserver = {
      disconnect,
      observe,
      root: null,
      rootMargin: "",
      takeRecords: () => [],
      thresholds: [],
      unobserve,
    };
    observerCallback(
      [
        intersectionEntry(unknownElement, false),
        intersectionEntry(unknownElement, true),
        ...elements.map((target) => intersectionEntry(target, true)),
      ],
      observer,
    );
    await vi.waitFor(() =>
      expect(coldItems.every(({ materialization }) => materialization === "ready")).toBe(true),
    );
    expect(unobserve).toHaveBeenCalledWith(firstElement);
    stopObserving();
    expect(workspace.observeSession(firstElement, cold)).toEqual(expect.any(Function));

    preparationFails = true;
    await workspace.retryPreparation("cold-1");
    expect(cold.materialization).toBe("failed");
    preparationFails = false;
    await workspace.retryPreparation("missing-item");
    await workspace.cancelDeepSearch();
    await workspace.startDeepSearch();
    expect(workspace.deepSearchJob.value?.state).toBe("queued");
    await workspace.cancelDeepSearch();
    expect(workspace.deepSearchJob.value?.state).toBe("cancelled");
    route.query.q = "";
    workspace.deepSearchJob.value = null;
    await workspace.startDeepSearch();
    expect(workspace.deepSearchJob.value).toBeNull();
    workspace.stop();
    expect(disconnect).toHaveBeenCalledOnce();
    scope.stop();
  });

  it("updates route filters, restores focus, and reports missing injection", async () => {
    const route = reactive({
      path: "/",
      query: { scope: "archived", q: "old", media: "1" },
    });
    const { replace } = stubWorkspaceGlobals(route, async () => {
      throw new Error("Requester should not run.");
    });
    const scope = effectScope();
    const workspace = scope.run(() => createLibraryWorkspace());
    if (workspace === undefined) {
      throw new Error("Expected a workspace state.");
    }
    workspace.updateQuery("scope", "active");
    workspace.updateQuery("media", false);
    workspace.updateQuery("pinned", true);
    workspace.updateQuery("model", "gpt-5");
    expect(replace.mock.calls).toEqual([
      [{ query: { q: "old", media: "1" } }],
      [{ query: { scope: "archived", q: "old" } }],
      [{ query: { scope: "archived", q: "old", media: "1", pinned: "1" } }],
      [{ query: { scope: "archived", q: "old", media: "1", model: "gpt-5" } }],
    ]);

    const opener = document.createElement("div");
    opener.className = "library-workbench__opener";
    const button = document.createElement("button");
    opener.append(button);
    document.body.append(opener);
    workspace.sidebarOpen.value = true;
    await workspace.closeSidebar();
    await nextTick();
    expect(workspace.sidebarOpen.value).toBe(false);
    expect(document.activeElement).toBe(button);
    opener.remove();
    const injectionProbe = mount(
      defineComponent({
        setup() {
          const optional = useOptionalLibraryWorkspace();
          let requiredError: string | null = null;
          try {
            useLibraryWorkspace();
          } catch (error) {
            requiredError = error instanceof Error ? error.message : String(error);
          }
          return { optional, requiredError };
        },
        template: "<div />",
      }),
    );
    expect(injectionProbe.vm.optional).toBeNull();
    expect(injectionProbe.vm.requiredError).toBe(
      "Library workspace is unavailable outside the default library layout.",
    );
    injectionProbe.unmount();
    scope.stop();
  });

  it("reacts to repository invalidations and refreshes a completed deep search", async () => {
    vi.useFakeTimers();
    const route = reactive({ path: "/", query: { q: "needle" } });
    let deepSearchState: DeepSearchJob["state"] = "running";
    const requestFetch = vi.fn<RequestFetch>(async (path) => {
      if (path === "/api/projects") {
        return [project];
      }
      if (path === "/api/status") {
        return { state: "ready", message: null };
      }
      if (path.startsWith("/api/search?")) {
        return { items: [], nextCursor: null, total: 0 };
      }
      if (path.startsWith("/api/sessions?")) {
        return { items: [], nextCursor: null, total: 0 };
      }
      if (path === "/api/search/materialize/search-1") {
        return deepSearchJob(deepSearchState);
      }
      throw new Error(`Unexpected request ${path}`);
    });
    stubWorkspaceGlobals(route, requestFetch);
    const listeners = new Map<string, EventListener>();
    const removeEventListener = vi.fn<(type: string) => boolean>((type) => listeners.delete(type));
    const close = vi.fn<() => void>();
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener(type: string, listener: EventListener) {
          listeners.set(type, listener);
        }
        removeEventListener = removeEventListener;
        close = close;
      },
    );
    const scope = effectScope();
    const workspace = scope.run(() => createLibraryWorkspace());
    if (workspace === undefined) {
      throw new Error("Expected a workspace state.");
    }
    workspace.hydrate({
      counts: { active: 2, archived: 1 },
      hits: [],
      items: [],
      nextCursor: null,
      projects: [project],
      runtimeStatus: { state: "ready", message: null },
      total: 0,
    });
    workspace.deepSearchJob.value = deepSearchJob();
    workspace.start();
    await vi.runAllTimersAsync();

    listeners.get("library.updated")?.(
      new MessageEvent("library.updated", {
        data: JSON.stringify({ type: "library.updated", ids: ["session-1"], revision: "2" }),
      }),
    );
    await vi.runAllTimersAsync();
    listeners.get("search.updated")?.(
      new MessageEvent("search.updated", {
        data: JSON.stringify({ type: "search.updated", ids: ["other"], revision: "3" }),
      }),
    );
    listeners.get("search.updated")?.(
      new MessageEvent("search.updated", {
        data: JSON.stringify({ type: "search.updated", ids: ["search-1"], revision: "4" }),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(workspace.deepSearchJob.value?.state).toBe("running");
    deepSearchState = "completed";
    listeners.get("search.updated")?.(
      new MessageEvent("search.updated", {
        data: JSON.stringify({ type: "search.updated", ids: ["search-1"], revision: "5" }),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await vi.runAllTimersAsync();

    expect(workspace.deepSearchJob.value?.state).toBe("completed");
    route.query.q = "";
    workspace.expandedProjectIds.value = new Set(["project-1"]);
    listeners.get("library.updated")?.(
      new MessageEvent("library.updated", {
        data: JSON.stringify({ type: "library.updated", ids: ["session-2"], revision: "6" }),
      }),
    );
    await vi.runAllTimersAsync();
    expect(
      requestFetch.mock.calls.filter(([path]) => path === "/api/projects").length,
    ).toBeGreaterThan(1);
    workspace.stop();
    expect(removeEventListener).toHaveBeenCalledTimes(5);
    expect(close).toHaveBeenCalledOnce();
    scope.stop();
    vi.useRealTimers();
  });

  it("polls live readiness until the catalog is ready and then refreshes", async () => {
    vi.useFakeTimers();
    const route = reactive({ path: "/", query: {} });
    let statusCalls = 0;
    const requestFetch = vi.fn<RequestFetch>(async (path) => {
      if (path === "/api/projects") {
        return [project];
      }
      if (path === "/api/status") {
        statusCalls += 1;
        return statusCalls < 3
          ? { state: "preparing", message: null }
          : { state: "ready", message: null };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    stubWorkspaceGlobals(route, requestFetch);
    vi.stubGlobal("EventSource", undefined);
    const scope = effectScope();
    const workspace = scope.run(() => createLibraryWorkspace());
    if (workspace === undefined) {
      throw new Error("Expected a workspace state.");
    }

    workspace.start();
    await vi.waitFor(() => expect(statusCalls).toBeGreaterThanOrEqual(2));
    await vi.advanceTimersByTimeAsync(750);
    await vi.waitFor(() => expect(workspace.runtimeStatus.value.state).toBe("ready"));
    expect(workspace.error.value).toBeNull();
    workspace.stop();
    scope.stop();
    vi.useRealTimers();
  });

  it("surfaces readiness failure details and the bounded fallback message", async () => {
    const route = reactive({ path: "/", query: {} });
    let useFallback = false;
    const requestFetch = vi.fn<RequestFetch>(async (path) => {
      if (path === "/api/projects") {
        return [project];
      }
      if (path === "/api/status") {
        return { state: "error", message: useFallback ? null : "Catalog failed" };
      }
      throw new Error(`Unexpected request ${path}`);
    });
    stubWorkspaceGlobals(route, requestFetch);
    vi.stubGlobal("EventSource", undefined);
    const scope = effectScope();
    const workspace = scope.run(() => createLibraryWorkspace());
    if (workspace === undefined) {
      throw new Error("Expected a workspace state.");
    }

    workspace.start();
    await vi.waitFor(() => expect(workspace.error.value).toBe("Catalog failed"));
    useFallback = true;
    workspace.hydrate(await workspace.loadPayload());
    expect(workspace.error.value).toBe("The local session catalog could not be loaded.");
    workspace.stop();
    scope.stop();
  });

  it("uses the bounded generic error when readiness rejects a non-Error value", async () => {
    const route = reactive({ path: "/", query: {} });
    const requestFetch = vi.fn<RequestFetch>(async (path) => {
      if (path === "/api/projects") {
        return [project];
      }
      if (path === "/api/status") {
        throw "untrusted rejection";
      }
      throw new Error(`Unexpected request ${path}`);
    });
    stubWorkspaceGlobals(route, requestFetch);
    vi.stubGlobal("EventSource", undefined);
    const scope = effectScope();
    const workspace = scope.run(() => createLibraryWorkspace());
    if (workspace === undefined) {
      throw new Error("Expected a workspace state.");
    }

    workspace.start();
    await vi.waitFor(() =>
      expect(workspace.error.value).toBe("The local session source could not be read."),
    );
    workspace.stop();
    scope.stop();
  });
});
