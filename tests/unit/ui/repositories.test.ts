import { describe, expect, it, vi } from "vitest";

import { createConversationRepository } from "../../../app/repositories/index.ts";
import { LiveApiConversationRepository } from "../../../app/repositories/live.ts";
import type { RepositoryRequester } from "../../../app/repositories/live.ts";
import { StaticConversationRepository } from "../../../app/repositories/static.ts";
import type {
  PagefindBrowserApi,
  PagefindSearchResponse,
} from "../../../app/repositories/static.ts";
import type { ConversationSummary } from "../../../shared/types/conversation.ts";
import type {
  InspectorRecord,
  ResolvedAsset,
  TurnChunk,
} from "../../../shared/types/repository.ts";

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "session-1",
    title: "Build the viewer",
    scope: "active",
    sourcePath: "C:/codex/sessions/session-1.jsonl",
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
    ...overrides,
  };
}

function inspector(target: InspectorRecord["target"]): InspectorRecord {
  return {
    sessionId: "session-1",
    target,
    models: [],
    reasoningEfforts: [],
    phase: null,
    createdAt: null,
    completedAt: null,
    durationMs: null,
    timeToFirstTokenMs: null,
    tokenDelta: null,
    toolCounts: {},
    activityIds: [],
    eventIds: [],
    diagnosticIds: [],
    rawRecords: [],
  };
}

function inspectorChunk(records: readonly InspectorRecord[]) {
  return {
    version: 2,
    sessionId: "session-1",
    revision: "revision-1",
    records: records.map(({ rawRecords: _rawRecords, ...record }) => record),
    rawRecords: {},
  } as const;
}

function turnChunk(): TurnChunk {
  return {
    sessionId: "session-1",
    turns: [],
    previousCursor: null,
    nextCursor: null,
    revision: "revision-1",
  };
}

