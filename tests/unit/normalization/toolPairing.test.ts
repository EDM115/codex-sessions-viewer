import { describe, expect, it } from "vitest";

import {
  parseCodexEvent,
  type CodexEvent,
  type TurnScopedEvent,
} from "../../../server/normalization/eventSchema.ts";
import { pairToolCalls } from "../../../server/normalization/toolPairing.ts";
import { jsonValueSchema } from "../../../shared/types/conversation.ts";

function event(
  lineNumber: number,
  timestamp: string,
  payload: Record<string, unknown>,
): CodexEvent {
  const value = jsonValueSchema.parse({ timestamp, type: "response_item", payload });
  const parsed = parseCodexEvent({
    lineNumber,
    byteStart: lineNumber * 100,
    byteEnd: lineNumber * 100 + 99,
    raw: JSON.stringify(value),
    value,
  });
  if (!parsed.success) {
    throw new Error("Expected tool fixture to parse");
  }
  return parsed.event;
}

function scoped(...events: CodexEvent[]): TurnScopedEvent[] {
  return events.map((item) => ({ event: item, turnId: "turn-1" }));
}

describe("tool call pairing", () => {
  it("pairs function calls and outputs by call ID while preserving namespace and name", () => {
    const result = pairToolCalls(
      scoped(
        event(1, "2026-01-01T10:00:00.000Z", {
          type: "function_call",
          call_id: "call-1",
          namespace: "filesystem",
          name: "read_file",
          arguments: '{"path":"C:\\\\work\\\\file.ts"}',
        }),
        event(2, "2026-01-01T10:00:00.250Z", {
          type: "function_call_output",
          call_id: "call-1",
          output: '{"content":"ok"}',
        }),
      ),
    );

    expect(result.activities).toEqual([
      {
        id: "tool-call-1",
        turnId: "turn-1",
        createdAt: "2026-01-01T10:00:00.000Z",
        rawEventIds: ["raw-100", "raw-200"],
        kind: "tool",
        namespace: "filesystem",
        name: "read_file",
        callId: "call-1",
        status: "succeeded",
        startedAt: "2026-01-01T10:00:00.000Z",
        completedAt: "2026-01-01T10:00:00.250Z",
        durationMs: 250,
        input: { path: "C:\\work\\file.ts" },
        output: { content: "ok" },
        error: null,
      },
    ]);
    expect(result.consumedEventIds).toEqual(["raw-100", "raw-200"]);
  });

  it("keeps a call without an output and marks unknown status and duration", () => {
    const result = pairToolCalls(
      scoped(
        event(1, "2026-01-01T10:00:00.000Z", {
          type: "custom_tool_call",
          call_id: "call-missing",
          name: "exec",
          input: "console.log('hello')",
        }),
      ),
    );

    expect(result.activities[0]).toMatchObject({
      namespace: null,
      name: "exec",
      callId: "call-missing",
      status: "unknown",
      durationMs: null,
      input: "console.log('hello')",
      output: null,
    });
  });

  it("pairs custom tool call output records without assuming a namespace", () => {
    const result = pairToolCalls(
      scoped(
        event(1, "2026-01-01T10:00:00.000Z", {
          type: "custom_tool_call",
          call_id: "custom-1",
          name: "exec",
          input: "pnpm test",
        }),
        event(2, "2026-01-01T10:00:00.500Z", {
          type: "custom_tool_call_output",
          call_id: "custom-1",
          output: "passed",
          status: "completed",
        }),
      ),
    );

    expect(result.activities[0]).toMatchObject({
      namespace: null,
      name: "exec",
      callId: "custom-1",
      status: "succeeded",
      input: "pnpm test",
      output: "passed",
      durationMs: 500,
    });
  });

  it("normalizes standalone MCP completion metrics and an explicit error result", () => {
    const value = jsonValueSchema.parse({
      timestamp: "2026-01-01T10:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        call_id: "mcp-1",
        duration: { secs: 1, nanos: 500_000_000 },
        invocation: { server: "github", tool: "search_code", arguments: { query: "viewer" } },
        result: { Err: { message: "request failed" } },
      },
    });
    const parsed = parseCodexEvent({
      lineNumber: 3,
      byteStart: 300,
      byteEnd: 399,
      raw: JSON.stringify(value),
      value,
    });
    if (!parsed.success) {
      throw new Error("Expected MCP fixture to parse");
    }

    const result = pairToolCalls(scoped(parsed.event));

    expect(result.activities).toEqual([
      expect.objectContaining({
        namespace: "github",
        name: "search_code",
        callId: "mcp-1",
        status: "failed",
        completedAt: "2026-01-01T10:00:02.000Z",
        durationMs: 1500,
        input: { query: "viewer" },
        output: { message: "request failed" },
        error: "request failed",
      }),
    ]);
  });

  it("pairs tool-search records using their explicit status and execution payload", () => {
    const result = pairToolCalls(
      scoped(
        event(1, "2026-01-01T10:00:00.000Z", {
          type: "tool_search_call",
          call_id: "search-1",
          status: "in_progress",
          arguments: { query: "calendar" },
          execution: "client",
        }),
        event(2, "2026-01-01T10:00:00.100Z", {
          type: "tool_search_output",
          call_id: "search-1",
          status: "completed",
          execution: "client",
          tools: [{ name: "calendar.search" }],
        }),
      ),
    );

    expect(result.activities[0]).toMatchObject({
      namespace: "codex",
      name: "tool_search",
      status: "succeeded",
      input: { query: "calendar" },
      output: [{ name: "calendar.search" }],
      durationMs: 100,
    });
  });
});
