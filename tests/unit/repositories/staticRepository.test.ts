import { describe, expect, it, vi } from "vitest";

import { conversationSummarySchema } from "#shared/types/conversation.ts";
import { threadClassificationSchema } from "#shared/types/library.ts";
import { StaticConversationRepository } from "~/repositories/static.ts";

describe("static conversation repository", () => {
  it.each([true, false])(
    "reveals children across inherited filters and qualifies their project only when its definition exists (%s)",
    async (projectExists) => {
      const summary = conversationSummarySchema.parse({
        id: "child",
        title: "Child",
        scope: "archived",
        sourcePath: "D:/child.jsonl",
        createdAt: "2026-09-14T10:00:00.000Z",
        updatedAt: "2026-09-14T10:00:00.000Z",
        cwd: "D:/child",
        gitBranch: null,
        gitSha: null,
        gitOriginUrl: null,
        models: [],
        reasoningEfforts: [],
        turnCount: 0,
        assistantMessageCount: 0,
        toolCallCount: 0,
        toolCounts: {},
        preview: "Child",
        pinned: false,
        sectionName: null,
        parentThreadId: "parent",
        childThreadIds: [],
        hasMedia: false,
        diagnosticCount: 0,
        revision: "child-rev",
      });
      const repository = new StaticConversationRepository(async (path) =>
        path.endsWith("index.json")
          ? { version: 1, sessions: [summary] }
          : {
              version: 1,
              projects: projectExists
                ? [
                    {
                      id: "actual-child-project",
                      name: "Child project",
                      source: "codex",
                      hint: "D:/child",
                      activeCount: 0,
                      archivedCount: 1,
                    },
                  ]
                : [],
              entries: {
                child: {
                  kind: "subagent",
                  ...(projectExists
                    ? {
                        classification: threadClassificationSchema.parse({
                          visibility: "delegated-child",
                          transportSource: null,
                          threadSource: null,
                          ephemeral: null,
                          historyMode: null,
                          relationship: "spawn",
                          parentThreadId: "parent",
                          attachedParentThreadId: null,
                          agentPath: "/root/child",
                          agentNickname: "Child",
                          agentRole: "reviewer",
                          agentDepth: 1,
                          reasons: [],
                        }),
                      }
                    : {}),
                  projectId: "actual-child-project",
                  parentThreadId: "parent",
                  agentPath: "/root/child",
                  agentNickname: "Child",
                  agentDepth: 1,
                  childCount: 0,
                },
              },
            },
      );
      const page = await repository.listSessions({
        scope: "active",
        parentThreadId: "parent",
        projectId: "parent-project",
        query: "parent-only",
        cwd: "C:/parent",
        model: "parent-model",
        tool: "parent-tool",
        hasMedia: true,
      });
      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        projectId: projectExists ? "actual-child-project" : null,
        id: "child",
        scope: "archived",
        parentThreadId: "parent",
      });
      expect(page.items[0]).not.toHaveProperty("summary");
      expect(page.items[0]?.agent).toEqual({
        name: "Child",
        path: "/root/child",
        role: projectExists ? "reviewer" : null,
      });
      expect(page.items[0]).not.toHaveProperty("status");
      expect(
        (await repository.listProjects()).some((project) => project.id === "actual-child-project"),
      ).toBe(projectExists);
      expect(
        (await repository.listSessions({ scope: "archived", parentThreadId: "__root__" })).total,
      ).toBe(0);
    },
  );

  it("preserves the exact message destination emitted by the Pagefind record", async () => {
    const repository = new StaticConversationRepository(
      async () => {
        throw new Error("Static payloads are not needed for this search.");
      },
      async () => ({
        async search() {
          return {
            results: [
              {
                score: 0.75,
                async data() {
                  return {
                    excerpt: "Handle <mark>cancellation</mark>",
                    meta: {
                      title: "Build the parser",
                      sessionId: "11111111-1111-4111-8111-111111111111",
                      parentThreadId: "parent-thread",
                      turnId: "turn-2",
                      messageId: "message-raw-882",
                    },
                  };
                },
              },
            ],
          };
        },
      }),
    );

    await expect(repository.search({ scope: "active", query: "cancellation" })).resolves.toEqual({
      items: [
        {
          sessionId: "11111111-1111-4111-8111-111111111111",
          parentThreadId: "parent-thread",
          turnId: "turn-2",
          messageId: "message-raw-882",
          scope: "active",
          title: "Build the parser",
          excerpt: "Handle <mark>cancellation</mark>",
          score: 0.75,
        },
      ],
      nextCursor: null,
      total: 1,
    });
  });

  it("uses the navigator target index to fetch only the owning inspector chunk", async () => {
    const record = {
      sessionId: "session-1",
      target: { type: "message", id: "message-last" },
      models: [],
      reasoningEfforts: [],
      phase: "final",
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
    } as const;
    const requester = vi.fn<(path: string) => Promise<unknown>>(async (path) => {
      if (path.endsWith("navigator.json")) {
        return {
          version: 2,
          sessionId: "session-1",
          revision: "revision-1",
          chunkSize: 1,
          chunkCount: 3,
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
              turnId: "turn-1",
              index: 1,
              userMessageId: null,
              promptPreview: "",
              assistantPreview: "",
              proseLengthBucket: 1,
              createdAt: null,
            },
            {
              turnId: "turn-2",
              index: 2,
              userMessageId: null,
              promptPreview: "",
              assistantPreview: "",
              proseLengthBucket: 1,
              createdAt: null,
            },
          ],
          turnChunks: { "turn-0": 0, "turn-1": 1, "turn-2": 2 },
          inspectorChunks: { "message:message-last": 2 },
        };
      }
      if (path.endsWith("inspector-2.json")) {
        const { rawRecords: _rawRecords, ...compact } = record;
        return {
          version: 2,
          sessionId: "session-1",
          revision: "revision-1",
          records: [compact],
          rawRecords: {},
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const repository = new StaticConversationRepository(requester);

    await expect(
      repository.getInspector("session-1", { type: "message", id: "message-last" }),
    ).resolves.toEqual(record);
    expect(requester.mock.calls.map(([path]) => path)).toEqual([
      "/payloads/sessions/session-1/navigator.json",
      "/payloads/sessions/session-1/inspector-2.json",
    ]);
  });
});