describe("conversation repository adapters", () => {
  it("rejects an absent exact-turn target consistently in static and live modes", async () => {
    const staticRequest = vi.fn<RepositoryRequester>(async (path) => {
      if (path.endsWith("/navigator.json")) {
        return {
          version: 2,
          sessionId: "session-1",
          revision: "revision-1",
          chunkSize: 20,
          chunkCount: 0,
          items: [],
          turnChunks: {},
          inspectorChunks: {},
        };
      }
      throw new Error(`Unexpected static request: ${path}`);
    });
    const liveRequest = vi
      .fn<RepositoryRequester>()
      .mockRejectedValue(new Error("Viewer API request failed with HTTP 404."));

    await expect(
      new StaticConversationRepository(staticRequest).getTurns("session-1", {
        targetTurnId: "missing-turn",
        limit: 20,
      }),
    ).rejects.toThrow("Turn target not found");
    await expect(
      new LiveApiConversationRepository(liveRequest).getTurns("session-1", {
        targetTurnId: "missing-turn",
        limit: 20,
      }),
    ).rejects.toThrow("HTTP 404");
    expect(staticRequest).toHaveBeenCalledOnce();
    expect(liveRequest).toHaveBeenCalledWith(
      "/api/sessions/session-1/turns?targetTurnId=missing-turn&limit=20",
    );
  });

  it("paginates and filters the static session index without mutating its source", async () => {
    const sessions = [
      summary(),
      summary({ id: "session-2", title: "Archived research", scope: "archived", models: ["o3"] }),
      summary({
        id: "session-3",
        title: "Viewer follow-up",
        updatedAt: "2026-08-14T09:00:00.000Z",
      }),
    ];
    const originalSessions = structuredClone(sessions);
    const request = vi.fn<RepositoryRequester>(async () => ({ version: 1, sessions }));
    const repository = new StaticConversationRepository(request, async () => ({
      search: vi.fn<PagefindBrowserApi["search"]>(async () => ({ results: [] })),
    }));

    const first = await repository.listSessions({ scope: "active", query: "viewer", limit: 1 });
    const second = await repository.listSessions({
      scope: "active",
      query: "viewer",
      cursor: first.nextCursor ?? undefined,
      limit: 1,
    });

    expect(first).toMatchObject({
      total: 2,
      nextCursor: "1",
      items: [{ summary: { id: "session-1" } }],
    });
    expect(second).toMatchObject({
      total: 2,
      nextCursor: null,
      items: [{ summary: { id: "session-3" } }],
    });
    expect(sessions).toEqual(originalSessions);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("applies every static library filter and normalizes invalid cursors", async () => {
    const sessions = [
      summary(),
      summary({
        id: "session-2",
        title: "Other",
        preview: "Nothing relevant",
        cwd: null,
        models: ["o3"],
        toolCounts: {},
        hasMedia: true,
      }),
      summary({
        id: "session-3",
        title: "Other",
        preview: "Viewer from preview",
        cwd: "D:/other",
        models: ["gpt-5"],
        toolCounts: { web_search: 1 },
      }),
      summary({
        id: "session-4",
        title: "Other",
        preview: "No match",
        cwd: "C:/repo/viewer",
        models: ["gpt-5"],
        toolCounts: { exec_command: 1 },
        hasMedia: true,
      }),
    ];
    const repository = new StaticConversationRepository(async () => ({ version: 1, sessions }));

    await expect(repository.listSessions({ scope: "archived" })).resolves.toMatchObject({
      total: 0,
    });
    await expect(
      repository.listSessions({ scope: "active", query: "   ", cursor: "invalid", limit: 2 }),
    ).resolves.toMatchObject({
      total: 4,
      items: [{ summary: { id: "session-1" } }, { summary: { id: "session-2" } }],
      nextCursor: "2",
    });
    await expect(
      repository.listSessions({ scope: "active", query: "viewer", model: "gpt-5", limit: 50 }),
    ).resolves.toMatchObject({ total: 3 });
    await expect(
      repository.listSessions({
        scope: "active",
        cwd: "C:/repo/viewer",
        tool: "exec_command",
        hasMedia: false,
      }),
    ).resolves.toMatchObject({ total: 1, items: [{ summary: { id: "session-1" } }] });
    await expect(
      repository.listSessions({ scope: "active", cwd: "C:/repo/viewer", tool: "missing" }),
    ).resolves.toMatchObject({ total: 0 });
    await expect(
      repository.listSessions({ scope: "active", hasMedia: true }),
    ).resolves.toMatchObject({ total: 2 });
  });

  it("maps Pagefind results to exact turn hits with the selected-scope filters", async () => {
    const search = vi.fn<PagefindBrowserApi["search"]>(async () => ({
      results: [
        {
          score: 0.92,
          data: async () => ({
            excerpt: "The <mark>viewer</mark> keeps Codex inputs read-only.",
            meta: {
              title: "Build the viewer — Turn 3",
              sessionId: "session-1",
              turnId: "turn-3",
            },
          }),
        },
      ],
    }));
    const repository = new StaticConversationRepository(
      async () => ({ version: 1, sessions: [summary()] }),
      async () => ({ search }),
    );

    const result = await repository.search({
      scope: "active",
      query: "viewer",
      model: "gpt-5",
      hasMedia: false,
    });

    expect(search).toHaveBeenCalledWith("viewer", {
      filters: { scope: "active", model: "gpt-5", media: "false" },
    });
    expect(result).toEqual({
      total: 1,
      nextCursor: null,
      items: [
        {
          sessionId: "session-1",
          turnId: "turn-3",
          messageId: null,
          scope: "active",
          title: "Build the viewer — Turn 3",
          excerpt: "The <mark>viewer</mark> keeps Codex inputs read-only.",
          score: 0.92,
        },
      ],
    });
  });

  it("drops malformed Pagefind records, normalizes optional values, and paginates hits", async () => {
    const result = (meta: unknown, excerpt: unknown, score: unknown) => ({
      score,
      data: async () => ({ meta, excerpt }),
    });
    const search = vi.fn<PagefindBrowserApi["search"]>(async () => ({
      results: [
        result(null, "ignored", 1),
        result({ sessionId: "session-1", turnId: 3, title: "Invalid" }, "ignored", 1),
        result(
          { sessionId: "session-1", turnId: "turn-1", title: "Invalid", messageId: "" },
          "ignored",
          1,
        ),
        result({ sessionId: "session-1", turnId: "turn-1", title: "First" }, 42, -1),
        result(
          { sessionId: "session-2", turnId: "turn-2", title: "Second", messageId: "message-2" },
          "match",
          0.5,
        ),
      ],
    }));
    const repository = new StaticConversationRepository(
      async () => ({ version: 1, sessions: [] }),
      async () => ({ search }),
    );

    await expect(
      repository.search({ scope: "archived", query: "match", cursor: "0", limit: 3 }),
    ).resolves.toEqual({ total: 5, nextCursor: "3", items: [] });
    await expect(
      repository.search({
        scope: "archived",
        query: "match",
        cursor: "3",
        limit: 2,
        cwd: "C:\\repo",
        tool: "exec_command",
        hasMedia: true,
      }),
    ).resolves.toEqual({
      total: 5,
      nextCursor: null,
      items: [
        {
          sessionId: "session-1",
          turnId: "turn-1",
          messageId: null,
          scope: "archived",
          title: "First",
          excerpt: "",
          score: 0,
        },
        {
          sessionId: "session-2",
          turnId: "turn-2",
          messageId: "message-2",
          scope: "archived",
          title: "Second",
          excerpt: "match",
          score: 0.5,
        },
      ],
    });
    expect(search).toHaveBeenCalledWith("match", {
      filters: { scope: "archived", cwd: "C%3A%5Crepo", tool: "exec_command", media: "true" },
    });
  });

  it("hydrates only the selected Pagefind result page", async () => {
    const data = Array.from({ length: 1_000 }, (_, index) =>
      vi.fn(async () => ({
        meta: { sessionId: "session-1", turnId: `turn-${index}`, title: `Turn ${index}` },
        excerpt: "match",
      })),
    );
    const repository = new StaticConversationRepository(
      async () => ({ version: 1, sessions: [] }),
      async () => ({
        search: async () => ({ results: data.map((load) => ({ score: 1, data: load })) }),
      }),
    );

    const page = await repository.search({
      scope: "active",
      query: "match",
      cursor: "500",
      limit: 50,
    });
    expect(page).toMatchObject({ total: 1_000, nextCursor: "550" });
    expect(page.items).toHaveLength(50);
    expect(page.items[0]).toMatchObject({ turnId: "turn-500" });
    expect(data.reduce((count, load) => count + load.mock.calls.length, 0)).toBe(50);
    expect(data[499]).not.toHaveBeenCalled();
    expect(data[550]).not.toHaveBeenCalled();
  });

  it("loads static summaries, navigators, chunks, inspectors, and asset manifests", async () => {
    const navigator = {
      version: 2 as const,
      sessionId: "session-1",
      revision: "revision-1",
      chunkSize: 2,
      chunkCount: 8,
      items: [
        {
          turnId: "turn-0",
          index: 0,
          userMessageId: null,
          promptPreview: "",
          assistantPreview: "",
          proseLengthBucket: 1,
          createdAt: null,
        },
        {
          turnId: "turn-3",
          index: 3,
          userMessageId: null,
          promptPreview: "",
          assistantPreview: "",
          proseLengthBucket: 1,
          createdAt: null,
        },
      ],
      turnChunks: { "turn-0": 0, "turn-3": 7 },
      inspectorChunks: { "message:message-1": 0, "turn:turn-3": 1 },
    };
    const messageRecord = inspector({ type: "message", id: "message-1" });
    const turnRecord = inspector({ type: "turn", id: "turn-3" });
    const asset: ResolvedAsset = {
      id: "asset-1",
      url: "/assets/asset-1.png",
      mimeType: "image/png",
      byteSize: 1,
      sha256: "a".repeat(64),
      width: 1,
      height: 1,
      status: "available",
      originalPath: "diagram.png",
    };
    const paths: string[] = [];
    const repository = new StaticConversationRepository(async (path) => {
      paths.push(path);
      if (path.endsWith("summary.json")) {
        return { summary: summary() };
      }
      if (path.endsWith("navigator.json")) {
        return navigator;
      }
      if (path.endsWith("turn-1.json") || path.endsWith("turn-7.json")) {
        return turnChunk();
      }
      if (path.endsWith("inspector-0.json")) {
        return inspectorChunk([messageRecord]);
      }
      if (path.endsWith("inspector-1.json")) {
        return inspectorChunk([turnRecord]);
      }
      if (/inspector-[2-7]\.json$/u.test(path)) {
        return inspectorChunk([]);
      }
      if (path === "/payloads/assets.json") {
        return { assets: [asset] };
      }
      throw new Error(`Unexpected path ${path}`);
    });

    await expect(repository.getSession("session/1")).resolves.toMatchObject({ id: "session-1" });
    await expect(repository.getTurnNavigator("session-1")).resolves.toHaveLength(2);
    await expect(repository.getTurns("session-1", { targetTurnId: "turn-3" })).resolves.toEqual(
      turnChunk(),
    );
    await expect(repository.getTurns("session-1", { cursor: "7" })).resolves.toEqual(turnChunk());
    await expect(
      repository.getInspector("session-1", { type: "turn", id: "turn-3" }),
    ).resolves.toEqual(turnRecord);
    await expect(
      repository.getInspector("session-1", { type: "message", id: "message-1" }),
    ).resolves.toEqual(messageRecord);
    await expect(
      repository.getInspector("session-1", { type: "activity", id: "missing" }),
    ).rejects.toThrow("not found");
    await expect(repository.resolveAsset("asset-1")).resolves.toEqual(asset);
    await expect(repository.resolveAsset("missing")).rejects.toThrow("Asset not found");
    expect(paths).toContain("/payloads/sessions/session%2F1/summary.json");
    expect(paths).toContain("/payloads/sessions/session-1/turn-7.json");
    expect(repository.subscribe(() => undefined)()).toBeUndefined();
  });

  it("loads and indexes one static asset manifest for concurrent and sequential lookups", async () => {
    const first: ResolvedAsset = {
      id: "asset-1",
      url: "/assets/asset-1.png",
      mimeType: "image/png",
      byteSize: 1,
      sha256: "a".repeat(64),
      width: 1,
      height: 1,
      status: "available",
      originalPath: "first.png",
    };
    const second: ResolvedAsset = {
      ...first,
      id: "asset-2",
      url: "/assets/asset-2.png",
      sha256: "b".repeat(64),
      originalPath: "second.png",
    };
    let resolveManifest!: (value: unknown) => void;
    const request = vi.fn<RepositoryRequester>(
      () =>
        new Promise((resolve) => {
          resolveManifest = resolve;
        }),
    );
    const repository = new StaticConversationRepository(request);

    const firstPending = repository.resolveAsset(first.id);
    const secondPending = repository.resolveAsset(second.id);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("/payloads/assets.json");
    resolveManifest({ assets: [first, second] });
    await expect(Promise.all([firstPending, secondPending])).resolves.toEqual([first, second]);
    await expect(repository.resolveAsset(second.id)).resolves.toEqual(second);
    await expect(repository.resolveAsset("missing")).rejects.toThrow("Asset not found");
    expect(request).toHaveBeenCalledOnce();
  });

  it("retries a rejected static asset manifest and rejects duplicate IDs deterministically", async () => {
    const asset: ResolvedAsset = {
      id: "asset-1",
      url: "/assets/asset-1.png",
      mimeType: "image/png",
      byteSize: 1,
      sha256: "a".repeat(64),
      width: 1,
      height: 1,
      status: "available",
      originalPath: "asset.png",
    };
    const retryingRequest = vi
      .fn<RepositoryRequester>()
      .mockRejectedValueOnce(new Error("Transient manifest failure"))
      .mockResolvedValueOnce({ assets: [asset] });
    const retryingRepository = new StaticConversationRepository(retryingRequest);

    await expect(retryingRepository.resolveAsset(asset.id)).rejects.toThrow(
      "Transient manifest failure",
    );
    await expect(retryingRepository.resolveAsset(asset.id)).resolves.toEqual(asset);
    expect(retryingRequest).toHaveBeenCalledTimes(2);

    const duplicateRepository = new StaticConversationRepository(async () => ({
      assets: [asset, { ...asset, url: "/assets/duplicate.png" }],
    }));
    await expect(duplicateRepository.resolveAsset(asset.id)).rejects.toThrow(
      "duplicate static asset ID",
    );
  });

  it("rejects a superseded Pagefind result after the search completes", async () => {
    let resolveSearch!: (response: PagefindSearchResponse) => void;
    const search = vi.fn<PagefindBrowserApi["search"]>(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const repository = new StaticConversationRepository(
      async () => ({ version: 1, sessions: [summary()] }),
      async () => ({ search }),
    );
    const controller = new AbortController();
    const pending = repository.search(
      { scope: "active", query: "viewer" },
      { signal: controller.signal },
    );

    await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
    controller.abort();
    resolveSearch({ results: [] });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("retries a static index request after a transient cached failure", async () => {
    const request = vi
      .fn<RepositoryRequester>()
      .mockRejectedValueOnce(new Error("Transient fixture failure"))
      .mockResolvedValue({ version: 1, sessions: [summary()] });
    const repository = new StaticConversationRepository(request, async () => ({
      search: vi.fn<PagefindBrowserApi["search"]>(async () => ({ results: [] })),
    }));

    await expect(repository.listSessions({ scope: "active" })).rejects.toThrow(
      "Transient fixture failure",
    );
    await expect(repository.listSessions({ scope: "active" })).resolves.toMatchObject({
      total: 1,
      items: [{ summary: { id: "session-1" } }],
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("passes cancellation to live requests and selects capabilities by mode", async () => {
    const controller = new AbortController();
    const request = vi.fn<RepositoryRequester>(async () => ({
      items: [],
      nextCursor: null,
      total: 0,
    }));
    const live = new LiveApiConversationRepository(request);

    await live.listSessions({ scope: "active" }, { signal: controller.signal });

    expect(request).toHaveBeenCalledWith("/api/sessions?scope=active", {
      signal: controller.signal,
    });
    expect(createConversationRepository("live", request).capabilities().liveUpdates).toBe(true);
    expect(createConversationRepository("static", request).capabilities()).toEqual({
      liveUpdates: false,
      serverSettings: false,
      backgroundFaviconFetch: false,
    });
  });

  it("builds every live API route, parses responses, and ignores malformed invalidations", async () => {
    const listeners = new Map<string, EventListener>();
    const removeEventListener = vi.fn();
    const close = vi.fn();
    class TestEventSource {
      constructor(readonly url: string) {}
      addEventListener(type: string, listener: EventListener): void {
        listeners.set(type, listener);
      }
      removeEventListener = removeEventListener;
      close = close;
    }
    vi.stubGlobal("EventSource", TestEventSource);
    const navigator = [
      {
        turnId: "turn-0",
        index: 0,
        userMessageId: null,
        promptPreview: "",
        assistantPreview: "",
        proseLengthBucket: 1,
        createdAt: null,
      },
    ];
    const asset: ResolvedAsset = {
      id: "asset-1",
      url: null,
      mimeType: null,
      byteSize: null,
      sha256: null,
      width: null,
      height: null,
      status: "missing",
      originalPath: null,
    };
    const request = vi.fn<RepositoryRequester>(async (path) => {
      if (path.startsWith("/api/sessions?")) {
        return {
          items: [
            {
              summary: summary(),
              kind: "root",
              materialization: "ready",
              projectId: "project-1",
              parentThreadId: null,
              agentPath: null,
              agentNickname: null,
              agentDepth: 0,
              childCount: 0,
            },
          ],
          nextCursor: null,
          total: 1,
        };
      }
      if (path === "/api/projects") {
        return [
          {
            id: "project-1",
            name: "viewer",
            hint: "C:/repo/viewer",
            source: "cwd",
            activeCount: 1,
            archivedCount: 0,
          },
        ];
      }
      if (path === "/api/sessions/prepare") {
        return [
          { id: "session-1", state: "ready", error: null },
          { id: "session-2", state: "ready", error: null },
        ];
      }
      if (path === "/api/search/materialize") {
        return {
          id: "search-1",
          scope: "active",
          query: "viewer",
          state: "queued",
          total: 2,
          completed: 0,
          failed: 0,
          resultCount: 0,
          error: null,
          createdAt: "2026-08-16T08:00:00.000Z",
          updatedAt: "2026-08-16T08:00:00.000Z",
        };
      }
      if (path === "/api/search/materialize/search-1") {
        return {
          id: "search-1",
          scope: "active",
          query: "viewer",
          state: "completed",
          total: 2,
          completed: 2,
          failed: 0,
          resultCount: 1,
          error: null,
          createdAt: "2026-08-16T08:00:00.000Z",
          updatedAt: "2026-08-16T08:00:01.000Z",
        };
      }
      if (path.startsWith("/api/search?")) {
        return { items: [], nextCursor: null, total: 0 };
      }
      if (path.endsWith("/navigator")) {
        return navigator;
      }
      if (path.includes("/turns?")) {
        return turnChunk();
      }
      if (path.includes("/inspector?")) {
        return inspector({ type: "turn", id: "turn-1" });
      }
      if (path.startsWith("/api/assets/")) {
        return asset;
      }
      return summary();
    });
    const repository = new LiveApiConversationRepository(request);

    await repository.listSessions({ scope: "active", limit: 2, hasMedia: false });
    await expect(repository.listProjects()).resolves.toHaveLength(1);
    await expect(
      repository.prepareSessions(["session-1", "session-2", "session-1"]),
    ).resolves.toHaveLength(2);
    const searchJob = await repository.startDeepSearch({ scope: "active", query: "viewer" });
    await expect(repository.getDeepSearch(searchJob.id)).resolves.toMatchObject({
      state: "completed",
    });
    await repository.cancelDeepSearch(searchJob.id);
    await repository.search({ scope: "active", query: "viewer", model: "gpt-5" });
    await repository.getSession("session/1");
    await expect(repository.getTurnNavigator("session-1")).resolves.toEqual(navigator);
    await repository.getTurns("session-1", { cursor: "2", direction: "before", limit: 20 });
    await repository.getInspector("session-1", { type: "turn", id: "turn-1" });
    await expect(repository.resolveAsset("asset/1")).resolves.toEqual(asset);
    expect(request.mock.calls.map(([path]) => path)).toEqual(
      expect.arrayContaining([
        "/api/sessions?scope=active&limit=2&hasMedia=false",
        "/api/projects",
        "/api/sessions/prepare",
        "/api/search/materialize",
        "/api/search/materialize/search-1",
        "/api/search?scope=active&query=viewer&model=gpt-5",
        "/api/sessions/session%2F1",
        "/api/sessions/session-1/navigator",
        "/api/sessions/session-1/turns?cursor=2&direction=before&limit=20",
        "/api/sessions/session-1/inspector?type=turn&id=turn-1",
        "/api/assets/asset%2F1",
      ]),
    );

    const received = vi.fn();
    const unsubscribe = repository.subscribe(received);
    listeners.get("library.updated")?.(
      new MessageEvent("library.updated", {
        data: JSON.stringify({ type: "library.updated", ids: [], revision: "r2" }),
      }),
    );
    listeners.get("session.updated")?.(new MessageEvent("session.updated", { data: "{" }));
    listeners.get("settings.updated")?.(new Event("settings.updated"));
    listeners.get("search.updated")?.(
      new MessageEvent("search.updated", {
        data: JSON.stringify({ type: "search.updated", ids: ["search-1"], revision: "r3" }),
      }),
    );
    listeners.get("diagnostic.updated")?.(
      new MessageEvent("diagnostic.updated", {
        data: JSON.stringify({ type: "wrong", ids: [], revision: "r2" }),
      }),
    );
    expect(received).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(removeEventListener).toHaveBeenCalledTimes(listeners.size);
    expect(removeEventListener).toHaveBeenCalledWith("favicon.updated", expect.any(Function));
    expect(close).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("returns a no-op subscription when EventSource is unavailable", () => {
    vi.stubGlobal("EventSource", undefined);
    const repository = new LiveApiConversationRepository(async () => ({}));
    expect(repository.subscribe(() => undefined)()).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("resolves cached favicon URLs without contacting external origins", async () => {
    const staticRequest = vi.fn<RepositoryRequester>(async (path) => {
      expect(path).toBe("/payloads/favicons.json");
      return {
        version: 1,
        favicons: [
          {
            origin: "https://nuxt.com",
            url: "/favicons/nuxt.png",
            sourceUrl: "https://nuxt.com/favicon.ico",
            mimeType: "image/png",
            byteSize: 68,
            sha256: "a".repeat(64),
          },
        ],
      };
    });
    const staticRepository = new StaticConversationRepository(staticRequest);
    const liveRequest = vi.fn<RepositoryRequester>();
    const liveRepository = new LiveApiConversationRepository(liveRequest);

    await expect(staticRepository.resolveFavicon("https://nuxt.com")).resolves.toBe(
      "/favicons/nuxt.png",
    );
    await expect(staticRepository.resolveFavicon("https://missing.example")).resolves.toBeNull();
    expect(staticRequest).toHaveBeenCalledOnce();
    await expect(liveRepository.resolveFavicon("https://nuxt.com")).resolves.toBe(
      "/api/favicons/aHR0cHM6Ly9udXh0LmNvbQ",
    );
    expect(liveRequest).not.toHaveBeenCalled();
  });
});
