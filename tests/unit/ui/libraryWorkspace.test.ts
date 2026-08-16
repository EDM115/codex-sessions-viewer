import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, reactive } from "vue";

import { createLibraryWorkspace } from "../../../app/composables/useLibraryWorkspace.ts";
import type { ConversationSummary } from "../../../shared/types/conversation.ts";

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

afterEach(() => vi.unstubAllGlobals());

describe("persistent library workspace state", () => {
  it("settles delayed static counts once and retains them across session navigation", async () => {
    const route = reactive({ path: "/", query: {}, params: {} });
    let resolveProjects!: (value: unknown) => void;
    const delayedProjects = new Promise<unknown>((resolve) => {
      resolveProjects = resolve;
    });
    const requestFetch = vi.fn(async (path: string) => {
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
    vi.stubGlobal("useRouter", () => ({ replace: vi.fn() }));
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
});
