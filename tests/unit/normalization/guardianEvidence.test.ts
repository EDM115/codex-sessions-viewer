import { describe, expect, it } from "vitest";

import type { JsonlRecord } from "#server/ingestion/jsonlStream.ts";
import {
  matchGuardianEvidence,
  parseGuardianTurn,
  associateApprovalReviews,
  parseGuardianTurns,
  parseNativeApprovalReview,
  parseParentNativeReviews,
  parentNativeReviewAvailability,
} from "#server/normalization/guardianEvidence.ts";
import { normalizeSession } from "#server/normalization/normalizeSession.ts";
import type { ToolActivity } from "#shared/types/conversation.ts";

import { cutoffReviewRecords } from "../../fixtures/history/parentReviews.ts";

function records(values: JsonlRecord["value"][]): JsonlRecord[] {
  return values.map((value, index) => ({
    lineNumber: index + 1,
    byteStart: index * 100,
    byteEnd: (index + 1) * 100,
    raw: JSON.stringify(value),
    value,
  }));
}

function tool(id: string, input: ToolActivity["input"]): ToolActivity {
  return {
    id,
    turnId: "turn-1",
    createdAt: null,
    rawEventIds: [],
    kind: "tool",
    namespace: null,
    name: "exec_command",
    callId: id,
    status: "succeeded",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    input,
    output: null,
    error: null,
  };
}

