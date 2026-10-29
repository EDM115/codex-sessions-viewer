import type { JsonObject } from "../../../shared/types/conversation.ts";

/** Source-shaped parent notifications from pinned app-server envelopes, not projection items */
export function parentReviewRecords(threadId = "stable"): JsonObject[] {
  const event = (payload: JsonObject): JsonObject => ({ type: "event_msg", payload });
  const notification = (method: string, params: JsonObject): JsonObject => ({ method, params });
  const base = {
    threadId,
    turnId: "turn",
    targetItemId: "command",
    startedAtMs: 1000,
    action: {
      type: "command",
      source: "unifiedExec",
      command: ["node", "job.js"],
      cwd: "/project",
    },
  };
  return [
    {
      type: "session_meta",
      payload: {
        id: threadId,
        source: "cli",
        thread_source: "user",
        timestamp: "2026-01-01T00:00:00Z",
      },
    },
    event({ type: "task_started", turn_id: "turn" }),
    event({
      type: "item_completed",
      turn_id: "turn",
      item: {
        type: "UserMessage",
        id: "user",
        content: [{ type: "text", text: "Run the requested operation" }],
      },
    }),
    event({
      type: "item_completed",
      turn_id: "turn",
      item: {
        type: "CommandExecution",
        id: "command",
        command: ["node", "job.js"],
        cwd: "/project",
        parsed_cmd: [],
        source: "agent",
        status: "completed",
        exit_code: 0,
        aggregated_output: "done",
      },
    }),
    event({
      type: "item_completed",
      turn_id: "turn",
      item: {
        type: "McpToolCall",
        id: "mcp",
        server: "service",
        tool: "delete",
        arguments: {},
        status: "failed",
        error: { message: "denied" },
      },
    }),
    notification("item/autoApprovalReview/started", {
      ...base,
      reviewId: "review-a",
      review: { status: "inProgress", riskLevel: null, userAuthorization: null, rationale: null },
    }),
    notification("item/autoApprovalReview/completed", {
      ...base,
      reviewId: "review-a",
      completedAtMs: 2000,
      decisionSource: "agent",
      review: {
        status: "approved",
        riskLevel: "low",
        userAuthorization: "high",
        rationale: "Requested operation",
      },
    }),
    notification("item/autoApprovalReview/started", {
      ...base,
      reviewId: "review-b",
      startedAtMs: 3000,
      review: { status: "inProgress" },
    }),
    notification("item/autoApprovalReview/completed", {
      ...base,
      reviewId: "network",
      targetItemId: null,
      completedAtMs: 4000,
      decisionSource: "agent",
      action: {
        type: "networkAccess",
        target: "example.test",
        host: "example.test",
        protocol: "https",
        port: 443,
      },
      review: { status: "denied" },
    }),
    notification("item/autoApprovalReview/completed", {
      ...base,
      reviewId: "mcp-denied",
      targetItemId: "mcp",
      completedAtMs: 5000,
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
    }),
    event({
      type: "item_completed",
      turn_id: "turn",
      item: {
        type: "AgentMessage",
        id: "answer",
        content: [{ type: "Text", text: "Done" }],
        phase: "final_answer",
      },
    }),
    event({ type: "task_complete", turn_id: "turn" }),
  ];
}

/** Same-owner reviews before and after the real display cutoff */
export function cutoffReviewRecords(threadId = "stable"): JsonObject[] {
  const records = parentReviewRecords(threadId);
  records[0] = {
    type: "session_meta",
    payload: {
      id: threadId,
      session_id: "root",
      source: "cli",
      thread_source: "user",
      subagent_history_start_ordinal: 10,
      timestamp: "2026-01-01T00:00:00Z",
    },
  };
  const event = (payload: JsonObject): JsonObject => ({ type: "event_msg", payload });
  const action = {
    type: "command",
    source: "unifiedExec",
    command: ["node", "visible.js"],
    cwd: "/project",
  };
  records.push(
    event({ type: "task_started", turn_id: "visible-turn" }),
    event({
      type: "item_completed",
      turn_id: "visible-turn",
      item: {
        type: "UserMessage",
        id: "visible-user",
        content: [{ type: "text", text: "Visible request" }],
      },
    }),
    event({
      type: "item_completed",
      turn_id: "visible-turn",
      item: {
        type: "CommandExecution",
        id: "visible-command",
        command: ["node", "visible.js"],
        cwd: "/project",
        parsed_cmd: [],
        status: "completed",
        exit_code: 0,
      },
    }),
    {
      method: "item/autoApprovalReview/started",
      params: {
        threadId,
        turnId: "visible-turn",
        reviewId: "visible-review",
        targetItemId: "visible-command",
        startedAtMs: 6000,
        action,
        review: { status: "inProgress" },
      },
    },
    {
      method: "item/autoApprovalReview/completed",
      params: {
        threadId,
        turnId: "visible-turn",
        reviewId: "visible-review",
        targetItemId: "visible-command",
        startedAtMs: 6000,
        completedAtMs: 7000,
        action,
        review: { status: "approved" },
      },
    },
    event({ type: "task_complete", turn_id: "visible-turn" }),
  );
  return records;
}
