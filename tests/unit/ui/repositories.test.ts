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

describe("conversation repository adapters", () => {
  it("rejects an absent exact-turn target consistently in static and live modes", async () => {
    const staticRequest = vi.fn<RepositoryRequester>(async (path) => {
      if (path.endsWith("/navigator.json")) {
        return {
          sessionId: "session-1",
          revision: "revision-1",
          chunkSize: 20,
          items: [],
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

    expect(first).toMatchObject({ total: 2, nextCursor: "1", items: [{ id: "session-1" }] });
    expect(second).toMatchObject({ total: 2, nextCursor: null, items: [{ id: "session-3" }] });
    expect(sessions).toHaveLength(3);
    expect(request).toHaveBeenCalledTimes(1);
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
      items: [{ id: "session-1" }],
    });
    expect(request).toHaveBeenCalledTimes(2);
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

  it("resolves cached favicon URLs without contacting external origins", async () => {
    const staticRequest = vi.fn<RepositoryRequester>(async (path) => {
      expect(path).toBe("/payloads/favicons.json");
      return {
        version: 1,
        favicons: [{ origin: "https://nuxt.com", url: "/favicons/nuxt.png" }],
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