describe("guardian approval evidence", () => {
  it("parses the planned action and final allow result without exposing encrypted transcript content", () => {
    const review = parseGuardianTurn(
      records([
        {
          timestamp: "2026-08-16T08:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "guardian-1",
            parent_thread_id: "parent-1",
            source: { subagent: { other: "guardian", parent_thread_id: "parent-1" } },
          },
        },
        {
          timestamp: "2026-08-16T08:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message:
              'Review this command.\nPlanned action JSON:\n{"cmd":"git status","workdir":"C:/repo"}',
          },
        },
        {
          timestamp: "2026-08-16T08:00:02.000Z",
          type: "response_item",
          payload: { type: "reasoning", encrypted_content: "opaque" },
        },
        {
          timestamp: "2026-08-16T08:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "final",
            message:
              '{"risk_level":"low","user_authorization":"requested","outcome":"allow","rationale":"The command is read-only."}',
          },
        },
      ]),
    );

    expect(review).toMatchObject({
      guardianSessionId: "guardian-1",
      parentThreadId: "parent-1",
      reviewedAction: { cmd: "git status", workdir: "C:/repo" },
      outcome: "allow",
      riskLevel: "low",
      rationale: expect.stringContaining("read-only"),
    });
    expect(JSON.stringify(review)).not.toContain("opaque");
  });

  it("matches one exact action, preserves denial, and rejects ambiguous repeated commands", () => {
    const review = {
      reviewedAction: { cmd: "git status", workdir: "C:/repo" },
      outcome: "deny" as const,
      riskLevel: "medium",
      userAuthorization: null,
      rationale: "The command changes state.",
      reviewedAt: null,
      guardianSessionId: "guardian-1",
      parentThreadId: "parent-1",
      rawEventIds: [],
    };
    const exact = tool("tool-a", { workdir: "C:/repo", cmd: "git status" });
    expect(matchGuardianEvidence([exact], [review])).toEqual(new Map());
    const scopedReview = { ...review, toolName: "exec_command", targetTurnId: "turn-1" };
    expect(matchGuardianEvidence([exact], [scopedReview], { sessionId: "parent-1" })).toEqual(
      new Map([["tool-a", expect.objectContaining({ outcome: "deny" })]]),
    );
    expect(
      matchGuardianEvidence(
        [exact, tool("tool-b", { cmd: "git status", workdir: "C:/repo" })],
        [review],
      ),
    ).toEqual(new Map());
    expect(
      parseGuardianTurn(
        records([{ type: "event_msg", payload: { type: "agent_message", message: "{bad" } }]),
      ),
    ).toBeNull();
  });

  it("requires declared session, turn and tool identity for legacy matches", () => {
    const first = tool("first", { cmd: "same" });
    const otherTool = { ...tool("other-tool", first.input), name: "apply_patch" };
    const otherTurn = { ...tool("other-turn", first.input), turnId: "turn-2" };
    const review = {
      reviewedAction: first.input,
      outcome: "deny" as const,
      riskLevel: "low",
      userAuthorization: null,
      rationale: "Denied",
      reviewedAt: null,
      guardianSessionId: "review",
      parentThreadId: "parent",
      targetTurnId: "turn-1",
      toolName: "exec_command",
      rawEventIds: [],
    };
    const result = associateApprovalReviews([first, otherTool, otherTurn], [review], {
      sessionId: "parent",
    });
    expect([...result.matches.keys()]).toEqual(["first"]);
    for (const invalid of [
      { ...review, parentThreadId: "wrong" },
      { ...review, targetTurnId: null },
      { ...review, toolName: null },
    ]) {
      expect(
        associateApprovalReviews([first], [invalid], { sessionId: "parent" }).unattached,
      ).toHaveLength(1);
    }
    expect(
      associateApprovalReviews([first, { ...first, id: "duplicate" }], [review], {
        sessionId: "parent",
      }).unattached[0]?.reason,
    ).toBe("ambiguous-target");
    expect(
      associateApprovalReviews(
        [{ ...first, createdAt: "2026-10-27T12:00:00.000Z" }],
        [{ ...review, reviewedAt: "2026-10-27T11:00:00.000Z" }],
        { sessionId: "parent" },
      ).matches.size,
    ).toBe(0);
  });

  it("prefers exact native identities, keeps attempts and never falls back after a missing target", () => {
    const target = {
      ...tool("tool", { cmd: "same" }),
      nativeItemId: "native-item",
      approvalReviewId: "review-a",
    };
    const base = {
      reviewedAction: null,
      outcome: "deny" as const,
      riskLevel: "low",
      userAuthorization: null,
      rationale: "Denied",
      reviewedAt: null,
      guardianSessionId: null,
      parentThreadId: "parent",
      rawEventIds: [],
      targetItemId: "native-item",
      targetTurnId: "turn-1",
    };
    const reviews = [
      { ...base, reviewId: "review-a", status: "denied" },
      { ...base, reviewId: "review-b", status: "approved", outcome: "allow" as const },
    ];
    if (!reviews[1]) {
      throw new Error("Expected the second review fixture");
    }
    const result = associateApprovalReviews([target], reviews, { sessionId: "parent" });
    expect(result.matches.get("tool")).toEqual(reviews);
    expect(
      associateApprovalReviews(
        [target],
        [{ ...base, targetItemId: "missing", reviewedAction: target.input }],
        { sessionId: "parent" },
      ).unattached,
    ).toHaveLength(1);
    expect(
      associateApprovalReviews(
        [
          target,
          { ...target, id: "different", nativeItemId: "other-item", approvalReviewId: "review-b" },
        ],
        [reviews[1]],
        { sessionId: "parent" },
      ).unattached,
    ).toEqual([{ review: reviews[1], reason: "conflicting-targets" }]);
  });

  it("keeps separate legacy review attempts instead of collapsing the entire helper transcript", () => {
    const values = records([
      { type: "session_meta", payload: { id: "review", parent_thread_id: "parent" } },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          turn_id: "one",
          message: 'Planned action JSON: {"name":"exec_command","arguments":{"cmd":"same"}}',
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: '{"outcome":"deny","risk_level":"low","rationale":"Denied"}',
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          turn_id: "two",
          message: 'Planned action JSON: {"name":"exec_command","arguments":{"cmd":"same"}}',
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: '{"outcome":"allow","risk_level":"low","rationale":"Approved"}',
        },
      },
    ]);
    expect(parseGuardianTurns(values).map((review) => review.outcome)).toEqual(["deny", "allow"]);
  });
  it("retains native pending statuses and validates correlation identities", () => {
    expect(
      parseNativeApprovalReview({
        reviewId: "pending",
        targetItemId: "item",
        parentThreadId: "parent",
        status: "pending",
      }),
    ).toMatchObject({
      reviewId: "pending",
      targetItemId: "item",
      status: "pending",
      outcome: null,
    });
    expect(
      parseNativeApprovalReview({ reviewId: 12, targetItemId: "item", status: "approved" }),
    ).toBeNull();
  });
  it("retains an unfinished legacy review as pending evidence", () => {
    expect(
      parseGuardianTurns(
        records([
          {
            type: "session_meta",
            payload: {
              id: "helper",
              parentThreadId: "parent",
              source: { subAgent: { other: "guardian" } },
            },
          },
          {
            type: "event_msg",
            payload: {
              type: "user_message",
              message: 'Planned action JSON: {"name":"exec_command","arguments":{"cmd":"same"}}',
            },
          },
        ]),
      ),
    ).toEqual([
      expect.objectContaining({ parentThreadId: "parent", outcome: null, status: "pending" }),
    ]);
  });
  it("preserves repeated pending attempts while coalescing a mirrored user envelope", () => {
    const message = 'Planned action JSON: {"name":"exec_command","arguments":{"cmd":"same"}}';
    const attempts = parseGuardianTurns(
      records([
        { type: "event_msg", payload: { type: "user_message", message } },
        { type: "response_item", payload: { type: "message", role: "user", content: message } },
        { type: "event_msg", payload: { type: "user_message", message } },
      ]),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts.map((review) => review.status)).toEqual(["pending", "pending"]);
  });
});

