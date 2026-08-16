import { describe, expect, it } from "vitest";

import {
  conversationSummarySchema,
  sourceFingerprintSchema,
} from "../../../shared/types/conversation.ts";
import {
  conversationListItemSchema,
  conversationProjectSchema,
  preparationResultSchema,
} from "../../../shared/types/library.ts";
import {
  repositoryCapabilitiesForMode,
  turnNavigatorResponseSchema,
  viewerInvalidationSchema,
} from "../../../shared/types/repository.ts";

function summary() {
  return {
    id: "019ff624-c8b9-7212-96cf-d68fc58ff082",
    title: "Continue with Task 2",
    scope: "active" as const,
    sourcePath: "/home/dev/.codex/sessions/session.jsonl",
    createdAt: "2026-08-13T08:00:00.000Z",
    updatedAt: "2026-08-13T08:30:00.000Z",
    cwd: "/home/dev/project",
    gitBranch: "main",
    gitSha: null,
    gitOriginUrl: null,
    models: ["gpt-5.6"],
    reasoningEfforts: ["high"],
    turnCount: 2,
    assistantMessageCount: 2,
    toolCallCount: 1,
    toolCounts: { shell_command: 1 },
    preview: "continue with Task 2",
    pinned: false,
    sectionName: null,
    parentThreadId: null,
    childThreadIds: [],
    hasMedia: false,
    diagnosticCount: 0,
    revision: "sha256:revision",
  };
}

describe("persisted conversation contracts", () => {
  it("accepts complete cache records and rejects an invalid fingerprint hash", () => {
    const fingerprint = {
      path: "C:\\Users\\dev\\.codex\\sessions\\session.jsonl",
      size: 1_024,
      mtimeMs: 1_786_550_400_000,
      sha256: "a".repeat(64),
      parsedBytes: 1_024,
      parserVersion: 1,
    };

    expect(sourceFingerprintSchema.parse(fingerprint)).toEqual(fingerprint);
    expect(
      sourceFingerprintSchema.safeParse({
        ...fingerprint,
        sha256: "not-a-sha256",
      }).success,
    ).toBe(false);
  });

  it("validates the conversation-summary API payload", () => {
    const value = summary();

    expect(conversationSummarySchema.parse(value)).toEqual(value);
    expect(conversationSummarySchema.safeParse({ ...value, turnCount: -1 }).success).toBe(false);
  });

  it("validates strict project, list-item, and preparation payloads", () => {
    const item = {
      summary: summary(),
      kind: "subagent" as const,
      materialization: "cold" as const,
      projectId: "codex:repo",
      parentThreadId: "parent-1",
      agentPath: "/root/review",
      agentNickname: "Fermat",
      agentDepth: 1,
      childCount: 0,
    };
    const project = {
      id: "codex:repo",
      name: "Repo",
      source: "codex" as const,
      hint: "C:\\Work\\repo",
      activeCount: 3,
      archivedCount: 1,
    };
    const preparation = { id: item.summary.id, state: "queued" as const, error: null };

    expect(conversationListItemSchema.parse(item)).toEqual(item);
    expect(conversationProjectSchema.parse(project)).toEqual(project);
    expect(preparationResultSchema.parse(preparation)).toEqual(preparation);
    expect(conversationListItemSchema.safeParse({ ...item, kind: "auxiliary" }).success).toBe(
      false,
    );
    expect(
      conversationListItemSchema.safeParse({ ...item, materialization: "warming" }).success,
    ).toBe(false);
    expect(conversationProjectSchema.safeParse({ ...project, activeCount: -1 }).success).toBe(
      false,
    );
  });
});

describe("repository mode contracts", () => {
  it("disables live-only capabilities in the static repository", () => {
    expect(repositoryCapabilitiesForMode("static")).toEqual({
      liveUpdates: false,
      serverSettings: false,
      backgroundFaviconFetch: false,
    });
    expect(repositoryCapabilitiesForMode("live")).toEqual({
      liveUpdates: true,
      serverSettings: true,
      backgroundFaviconFetch: true,
    });
  });

  it("accepts only the approved invalidation event families", () => {
    expect(
      viewerInvalidationSchema.parse({
        type: "session.updated",
        ids: ["session-1"],
        revision: "sha256:revision",
      }),
    ).toEqual({
      type: "session.updated",
      ids: ["session-1"],
      revision: "sha256:revision",
    });
    expect(
      viewerInvalidationSchema.safeParse({
        type: "transcript.updated",
        ids: ["session-1"],
        revision: "entire transcript body",
      }).success,
    ).toBe(false);
    expect(
      viewerInvalidationSchema.parse({
        type: "search.updated",
        ids: ["search-1"],
        revision: "sha256:search",
      }),
    ).toEqual({
      type: "search.updated",
      ids: ["search-1"],
      revision: "sha256:search",
    });
  });

  it("validates turn navigator response buckets", () => {
    const item = {
      turnId: "turn-1",
      index: 0,
      userMessageId: "message-1",
      promptPreview: "continue with Task 2",
      assistantPreview: "I’ll continue with Task 2.",
      proseLengthBucket: 4,
      createdAt: "2026-08-13T08:00:00.000Z",
    };

    expect(turnNavigatorResponseSchema.parse([item])).toEqual([item]);
    expect(turnNavigatorResponseSchema.safeParse([{ ...item, proseLengthBucket: 5 }]).success).toBe(
      false,
    );
  });
});
