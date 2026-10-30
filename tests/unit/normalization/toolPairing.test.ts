import { describe, expect, it } from "vitest";

import {
  parseCodexEvent,
  type CodexEvent,
  type TurnScopedEvent,
} from "#server/normalization/eventSchema.ts";
import { pairToolCalls } from "#server/normalization/toolPairing.ts";
import { jsonValueSchema } from "#shared/types/conversation.ts";

import { expectedRawIdentity } from "../../helpers/rawIdentity.ts";

const expectedIds = new Map<number, string>();
function expectedRaw(offset: number): string {
  return expectedIds.get(offset)!;
}
function event(
  lineNumber: number,
  timestamp: string,
  payload: Record<string, unknown>,
  type: "event_msg" | "response_item" = "response_item",
): CodexEvent {
  const value = jsonValueSchema.parse({ timestamp, type, payload });
  const record = {
    lineNumber,
    byteStart: lineNumber * 100,
    byteEnd: lineNumber * 100 + 99,
    raw: JSON.stringify(value),
    value,
  };
  expectedIds.set(record.byteStart, expectedRawIdentity(record));
  const parsed = parseCodexEvent(record);
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
        presentation: expect.objectContaining({
          category: "read",
          evidenceKind: "direct",
          callId: "call-1",
          status: "unknown",
        }),
        turnId: "turn-1",
        createdAt: "2026-01-01T10:00:00.000Z",
        rawEventIds: [expectedRaw(100), expectedRaw(400)],
        kind: "tool",
        namespace: "filesystem",
        name: "read_file",
        callId: "call-1",
        status: "unknown",
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
        rawEventIds: [expectedRaw(200), expectedRaw(300)],
        input: { url: "https://example.test/status" },
        output: { status: 503 },
        durationMs: 100,
      }),
    ]);
    expect(result.consumedEventIds).toEqual([
      expectedRaw(100),
      expectedRaw(200),
      expectedRaw(300),
      expectedRaw(400),
    ]);
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
    [{ value: "ok" }, "unknown", null],
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
          status: "unknown",
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

describe("host-recorded Code Mode delta inventories", () => {
  const time = "2026-01-01T10:00:00.000Z";
  const metadata = (cell: string, calls: unknown, complete?: boolean) => ({
    cell_id: cell,
    ...(calls === undefined ? {} : { executed_tool_calls: calls }),
    ...(complete === undefined ? {} : { tool_calls_complete: complete }),
  });
  it("aggregates exec/wait deltas once, keeps repeated arguments distinct and never pairs printed results positionally", () => {
    const first = event(1, time, {
      type: "custom_tool_call",
      call_id: "exec",
      namespace: "functions",
      name: "exec",
      input:
        "const a=await tools.exec_command({cmd:'first'}); const b=await tools.exec_command({cmd:'second'}); text(b); text(a)",
    });
    const firstOutput = event(2, time, {
      type: "custom_tool_call_output",
      call_id: "exec",
      output: [
        { exit_code: 7, output: "second" },
        { exit_code: 0, output: "first" },
      ],
      internal_chat_message_metadata_passthrough: metadata("cell-17", [
        { name: "exec_command", arguments: { cmd: "first" } },
        { name: "exec_command", arguments: { cmd: "second" } },
      ]),
    });
    const events = scoped(
      first,
      firstOutput,
      event(3, time, {
        type: "function_call",
        call_id: "wait1",
        namespace: "functions",
        name: "wait",
        arguments: { cell_id: "cell-17" },
      }),
      event(4, time, {
        type: "function_call_output",
        call_id: "wait1",
        output: "completed",
        internal_chat_message_metadata_passthrough: metadata(
          "cell-17",
          [{ name: "exec_command", arguments: { cmd: "first" } }],
          false,
        ),
      }),
      event(5, time, {
        type: "function_call",
        call_id: "wait2",
        namespace: "functions",
        name: "wait",
        arguments: { cell_id: "cell-17" },
      }),
      event(6, time, {
        type: "function_call_output",
        call_id: "wait2",
        output: "completed",
        internal_chat_message_metadata_passthrough: metadata("cell-17", [], true),
      }),
    );
    const result = pairToolCalls([...events, { event: firstOutput, turnId: "turn-1" }]);
    const attempts = result.activities.filter(
      (activity) => activity.presentation?.evidenceKind === "host-attempt",
    );
    expect(attempts).toHaveLength(3);
    expect(attempts.map((activity) => (activity.kind === "tool" ? activity.input : null))).toEqual([
      { cmd: "first" },
      { cmd: "second" },
      { cmd: "first" },
    ]);
    expect(new Set(attempts.map((activity) => activity.id)).size).toBe(3);
    for (const attempt of attempts) {
      expect(attempt).toMatchObject({
        callId: null,
        status: "unknown",
        output: null,
        durationMs: null,
        presentation: { cellId: "cell-17", evidenceKind: "host-attempt" },
      });
    }
    expect(result.activities.find((activity) => activity.id === "tool-exec")).toMatchObject({
      input: expect.stringContaining("text(b); text(a)"),
      codeMode: {
        cellId: "cell-17",
        completeness: "complete",
        outerActivityIds: ["tool-exec", "tool-wait1", "tool-wait2"],
      },
    });
  });
  it("distinguishes absent, partial and complete empty inventories and keeps direct invocation evidence single", () => {
    for (const [calls, complete, expected] of [
      [undefined, undefined, "absent"],
      [[], undefined, "partial"],
      [[], true, "complete"],
    ] as const) {
      const result = pairToolCalls(
        scoped(
          event(1, time, {
            type: "custom_tool_call_output",
            call_id: "empty",
            output: null,
            internal_chat_message_metadata_passthrough: metadata("empty-cell", calls, complete),
          }),
        ),
      );
      expect(result.activities).toHaveLength(1);
      expect(result.activities[0]).toMatchObject({ codeMode: { completeness: expected } });
    }
    const result = pairToolCalls(
      scoped(
        event(1, time, {
          type: "function_call",
          call_id: "direct",
          name: "exec_command",
          arguments: { cmd: "direct" },
        }),
        event(2, time, {
          type: "function_call_output",
          call_id: "direct",
          output: { exit_code: 7, output: "direct failed" },
          internal_chat_message_metadata_passthrough: {
            executed_tool_calls: [{ name: "exec_command", arguments: { cmd: "direct" } }],
            tool_calls_complete: true,
          },
        }),
      ),
    );
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({
      callId: "direct",
      status: "failed",
      codeMode: { cellId: null, completeness: "complete" },
    });
  });
  it("uses recorded dynamic invocation names, preserves truncated arguments and ignores script/printed metadata", () => {
    const truncation = {
      _codex_executed_tool_call_truncated: { reason: "size", original_bytes: 10000 },
    };
    const result = pairToolCalls(
      scoped(
        event(1, time, {
          type: "custom_tool_call",
          call_id: "dynamic",
          namespace: "functions",
          name: "exec",
          input: "try { await tools[name](args) } catch {}",
        }),
        event(2, time, {
          type: "custom_tool_call_output",
          call_id: "dynamic",
          output: { isError: false, executed_tool_calls: [{ name: "fake", arguments: {} }] },
          internal_chat_message_metadata_passthrough: metadata(
            "dynamic-cell",
            [{ name: "mcp__service__operation", arguments: truncation }],
            true,
          ),
        }),
      ),
    );
    const attempts = result.activities.filter(
      (activity) => activity.presentation?.evidenceKind === "host-attempt",
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      name: "mcp__service__operation",
      input: truncation,
      status: "unknown",
      output: null,
    });
  });
  it("keeps reused provider call IDs in different turns and physical segments separate", () => {
    const a = event(1, time, {
      type: "function_call",
      call_id: "reused",
      name: "read_file",
      arguments: { path: "a" },
    });
    const b = event(2, time, {
      type: "function_call",
      call_id: "reused",
      name: "read_file",
      arguments: { path: "b" },
    });
    const result = pairToolCalls([
      { event: a, turnId: "one" },
      { event: b, turnId: "two" },
    ]);
    expect(result.activities).toHaveLength(2);
    expect(
      result.activities.map((activity) => (activity.kind === "tool" ? activity.input : null)),
    ).toEqual([{ path: "a" }, { path: "b" }]);
  });
});