describe("source-shaped app-server approval notifications", () => {
  it("ingests started/completed envelopes as one review, preserves repeated attempts and leaves unknown pending/network targets unattached", () => {
    const base = {
      threadId: "parent",
      turnId: "turn-1",
      startedAtMs: 1000,
      targetItemId: "command",
      action: {
        type: "command",
        source: "unifiedExec",
        command: ["node", "job.js"],
        cwd: "C:/repo",
      },
    };
    const reviews = parseGuardianTurns(
      records([
        {
          method: "item/autoApprovalReview/started",
          params: {
            ...base,
            reviewId: "review-a",
            review: {
              status: "inProgress",
              riskLevel: null,
              userAuthorization: null,
              rationale: null,
            },
          },
        },
        {
          method: "item/autoApprovalReview/completed",
          params: {
            ...base,
            reviewId: "review-a",
            completedAtMs: 2000,
            decisionSource: "agent",
            review: {
              status: "denied",
              riskLevel: "high",
              userAuthorization: "unknown",
              rationale: "not authorized",
            },
          },
        },
        {
          method: "item/autoApprovalReview/started",
          params: { ...base, reviewId: "review-b", review: { status: "inProgress" } },
        },
        {
          method: "item/autoApprovalReview/completed",
          params: {
            ...base,
            reviewId: "network",
            targetItemId: null,
            completedAtMs: 3000,
            decisionSource: "agent",
            action: {
              type: "networkAccess",
              target: "example.test",
              host: "example.test",
              protocol: "https",
              port: 443,
            },
            review: { status: "denied" },
          },
        },
        {
          method: "item/autoApprovalReview/completed",
          params: {
            ...base,
            reviewId: "mcp-denied",
            targetItemId: "missing-mcp",
            completedAtMs: 4000,
            decisionSource: "agent",
            action: {
              type: "mcpToolCall",
              server: "service",
              toolName: "delete",
              connectorId: null,
              connectorName: null,
              toolTitle: null,
            },
            review: { status: "denied" },
          },
        },
      ]),
    );
    expect(reviews).toHaveLength(4);
    expect(reviews[0]).toMatchObject({
      reviewId: "review-a",
      outcome: "deny",
      requestedAt: "1970-01-01T00:00:01.000Z",
      reviewedAt: "1970-01-01T00:00:02.000Z",
    });
    expect(reviews[0]?.rawEventIds).toHaveLength(2);
    expect(reviews[1]).toMatchObject({ reviewId: "review-b", outcome: null, reviewedAt: null });
    const associations = associateApprovalReviews(
      [{ ...tool("render-command", {}), nativeItemId: "command" }],
      reviews,
      { sessionId: "parent" },
    );
    expect(associations.matches.get("render-command")?.map((review) => review.reviewId)).toEqual([
      "review-a",
      "review-b",
    ]);
    expect(
      associations.unattached.map(({ review, reason }) => [
        review.reviewId,
        reason,
        review.outcome,
      ]),
    ).toEqual([
      ["network", "missing-target", "deny"],
      ["mcp-denied", "missing-target", "deny"],
    ]);
  });
});

