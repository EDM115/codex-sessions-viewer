import { describe, expect, it } from "vitest";
import {
  conversationSummarySchema,
  sourceFingerprintSchema,
} from "../../../shared/types/conversation";
import {
  repositoryCapabilitiesForMode,
  turnNavigatorResponseSchema,
  viewerInvalidationSchema,
} from "../../../shared/types/repository";

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
    const summary = {
      id: "019ff624-c8b9-7212-96cf-d68fc58ff082",
      title: "Continue with Task 2",
      scope: "active",
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

    expect(conversationSummarySchema.parse(summary)).toEqual(summary);
    expect(
      conversationSummarySchema.safeParse({ ...summary, turnCount: -1 })
        .success,
    ).toBe(false);
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
    expect(
      turnNavigatorResponseSchema.safeParse([{ ...item, proseLengthBucket: 5 }])
        .success,
    ).toBe(false);
  });
});
