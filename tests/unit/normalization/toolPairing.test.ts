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
  type: "event_msg" | "response_item" = "response_item",
): CodexEvent {
  const value = jsonValueSchema.parse({ timestamp, type, payload });
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
  it("pairs overlapping function calls by ID when outputs arrive in reverse order", () => {
    const result = pairToolCalls(
      scoped(
        event(1, "2026-01-01T10:00:00.000Z", {
          type: "function_call",
          call_id: "call-1",
          namespace: "filesystem",
          name: "read_file",
          arguments: '{"path":"C:\\\\work\\\\file.ts"}',
        }),
        event(2, "2026-01-01T10:00:00.050Z", {
          type: "function_call",
          call_id: "call-2",
          namespace: "network",
          name: "fetch",
          arguments: '{"url":"https://example.test/status"}',
        }),
        event(3, "2026-01-01T10:00:00.150Z", {
          type: "function_call_output",
          call_id: "call-2",
          output: '{"status":503}',
        }),
        event(4, "2026-01-01T10:00:00.250Z", {
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
        rawEventIds: ["raw-100", "raw-400"],
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
      expect.objectContaining({
        callId: "call-2",
        namespace: "network",
        name: "fetch",
        rawEventIds: ["raw-200", "raw-300"],
        input: { url: "https://example.test/status" },
        output: { status: 503 },
        durationMs: 100,
      }),
    ]);
    expect(result.consumedEventIds).toEqual(["raw-100", "raw-200", "raw-300", "raw-400"]);
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

  it.each([
    ["completed", "succeeded"],
    ["complete", "succeeded"],
    ["ok", "succeeded"],
    ["success", "succeeded"],
    ["succeeded", "succeeded"],
    ["cancelled", "cancelled"],
    ["canceled", "cancelled"],
    ["aborted", "cancelled"],
    ["failed", "failed"],
    ["error", "failed"],
    ["in_progress", "running"],
    ["running", "running"],
    ["pending", "pending"],
    ["future_status", "unknown"],
  ] as const)("maps the explicit %s tool status", (status, expected) => {
    const result = pairToolCalls(
      scoped(
        event(1, "2026-01-01T10:00:00.000Z", {
          type: "custom_tool_call",
          call_id: `status-${status}`,
          name: "exec",
          input: { command: "test" },
          status,
        }),
      ),
    );

    expect(result.activities[0]?.status).toBe(expected);
  });

  it.each([
    [{ Err: "plain failure" }, "failed", "plain failure"],
    [{ Err: { code: 500 } }, "failed", null],
    [{ Ok: { value: 1 } }, "succeeded", null],
    [{ Ok: { isError: true, error: "reported failure" } }, "failed", "reported failure"],
    [{ Ok: { isError: true } }, "failed", "Tool returned an error"],
    [{ isError: true, error: "bare error" }, "failed", "bare error"],
    [{ isError: true, message: "bare message" }, "failed", "bare message"],
    [{ isError: true }, "failed", "Tool returned an error"],
    [{ value: "ok" }, "succeeded", null],
    ["primitive", "unknown", null],
  ] as const)("normalizes MCP result variant %#", (resultValue, expectedStatus, expectedError) => {
    const result = pairToolCalls(
      scoped(
        event(
          10,
          "2026-01-01T10:00:02.000Z",
          {
            type: "mcp_tool_call_end",
            call_id: `mcp-result-${JSON.stringify(resultValue)}`,
            duration: { secs: 0, nanos: 500_000_000 },
            invocation: { server: "test", tool: "run", arguments: [1, 2] },
            result: resultValue,
          },
          "event_msg",
        ),
      ),
    );

    expect(result.activities[0]).toMatchObject({
      status: expectedStatus,
      error: expectedError,
      durationMs: 500,
      input: [1, 2],
    });
  });

  it("handles output-first, anonymous, invalid-duration, and reversed-time records deterministically", () => {
    const result = pairToolCalls(
      scoped(
        event(3, "2026-01-01T10:00:01.000Z", {
          type: "tool_search_output",
          call_id: "output-first",
          tools: null,
        }),
        event(2, "2026-01-01T10:00:02.000Z", {
          type: "function_call_output",
          call_id: "reverse-time",
          output: "not-json",
        }),
        event(1, "2026-01-01T10:00:03.000Z", {
          type: "function_call",
          call_id: "reverse-time",
          name: "late",
          arguments: ["already-decoded"],
        }),
        event(4, "2026-01-01T10:00:04.000Z", {
          type: "custom_tool_call",
          name: "anonymous",
        }),
        event(
          5,
          "invalid-date",
          {
            type: "mcp_tool_call_end",
            duration: { secs: -1, nanos: 0 },
            invocation: null,
            result: null,
          },
          "event_msg",
        ),
        event(6, "2026-01-01T10:00:05.000Z", {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ignored" }],
        }),
      ),
    );

    expect(result.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callId: "output-first",
          namespace: "codex",
          name: "tool_search",
          output: null,
          status: "succeeded",
        }),
        expect.objectContaining({
          callId: "reverse-time",
          name: "late",
          input: ["already-decoded"],
          output: "not-json",
          durationMs: null,
        }),
        expect.objectContaining({ callId: null, name: "anonymous", input: null, output: null }),
        expect.objectContaining({
          callId: null,
          namespace: null,
          name: "unknown_tool",
          durationMs: null,
          status: "unknown",
        }),
      ]),
    );
    expect(result.consumedEventIds).toHaveLength(5);
  });
});