it("rejects source notifications that reuse a review ID for conflicting native targets", () => {
  const reviews = parseGuardianTurns(
    records(
      ["first", "second"].map((targetItemId) => ({
        method: "item/autoApprovalReview/completed",
        params: {
          threadId: "parent",
          turnId: "turn-1",
          reviewId: "conflict",
          targetItemId,
          startedAtMs: 1000,
          completedAtMs: 2000,
          review: { status: "approved" },
          action: { type: "command", command: ["node"], cwd: "C:/repo" },
        },
      })),
    ),
  );
  const result = associateApprovalReviews([tool("first", {}), tool("second", {})], reviews, {
    sessionId: "parent",
  });
  expect(result.matches.size).toBe(0);
  expect(result.unattached.map(({ reason }) => reason)).toEqual([
    "conflicting-targets",
    "conflicting-targets",
  ]);
});

it("retains denied native MCP reviews as standalone evidence even when their exact target exists", () => {
  const reviews = parseGuardianTurns(
    records([
      {
        method: "item/autoApprovalReview/completed",
        params: {
          threadId: "parent",
          turnId: "turn-1",
          reviewId: "denied-mcp",
          targetItemId: "mcp",
          startedAtMs: 1000,
          completedAtMs: 2000,
          decisionSource: "agent",
          review: { status: "denied" },
          action: {
            type: "mcpToolCall",
            server: "service",
            toolName: "delete",
            connectorId: null,
            connectorName: null,
            toolTitle: null,
          },
        },
      },
    ]),
  );
  const result = associateApprovalReviews(
    [{ ...tool("render-mcp", {}), nativeItemId: "mcp", namespace: "service", name: "delete" }],
    reviews,
    { sessionId: "parent" },
  );
  expect(result.matches.size).toBe(0);
  expect(result.unattached).toMatchObject([
    {
      reason: "standalone-denial",
      review: { reviewId: "denied-mcp", targetItemId: "mcp", outcome: "deny" },
    },
  ]);
});

it("retains context-only native envelopes for inspection without publishing them as selected reviews", () => {
  const source = records(cutoffReviewRecords()).map((record, index) =>
    Object.assign(record, {
      contextOnly: index > 0 && index < 10,
      ordinal: index,
    }),
  );
  const session = normalizeSession({
    records: source,
    sourcePath: "C:/fixture/parent.jsonl",
    scope: "active",
    sessionIndexEntries: [],
    stateSnapshot: null,
  }).session!;
  expect(parseParentNativeReviews(session).map((review) => review.reviewId)).toEqual([
    "visible-review",
  ]);
  expect(
    session.rawEvents
      .filter((event) => event.type.startsWith("native_notification"))
      .map((event) => event.logicalVisibility),
  ).toEqual([
    "context-only",
    "context-only",
    "context-only",
    "context-only",
    "context-only",
    "visible",
    "visible",
  ]);
  expect(session.rawEvents).toHaveLength(source.length);
});

it("keeps review availability unresolved when a required cutoff has no ordinal proof", () => {
  const source = records(cutoffReviewRecords());
  const session = normalizeSession({
    records: source,
    sourcePath: "C:/fixture/parent.jsonl",
    scope: "active",
    sessionIndexEntries: [],
    stateSnapshot: null,
  }).session!;
  expect(parseParentNativeReviews(session)).toEqual([]);
  expect(parentNativeReviewAvailability(session)).toBe("unresolved");
  expect(
    session.rawEvents
      .filter((event) => event.type.startsWith("native_notification"))
      .map((event) => event.logicalVisibility),
  ).toEqual(Array.from({ length: 7 }, () => "unresolved"));
});