describe("native command lifecycle and canonical updates", () => {
  const timestamp = "2026-01-01T10:00:00.000Z";
  const command = {
    call_id: "native",
    command: ["node", "task.js"],
    cwd: "C:/repo",
    parsed_cmd: [],
    source: "agent",
    process_id: "process-3",
  };
  it("updates one command from actual begin/end and later canonical payload without keeping the old outcome", () => {
    const result = pairToolCalls(
      scoped(
        event(1, timestamp, { type: "exec_command_begin", ...command }, "event_msg"),
        event(
          2,
          timestamp,
          {
            type: "exec_command_end",
            ...command,
            status: "completed",
            aggregated_output: "old",
            exit_code: 0,
            duration: { secs: 2, nanos: 0 },
          },
          "event_msg",
        ),
        event(
          3,
          timestamp,
          {
            type: "item_completed",
            item: {
              type: "CommandExecution",
              id: "native",
              ...command,
              status: "failed",
              aggregated_output: "new failure",
              exit_code: 9,
            },
          },
          "event_msg",
        ),
      ),
    );
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({
      id: "native",
      nativeItemId: "native",
      status: "failed",
      output: "new failure",
      rawEventIds: [expectedRaw(100), expectedRaw(200), expectedRaw(300)],
    });
  });
  it("keeps a pending process session and its write_stdin continuation identifiers", () => {
    const result = pairToolCalls(
      scoped(
        event(1, timestamp, {
          type: "function_call",
          name: "exec_command",
          call_id: "shell",
          arguments: { cmd: "long" },
        }),
        event(2, timestamp, {
          type: "function_call_output",
          call_id: "shell",
          output: { session_id: 77, output: "started", exit_code: null },
        }),
        event(3, timestamp, {
          type: "function_call",
          name: "write_stdin",
          call_id: "poll",
          arguments: { session_id: 77, chars: "" },
        }),
        event(4, timestamp, {
          type: "function_call_output",
          call_id: "poll",
          output: { exit_code: 4, output: "failed" },
        }),
      ),
    );
    expect(result.activities).toMatchObject([
      { name: "exec_command", status: "running", completedAt: null, output: { session_id: 77 } },
      {
        name: "write_stdin",
        status: "failed",
        input: { session_id: 77 },
        output: { exit_code: 4 },
      },
    ]);
  });
  it("preserves structured text, image and audio blocks without interpreting their order as tool results", () => {
    const output = {
      content: [
        { type: "text", text: "first" },
        { type: "image", data: "AA==", mimeType: "image/png" },
        { type: "audio", data: "AA==", mimeType: "audio/wav" },
      ],
      isError: false,
    };
    const result = pairToolCalls(
      scoped(event(1, timestamp, { type: "function_call_output", call_id: "media", output })),
    );
    expect(result.activities[0]).toMatchObject({ output, status: "succeeded" });
  });
});
