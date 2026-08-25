import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { JsonlStreamParser, type JsonlRecord } from "../../../server/ingestion/jsonlStream.ts";
import { normalizeSession } from "../../../server/normalization/normalizeSession.ts";
import {
  conversationSummarySchema,
  conversationTurnSchema,
  mediaReferenceSchema,
} from "../../../shared/types/conversation.ts";

async function fixtureRecords(name: string): Promise<JsonlRecord[]> {
  const path = join(process.cwd(), "tests", "fixtures", "rollouts", name);
  const bytes = await readFile(path);
  const records: JsonlRecord[] = [];
  const parser = new JsonlStreamParser({ onRecord: (record) => records.push(record) });
  for (let offset = 0; offset < bytes.byteLength; offset += 37) {
    parser.write(bytes.subarray(offset, offset + 37), offset);
  }
  expect(parser.finish().pending).toEqual(Buffer.alloc(0));
  return records;
}

function jsonlRecords(values: JsonlRecord["value"][]): JsonlRecord[] {
  return values.map((value, index) => ({
    lineNumber: index + 1,
    byteStart: index * 100,
    byteEnd: (index + 1) * 100,
    raw: JSON.stringify(value),
    value,
  }));
}

describe("session normalization", () => {
  it("normalizes a modern rollout without double-counting duplicated prose or token snapshots", async () => {
    const records = await fixtureRecords("modern.jsonl");

    const result = normalizeSession({
      records,
      sourcePath: "C:\\codex\\sessions\\modern.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.session).not.toBeNull();
    const session = result.session!;
    expect(() => conversationSummarySchema.parse(session.summary)).not.toThrow();
    expect(() => session.turns.map((turn) => conversationTurnSchema.parse(turn))).not.toThrow();
    expect(session.summary).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      title: "Build the parser",
      scope: "active",
      sourcePath: "C:\\codex\\sessions\\modern.jsonl",
      cwd: "C:\\work\\viewer",
      gitBranch: "feature/parser",
      gitSha: "abc123",
      gitOriginUrl: "https://example.test/viewer.git",
      models: ["gpt-exact-1", "gpt-exact-2"],
      reasoningEfforts: ["medium", "high"],
      turnCount: 2,
      assistantMessageCount: 2,
      toolCallCount: 1,
      toolCounts: { "filesystem.read_file": 1 },
      preview: "Build the parser",
      parentThreadId: "00000000-0000-4000-8000-000000000001",
      hasMedia: true,
    });
    expect(session.turns[0]).toMatchObject({
      id: "turn-1",
      index: 0,
      startedAt: "2026-01-01T10:00:02.000Z",
      completedAt: "2026-01-01T10:00:14.000Z",
      durationMs: 12_000,
      timeToFirstTokenMs: 900,
      tokenDelta: {
        inputTokens: 70,
        cachedInputTokens: 20,
        outputTokens: 25,
        reasoningOutputTokens: 5,
        totalTokens: 100,
      },
      models: ["gpt-exact-1"],
      reasoningEfforts: ["medium"],
      toolCounts: { "filesystem.read_file": 1 },
    });
    expect(session.turns[0]?.assistantMessages).toEqual([
      expect.objectContaining({
        phase: "final",
        createdAt: "2026-01-01T10:00:05.000Z",
        sourceMarkdown: expect.stringContaining("The parser is ready."),
      }),
    ]);
    expect(session.turns[0]?.assistantMessages[0]?.sourceMarkdown).toContain(
      '```ts title="reader.ts"',
    );
    expect(session.turns[0]?.assistantMessages[0]?.sourceMarkdown).toContain("```mermaid");
    expect(session.turns[0]?.assistantMessages[0]?.sourceMarkdown).toContain(
      "![Generated pixel](data:image/png;base64,",
    );
    expect(session.turns[0]?.assistantMessages[0]?.rawEventIds).toHaveLength(2);
    expect(session.turns[0]?.activities.filter(({ kind }) => kind === "reasoning")).toEqual([
      expect.objectContaining({
        summary: "Inspect the event shapes.",
        encrypted: true,
      }),
    ]);
    expect(
      session.turns[0]?.activities.find(({ kind }) => kind === "reasoning")?.rawEventIds,
    ).toHaveLength(2);
    expect(session.turns[0]?.activities.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        "reasoning",
        "tool",
        "web_search",
        "patch",
        "plan",
        "subagent",
        "compaction",
        "media",
      ]),
    );
    expect(session.turns[1]).toMatchObject({
      id: "turn-2",
      durationMs: 4000,
      timeToFirstTokenMs: null,
      tokenDelta: {
        inputTokens: 40,
        cachedInputTokens: 10,
        outputTokens: 15,
        reasoningOutputTokens: 5,
        totalTokens: 60,
      },
      models: ["gpt-exact-2"],
      reasoningEfforts: ["high"],
    });
    expect(session.turns[1]?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "status", status: "cancelled", message: "interrupted" }),
        expect.objectContaining({
          kind: "unknown",
          eventType: "event_msg:future_payload",
          payload: expect.objectContaining({
            payload: { type: "future_payload", secret_blob: "[redacted]", value: 7 },
          }),
        }),
      ]),
    );
    expect(session.rawEvents).toHaveLength(records.length);
    expect(JSON.stringify(session.rawEvents)).not.toContain("opaque-not-for-decryption");
  });

  it("normalizes legacy shapes, encrypted-only reasoning, missing tool outputs, and future events", async () => {
    const records = await fixtureRecords("legacy.jsonl");

    const result = normalizeSession({
      records,
      sourcePath: "/codex/archived_sessions/legacy.jsonl",
      scope: "archived",
      sessionIndexEntries: [],
      stateSnapshot: null,
    });

    expect(result.session?.summary).toMatchObject({
      id: "33333333-3333-4333-8333-333333333333",
      title: "Legacy prompt",
      scope: "archived",
      cwd: "/workspace/legacy",
      turnCount: 1,
      toolCounts: { exec: 1 },
      hasMedia: true,
    });
    expect(result.session?.turns[0]?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "reasoning", encrypted: true, summary: "" }),
        expect.objectContaining({
          kind: "tool",
          callId: "missing-output",
          status: "running",
          output: null,
        }),
        expect.objectContaining({ kind: "web_search", query: "legacy" }),
        expect.objectContaining({ kind: "plan", title: "Finish legacy parsing" }),
        expect.objectContaining({ kind: "subagent", description: "Research completed" }),
        expect.objectContaining({ kind: "media", mediaType: "image" }),
        expect.objectContaining({ kind: "compaction", summary: null }),
        expect.objectContaining({ kind: "status", message: "Rolled back 1 turn." }),
        expect.objectContaining({
          kind: "unknown",
          eventType: "future_top_level",
          payload: expect.objectContaining({
            payload: { safe: "visible", refresh_token: "[redacted]" },
          }),
        }),
      ]),
    );
  });

  it("uses a filename UUID only when no session metadata provides an identity", () => {
    const sourcePath =
      "/codex/sessions/rollout-2026-01-01T00-00-00-55555555-5555-4555-8555-555555555555.jsonl";
    const value = {
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Filename fallback" },
    } as JsonlRecord["value"];
    const result = normalizeSession({
      sourcePath,
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
      records: [
        {
          lineNumber: 1,
          byteStart: 0,
          byteEnd: 100,
          raw: JSON.stringify(value),
          value,
        },
      ],
    });

    expect(basename(sourcePath)).toContain("55555555-5555-4555-8555-555555555555");
    expect(result.session?.summary.id).toBe("55555555-5555-4555-8555-555555555555");
  });

  it("reports an invalid event envelope without losing later valid records", () => {
    const invalid = {
      lineNumber: 1,
      byteStart: 0,
      byteEnd: 10,
      raw: "[]",
      value: [],
    } satisfies JsonlRecord;
    const validValue = {
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "session_meta",
      payload: { id: "66666666-6666-4666-8666-666666666666" },
    } as JsonlRecord["value"];

    const result = normalizeSession({
      sourcePath: "source.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
      records: [
        invalid,
        {
          lineNumber: 2,
          byteStart: 10,
          byteEnd: 100,
          raw: JSON.stringify(validValue),
          value: validValue,
        },
      ],
    });

    expect(result.session?.summary.id).toBe("66666666-6666-4666-8666-666666666666");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "source.invalid_jsonl", details: { line: 1 } }),
    ]);
  });

  it("accepts session_id-only metadata and exposes task errors without inventing timing metrics", () => {
    const values = [
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { session_id: "77777777-7777-4777-8777-777777777777" },
      },
      {
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-error" },
      },
      {
        timestamp: "2026-01-01T00:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-error",
          error: { message: "Synthetic failure" },
        },
      },
    ] as JsonlRecord["value"][];
    const result = normalizeSession({
      sourcePath: "source-without-uuid.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
      records: values.map((value, index) => ({
        lineNumber: index + 1,
        byteStart: index * 100,
        byteEnd: (index + 1) * 100,
        raw: JSON.stringify(value),
        value,
      })),
    });

    expect(result.session?.summary.id).toBe("77777777-7777-4777-8777-777777777777");
    expect(result.session?.turns[0]).toMatchObject({
      id: "turn-error",
      durationMs: null,
      timeToFirstTokenMs: null,
    });
    expect(result.session?.turns[0]?.activities).toEqual([
      expect.objectContaining({
        kind: "status",
        status: "failed",
        message: "Synthetic failure",
      }),
    ]);
  });

  it("keeps an in-flight steering message inside the active source turn", () => {
    const values = [
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "88888888-8888-4888-8888-888888888888" },
      },
      {
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-running" },
      },
      {
        timestamp: "2026-01-01T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "initial prompt" },
      },
      {
        timestamp: "2026-01-01T00:00:03.000Z",
        type: "event_msg",
        payload: { type: "agent_reasoning", text: "still working" },
      },
      {
        timestamp: "2026-01-01T00:00:04.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "steer the running model" },
      },
      {
        timestamp: "2026-01-01T00:00:05.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-running" },
      },
    ] as JsonlRecord["value"][];

    const result = normalizeSession({
      sourcePath: "steering.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
      records: values.map((value, index) => ({
        lineNumber: index + 1,
        byteStart: index * 100,
        byteEnd: (index + 1) * 100,
        raw: JSON.stringify(value),
        value,
      })),
    });

    expect(result.session?.turns).toEqual([
      expect.objectContaining({
        id: "turn-running",
        sourceTurnId: "turn-running",
        userMessage: expect.objectContaining({ sourceMarkdown: "initial prompt" }),
        steeringMessages: [expect.objectContaining({ sourceMarkdown: "steer the running model" })],
        entryOrder: [
          { kind: "message", id: "message-raw-200" },
          { kind: "activity", id: "reasoning-raw-300" },
          { kind: "message", id: "message-raw-400" },
        ],
      }),
    ]);
  });

  it("preserves Markdown reasoning entries, steering, progress, tools, and the final response in source order", () => {
    const result = normalizeSession({
      sourcePath: "ordered.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
      records: jsonlRecords([
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        },
        {
          timestamp: "2026-01-01T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-ordered" },
        },
        {
          timestamp: "2026-01-01T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Build it" },
        },
        {
          timestamp: "2026-01-01T00:00:03.000Z",
          type: "response_item",
          payload: {
            type: "reasoning",
            id: "reasoning-source",
            summary: [
              { type: "summary_text", text: "**Planning** the implementation" },
              { type: "summary_text", text: "**Checking** the boundary" },
            ],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-ordered" },
          },
        },
        {
          timestamp: "2026-01-01T00:00:04.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "I am checking the files.",
            phase: "commentary",
          },
        },
        {
          timestamp: "2026-01-01T00:00:05.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Please also cover Windows." },
        },
        {
          timestamp: "2026-01-01T00:00:06.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "tool-source",
            call_id: "call-1",
            name: "exec_command",
            arguments: '{"cmd":"pnpm test"}',
            internal_chat_message_metadata_passthrough: { turn_id: "turn-ordered" },
          },
        },
        {
          timestamp: "2026-01-01T00:00:07.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "tool-output",
            call_id: "call-1",
            output: "passed",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-ordered" },
          },
        },
        {
          timestamp: "2026-01-01T00:00:08.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "Done.", phase: "final" },
        },
        {
          timestamp: "2026-01-01T00:00:09.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-ordered" },
        },
      ]),
    });

    const turn = result.session?.turns[0];
    expect(turn?.steeringMessages?.map(({ sourceMarkdown }) => sourceMarkdown)).toEqual([
      "Please also cover Windows.",
    ]);
    expect(turn?.activities.filter(({ kind }) => kind === "reasoning")).toHaveLength(2);
    expect(turn?.entryOrder).toEqual([
      { kind: "message", id: "message-raw-200" },
      { kind: "activity", id: "reasoning-raw-300-0" },
      { kind: "activity", id: "reasoning-raw-300-1" },
      { kind: "message", id: "message-raw-400" },
      { kind: "message", id: "message-raw-500" },
      { kind: "activity", id: "tool-call-1" },
      { kind: "message", id: "message-raw-800" },
    ]);
    expect(turn?.finalAssistantMessageId).toBe("message-raw-800");
  });

  it("coalesces both web-search representations without losing completion details", () => {
    const result = normalizeSession({
      sourcePath: "web-search.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
      records: jsonlRecords([
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "99999999-9999-4999-8999-999999999999" },
        },
        {
          timestamp: "2026-01-01T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-web" },
        },
        {
          timestamp: "2026-01-01T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "search" },
        },
        {
          timestamp: "2026-01-01T00:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "web_search_end",
            call_id: "search-1",
            query: "Nuxt offline rendering",
            results: [{ url: "https://nuxt.com" }, { url: "https://pagefind.app" }],
          },
        },
        {
          timestamp: "2026-01-01T00:00:03.010Z",
          type: "response_item",
          payload: {
            type: "web_search_call",
            id: "search-1",
            status: "completed",
            action: { type: "search", query: "Nuxt offline rendering" },
          },
        },
      ]),
    });

    expect(
      result.session?.turns[0]?.activities.filter(({ kind }) => kind === "web_search"),
    ).toEqual([
      expect.objectContaining({
        id: "web-search-1",
        query: "Nuxt offline rendering",
        status: "succeeded",
        resultCount: 2,
        rawEventIds: ["raw-300", "raw-400"],
      }),
    ]);
  });

  it("pairs a tool call and output across an in-flight steering boundary", () => {
    const result = normalizeSession({
      sourcePath: "steered-tool.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
      records: jsonlRecords([
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        },
        {
          timestamp: "2026-01-01T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-tool" },
        },
        {
          timestamp: "2026-01-01T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "run it" },
        },
        {
          timestamp: "2026-01-01T00:00:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-1",
            name: "exec_command",
            arguments: '{"cmd":"pnpm test"}',
          },
        },
        {
          timestamp: "2026-01-01T00:00:04.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "do not stop the running model" },
        },
        {
          timestamp: "2026-01-01T00:00:05.000Z",
          type: "response_item",
          payload: { type: "function_call_output", call_id: "call-1", output: "passed" },
        },
        {
          timestamp: "2026-01-01T00:00:06.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-tool" },
        },
      ]),
    });

    const tools = result.session?.turns.flatMap(({ activities }) =>
      activities.filter(({ kind }) => kind === "tool"),
    );
    expect(tools).toEqual([
      expect.objectContaining({
        id: "tool-call-1",
        turnId: "turn-tool",
        name: "exec_command",
        input: { cmd: "pnpm test" },
        output: "passed",
        status: "succeeded",
        rawEventIds: ["raw-300", "raw-500"],
      }),
    ]);
  });

  it("keeps repeated plan revisions as separately addressable activities", () => {
    const result = normalizeSession({
      sourcePath: "plans.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
      records: jsonlRecords([
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        },
        {
          timestamp: "2026-01-01T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-plan" },
        },
        {
          timestamp: "2026-01-01T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "write the plan" },
        },
        {
          timestamp: "2026-01-01T00:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: { type: "Plan", id: "plan-1", text: "Version one" },
          },
        },
        {
          timestamp: "2026-01-01T00:00:04.000Z",
          type: "event_msg",
          payload: {
            type: "item_completed",
            item: { type: "Plan", id: "plan-1", text: "Version two" },
          },
        },
      ]),
    });

    expect(result.session?.turns[0]?.activities.filter(({ kind }) => kind === "plan")).toEqual([
      expect.objectContaining({
        id: "plan-plan-1",
        items: [{ step: "Version one", status: "completed" }],
      }),
      expect.objectContaining({
        id: "plan-plan-1:raw-400",
        items: [{ step: "Version two", status: "completed" }],
      }),
    ]);
  });

  it("returns a non-recoverable diagnostic when no session identity is available", () => {
    const result = normalizeSession({
      sourcePath: "rollout-without-an-id.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
      records: [],
    });

    expect(result.session).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "source.invalid_jsonl",
        recoverable: false,
        details: { reason: "missing-session-id" },
      }),
    ]);
  });

  it("uses a filename identity and epoch timestamps for an otherwise empty rollout", () => {
    const result = normalizeSession({
      sourcePath: "rollout-2026-01-01T00-00-00-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl",
      scope: "archived",
      sessionIndexEntries: [],
      stateSnapshot: null,
      records: [],
    });

    expect(result.session).toMatchObject({
      summary: {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        createdAt: "1970-01-01T00:00:00.000Z",
        updatedAt: "1970-01-01T00:00:00.000Z",
        revision: expect.stringMatching(/^parser-\d+:0$/u),
        turnCount: 0,
      },
      turns: [],
      rawEvents: [],
    });
  });

  it("normalizes settings, numeric timing, fallback messages, and token resets", () => {
    const result = normalizeSession({
      sourcePath: "settings-and-timing.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
      revision: "explicit-revision",
      records: jsonlRecords([
        {
          timestamp: "2026-01-01T00:00:05.000Z",
          type: "session_meta",
          payload: {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            timestamp: "2026-01-01T00:00:01.000Z",
            cwd: "  C:/workspace  ",
            parent_thread_id: "parent-1",
            git: { branch: "main", commit_hash: "abc", repository_url: "https://example.test" },
          },
        },
        {
          timestamp: "invalid timestamp",
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: { model: "gpt-fallback", reasoning_effort: "medium" },
          },
        },
        {
          timestamp: "2026-01-01T00:00:02.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-1", started_at: 1_767_225_602 },
        },
        {
          timestamp: "2026-01-01T00:00:02.100Z",
          type: "turn_context",
          payload: { turn_id: "turn-1", model: "gpt-explicit" },
        },
        {
          timestamp: "2026-01-01T00:00:03.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "First prompt" },
        },
        {
          timestamp: "2026-01-01T00:00:04.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 2,
                output_tokens: 4,
                reasoning_output_tokens: 1,
                total_tokens: 17,
              },
            },
          },
        },
        {
          timestamp: "2026-01-01T00:00:06.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-1",
            completed_at: 1_767_225_606_000,
            duration_ms: 4_000,
            time_to_first_token_ms: 250,
            last_agent_message: "Fallback final answer",
          },
        },
        {
          timestamp: "2026-01-01T00:00:07.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-2" },
        },
        {
          timestamp: "2026-01-01T00:00:08.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Second prompt" },
        },
        {
          timestamp: "2026-01-01T00:00:09.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 3,
                cached_input_tokens: 1,
                output_tokens: 2,
                reasoning_output_tokens: 0,
                total_tokens: 6,
              },
            },
          },
        },
        {
          timestamp: "2026-01-01T00:00:10.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-2" },
        },
      ]),
    });

    expect(result.session?.summary).toMatchObject({
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:10.000Z",
      cwd: "C:/workspace",
      parentThreadId: "parent-1",
      gitBranch: "main",
      revision: "explicit-revision",
    });
    expect(result.session?.turns[0]).toMatchObject({
      startedAt: "2026-01-01T00:00:02.000Z",
      completedAt: "2026-01-01T00:00:06.000Z",
      durationMs: 4_000,
      timeToFirstTokenMs: 250,
      models: ["gpt-explicit"],
      reasoningEfforts: ["medium"],
      tokenDelta: { totalTokens: 17 },
      assistantMessages: [expect.objectContaining({ sourceMarkdown: "Fallback final answer" })],
    });
    expect(result.session?.turns[1]).toMatchObject({
      models: ["gpt-fallback"],
      reasoningEfforts: ["medium"],
      tokenDelta: { totalTokens: 6 },
    });
  });

  it("preserves settings precedence, timestamp fallbacks, turn order, and raw event identity", () => {
    const result = normalizeSession({
      sourcePath: "settings-timeline.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
      revision: "settings-timeline-revision",
      records: jsonlRecords([
        {
          timestamp: "2026-01-01T00:00:05.000Z",
          type: "session_meta",
          payload: {
            id: "71717171-7171-4717-8717-717171717171",
            timestamp: "2026-01-01T00:00:01.000Z",
          },
        },
        {
          timestamp: "invalid",
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: { model: "gpt-before", reasoning_effort: "low" },
          },
        },
        {
          timestamp: "2026-01-01T00:00:03.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-1" },
        },
        {
          timestamp: "2026-01-01T00:00:03.000Z",
          type: "turn_context",
          payload: { turn_id: "turn-1", model: "gpt-explicit" },
        },
        {
          type: "event_msg",
          payload: { type: "user_message", message: "First" },
        },
        {
          timestamp: "2026-01-01T00:00:07.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-1" },
        },
        {
          timestamp: "2026-01-01T00:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: { model: "gpt-between" },
          },
        },
        {
          timestamp: "2026-01-01T00:00:08.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-2" },
        },
        {
          timestamp: "2026-01-01T01:00:08.000+01:00",
          type: "turn_context",
          payload: { turn_id: "turn-2", effort: "high" },
        },
        {
          timestamp: "2026-01-01T00:00:08.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Second" },
        },
        {
          timestamp: "2026-01-01T00:00:09.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-2" },
        },
        {
          timestamp: "2026-01-01T00:00:10.000Z",
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: { model: "gpt-after", reasoning_effort: "max" },
          },
        },
      ]),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.session?.summary).toMatchObject({
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:10.000Z",
      models: ["gpt-explicit", "gpt-between"],
      reasoningEfforts: ["low", "high"],
      revision: "settings-timeline-revision",
    });
    expect(
      result.session?.turns.map(({ id, index, models, reasoningEfforts }) => ({
        id,
        index,
        models,
        reasoningEfforts,
      })),
    ).toEqual([
      { id: "turn-1", index: 0, models: ["gpt-explicit"], reasoningEfforts: ["low"] },
      { id: "turn-2", index: 1, models: ["gpt-between"], reasoningEfforts: ["high"] },
    ]);
    expect(result.session?.rawEvents.map(({ id, timestamp }) => ({ id, timestamp }))).toEqual([
      { id: "raw-0", timestamp: "2026-01-01T00:00:05.000Z" },
      { id: "raw-100", timestamp: null },
      { id: "raw-200", timestamp: "2026-01-01T00:00:03.000Z" },
      { id: "raw-300", timestamp: "2026-01-01T00:00:03.000Z" },
      { id: "raw-400", timestamp: null },
      { id: "raw-500", timestamp: "2026-01-01T00:00:07.000Z" },
      { id: "raw-600", timestamp: "2026-01-01T00:00:02.000Z" },
      { id: "raw-700", timestamp: "2026-01-01T00:00:08.000Z" },
      { id: "raw-800", timestamp: "2026-01-01T01:00:08.000+01:00" },
      { id: "raw-900", timestamp: "2026-01-01T00:00:08.000Z" },
      { id: "raw-1000", timestamp: "2026-01-01T00:00:09.000Z" },
      { id: "raw-1100", timestamp: "2026-01-01T00:00:10.000Z" },
    ]);
  });

  it("keeps malformed optional protocol evidence degradable across activity variants", () => {
    const statuses = [
      "completed",
      "complete",
      "succeeded",
      "success",
      "failed",
      "error",
      "aborted",
      "cancelled",
      "canceled",
      "running",
      "in_progress",
      "pending",
      "future",
    ];
    const result = normalizeSession({
      sourcePath: "optional-protocol.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
      records: jsonlRecords([
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "session_meta",
          payload: { cwd: "ignored without an identity" },
        },
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
        },
        {
          timestamp: "2026-01-01T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-activities" },
        },
        {
          timestamp: "2026-01-01T00:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Attachments",
            local_images: ["C:/image.png", 7],
            images: ["C:/second.png"],
            local_audio: ["C:/audio.wav"],
            audio: ["C:/second.wav", null],
          },
        },
        {
          timestamp: "2026-01-01T00:00:02.100Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            id: "input-image-message",
            content: [
              { type: "input_text", text: "Image prompt" },
              { type: "input_image", image_url: "data:image/png;base64,AA==" },
              { type: "input_image", image_url: 7 },
            ],
          },
        },
        {
          timestamp: "2026-01-01T00:00:03.000Z",
          type: "event_msg",
          payload: { type: "agent_reasoning", text: "Shared reasoning" },
        },
        {
          timestamp: "2026-01-01T00:00:03.100Z",
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Shared reasoning" }],
            encrypted_content: "ciphertext",
          },
        },
        {
          timestamp: "2026-01-01T00:00:03.200Z",
          type: "response_item",
          payload: { type: "reasoning", content: [], encrypted_content: "ciphertext" },
        },
        {
          timestamp: "2026-01-01T00:00:03.300Z",
          type: "event_msg",
          payload: { type: "agent_reasoning", text: 7 },
        },
        {
          timestamp: "2026-01-01T00:00:03.400Z",
          type: "response_item",
          payload: { type: "reasoning", summary: [] },
        },
        ...statuses.map((status, index) => ({
          timestamp: `2026-01-01T00:00:${String(index + 4).padStart(2, "0")}.000Z`,
          type: "response_item",
          payload: {
            type: "web_search_call",
            id: `search-${index}`,
            status,
            action: { queries: ["one", 2, "two"] },
          },
        })),
        {
          timestamp: "2026-01-01T00:00:18.000Z",
          type: "event_msg",
          payload: { type: "web_search_end" },
        },
        {
          timestamp: "2026-01-01T00:00:18.100Z",
          type: "response_item",
          payload: { type: "web_search_call", id: "search-without-status", action: null },
        },
        {
          timestamp: "2026-01-01T00:00:19.000Z",
          type: "event_msg",
          payload: { type: "patch_apply_end", success: false, status: "error" },
        },
        {
          timestamp: "2026-01-01T00:00:20.000Z",
          type: "event_msg",
          payload: {
            type: "thread_goal_updated",
            goal: { objective: "Ship it", status: "running" },
          },
        },
        {
          timestamp: "2026-01-01T00:00:20.100Z",
          type: "event_msg",
          payload: {
            type: "thread_goal_updated",
            goal: { objective: "Completed goal", status: "completed" },
          },
        },
        {
          timestamp: "2026-01-01T00:00:20.200Z",
          type: "event_msg",
          payload: {
            type: "thread_goal_updated",
            goal: { objective: "Failed goal", status: "failed" },
          },
        },
        {
          timestamp: "2026-01-01T00:00:20.300Z",
          type: "event_msg",
          payload: { type: "thread_goal_updated", goal: {} },
        },
        {
          timestamp: "2026-01-01T00:00:20.400Z",
          type: "event_msg",
          payload: { type: "item_completed", item: { type: "Other", text: "Ignored" } },
        },
        {
          timestamp: "2026-01-01T00:00:21.000Z",
          type: "event_msg",
          payload: { type: "item_completed", item: { type: "Plan", text: "First" } },
        },
        {
          timestamp: "2026-01-01T00:00:22.000Z",
          type: "event_msg",
          payload: { type: "item_completed", item: { type: "Plan", text: "Second" } },
        },
        {
          timestamp: "2026-01-01T00:00:23.000Z",
          type: "event_msg",
          payload: { type: "item_completed", item: { type: "Plan", text: "Third" } },
        },
        {
          timestamp: "2026-01-01T00:00:24.000Z",
          type: "event_msg",
          payload: { type: "sub_agent_activity", kind: "in_progress" },
        },
        {
          timestamp: "2026-01-01T00:00:24.100Z",
          type: "event_msg",
          payload: { type: "sub_agent_activity" },
        },
        {
          timestamp: "2026-01-01T00:00:25.000Z",
          type: "response_item",
          payload: {
            type: "agent_message",
            author: "agent-1",
            recipient: "parent-1",
            content: [{ type: "text", text: "Subagent report" }],
          },
        },
        {
          timestamp: "2026-01-01T00:00:25.100Z",
          type: "response_item",
          payload: { type: "agent_message", content: { unexpected: true } },
        },
        {
          timestamp: "2026-01-01T00:00:26.000Z",
          type: "compacted",
          payload: null,
        },
        {
          timestamp: "2026-01-01T00:00:27.000Z",
          type: "event_msg",
          payload: { type: "context_compacted", message: "Compact summary" },
        },
        {
          timestamp: "2026-01-01T00:00:28.000Z",
          type: "event_msg",
          payload: { type: "thread_rolled_back", num_turns: 2 },
        },
        {
          timestamp: "2026-01-01T00:00:29.000Z",
          type: "event_msg",
          payload: { type: "image_generation_end" },
        },
        {
          timestamp: "2026-01-01T00:00:30.000Z",
          type: "response_item",
          payload: { type: "image_generation_call" },
        },
        {
          timestamp: "2026-01-01T00:00:31.000Z",
          type: "future_top_level",
          payload: ["unknown"],
        },
        {
          timestamp: "2026-01-01T00:00:32.000Z",
          type: "event_msg",
          payload: { type: "turn_aborted" },
        },
      ]),
    });

    const turn = result.session?.turns[0];
    expect(turn?.userMessage?.attachmentIds).toHaveLength(4);
    expect(turn?.steeringMessages?.[0]?.attachmentIds).toHaveLength(1);
    expect(turn?.activities.filter(({ kind }) => kind === "reasoning")).toEqual([
      expect.objectContaining({ summary: "Shared reasoning", encrypted: true }),
      expect.objectContaining({ summary: "", encrypted: true, body: null }),
    ]);
    expect(
      turn?.activities.flatMap((activity) =>
        activity.kind === "web_search" ? [activity.status] : [],
      ),
    ).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "failed",
      "failed",
      "cancelled",
      "cancelled",
      "cancelled",
      "running",
      "running",
      "pending",
      "unknown",
      "succeeded",
      "unknown",
    ]);
    expect(turn?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "patch", status: "failed", affectedPaths: [] }),
        expect.objectContaining({ kind: "plan", title: "Ship it", status: "running" }),
        expect.objectContaining({ kind: "subagent", description: "in_progress" }),
        expect.objectContaining({ kind: "subagent", description: "Subagent activity" }),
        expect.objectContaining({ kind: "compaction", summary: null }),
        expect.objectContaining({ kind: "status", message: "Rolled back 2 turns." }),
        expect.objectContaining({
          kind: "media",
          reference: expect.objectContaining({ kind: "invalid", reason: "missing" }),
        }),
        expect.objectContaining({ kind: "unknown", eventType: "future_top_level" }),
        expect.objectContaining({ kind: "status", message: "Turn cancelled." }),
      ]),
    );
    const plans = turn?.activities.filter(({ kind }) => kind === "plan") ?? [];
    expect(new Set(plans.map(({ id }) => id)).size).toBe(plans.length);
    expect(result.diagnostics).toEqual([]);
  });

  it("classifies attachment references without treating every protocol string as a path", () => {
    const result = normalizeSession({
      sourcePath: "media-references.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
      records: jsonlRecords([
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "abababab-abab-4bab-8bab-abababababab" },
        },
        {
          timestamp: "2026-01-01T00:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn-media" },
        },
        {
          timestamp: "2026-01-01T00:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Classify these attachments",
            local_images: [
              "C:/Users/viewer/photo.png",
              "data:image/png;base64,AA==",
              "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E",
              "https://example.test/photo.png",
              "file:///C:/Users/viewer/photo.png",
              "",
              "relative/photo.png",
              "data:text/plain,hello",
              "data:image/png;base64,%%%",
            ],
            local_audio: ["C:/Users/viewer/sample.wav"],
          },
        },
        {
          timestamp: "2026-01-01T00:00:02.100Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            id: "input-image-message",
            content: [
              { type: "input_text", text: "Response image" },
              { type: "input_image", image_url: "C:/Users/viewer/response.png" },
            ],
          },
        },
        {
          timestamp: "2026-01-01T00:00:03.000Z",
          type: "event_msg",
          payload: { type: "turn_aborted" },
        },
      ]),
    });

    const media =
      result.session?.turns[0]?.activities.filter((activity) => activity.kind === "media") ?? [];
    expect(media.map(({ assetId, reference }) => ({ assetId, reference }))).toEqual([
      {
        assetId: "asset-raw-200-0",
        reference: {
          kind: "local-file",
          path: "C:/Users/viewer/photo.png",
          provenance: "user-message",
        },
      },
      {
        assetId: "asset-raw-200-1",
        reference: expect.objectContaining({
          kind: "data",
          mimeType: "image/png",
          encoding: "base64",
          payload: "AA==",
        }),
      },
      {
        assetId: "asset-raw-200-2",
        reference: expect.objectContaining({
          kind: "data",
          mimeType: "image/svg+xml",
          encoding: "percent",
        }),
      },
      {
        assetId: "asset-raw-200-3",
        reference: {
          kind: "remote",
          url: "https://example.test/photo.png",
        },
      },
      {
        assetId: "asset-raw-200-4",
        reference: expect.objectContaining({ kind: "invalid", reason: "unsupported-scheme" }),
      },
      {
        assetId: "asset-raw-200-5",
        reference: expect.objectContaining({ kind: "invalid", reason: "empty" }),
      },
      {
        assetId: "asset-raw-200-6",
        reference: expect.objectContaining({ kind: "invalid", reason: "relative-path" }),
      },
      {
        assetId: "asset-raw-200-7",
        reference: expect.objectContaining({
          kind: "invalid",
          reason: "unsupported-media-type",
        }),
      },
      {
        assetId: "asset-raw-200-8",
        reference: expect.objectContaining({ kind: "invalid", reason: "malformed-data" }),
      },
      {
        assetId: "asset-raw-200-9",
        reference: {
          kind: "local-file",
          path: "C:/Users/viewer/sample.wav",
          provenance: "user-message",
        },
      },
      {
        assetId: "asset-raw-300-0",
        reference: {
          kind: "local-file",
          path: "C:/Users/viewer/response.png",
          provenance: "response-input",
        },
      },
    ]);
    expect(result.session?.turns[0]?.userMessage?.attachmentIds).toHaveLength(10);
    expect(result.session?.turns[0]?.steeringMessages?.[0]?.attachmentIds).toEqual([
      "asset-raw-300-0",
    ]);
    expect(
      mediaReferenceSchema.safeParse({
        kind: "local-file",
        path: "C:/image.png",
        provenance: "user-message",
        url: "https://example.test/image.png",
      }).success,
    ).toBe(false);
    expect(mediaReferenceSchema.safeParse({ kind: "future-media" }).success).toBe(false);
  });

  it("uses bounded fallbacks for partial messages, settings, tokens, and statuses", () => {
    const result = normalizeSession({
      sourcePath: "partial-fallbacks.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
      records: jsonlRecords([
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
        },
        {
          timestamp: "2026-01-01T00:00:00.100Z",
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: { model: "gpt-retained", reasoning_effort: "high" },
          },
        },
        {
          timestamp: "2026-01-01T00:00:00.200Z",
          type: "event_msg",
          payload: {
            type: "thread_settings_applied",
            thread_settings: { model: null, reasoning_effort: null },
          },
        },
        {
          timestamp: "2026-01-01T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-fallbacks",
            started_at: "2026-01-01T00:00:00.500Z",
          },
        },
        {
          timestamp: "invalid",
          type: "event_msg",
          payload: { type: "user_message", message: "Duplicate user" },
        },
        {
          timestamp: "2026-01-01T00:00:02.100Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Duplicate user" }],
          },
        },
        {
          timestamp: "2026-01-01T00:00:02.200Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            phase: "commentary",
            content: [{ type: "input_text", text: "Reverse duplicate" }],
          },
        },
        {
          timestamp: "2026-01-01T00:00:02.300Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Reverse duplicate" },
        },
        {
          timestamp: "2026-01-01T00:00:02.400Z",
          type: "event_msg",
          payload: { type: "user_message", message: 7 },
        },
        {
          timestamp: "2026-01-01T00:00:02.500Z",
          type: "response_item",
          payload: { type: "message", role: "user", content: { unexpected: true } },
        },
        {
          timestamp: "2026-01-01T00:00:03.000Z",
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: { unexpected: true },
            encrypted_content: "ciphertext",
          },
        },
        {
          timestamp: "2026-01-01T00:00:03.100Z",
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: 7 }],
            encrypted_content: "ciphertext",
          },
        },
        {
          timestamp: "2026-01-01T00:00:04.000Z",
          type: "event_msg",
          payload: { type: "web_search_end", call_id: "same-search", query: "query" },
        },
        {
          timestamp: "2026-01-01T00:00:04.100Z",
          type: "response_item",
          payload: {
            type: "web_search_call",
            id: "same-search",
            status: "failed",
            action: { query: "query" },
          },
        },
        {
          timestamp: "2026-01-01T00:00:04.200Z",
          type: "response_item",
          payload: { type: "web_search_call", status: "pending", action: { query: "fallback" } },
        },
        {
          timestamp: "2026-01-01T00:00:05.000Z",
          type: "event_msg",
          payload: { type: "thread_rolled_back" },
        },
        {
          timestamp: "2026-01-01T00:00:05.100Z",
          type: "event_msg",
          payload: { type: "token_count", info: {} },
        },
        {
          timestamp: "2026-01-01T00:00:05.200Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { total_token_usage: { input_tokens: 1, total_tokens: 1 } },
          },
        },
        {
          timestamp: "2026-01-01T00:00:06.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-fallbacks" },
        },
      ]),
    });

    const turn = result.session?.turns[0];
    expect(turn).toMatchObject({
      startedAt: "2026-01-01T00:00:00.500Z",
      models: ["gpt-retained"],
      reasoningEfforts: ["high"],
      tokenDelta: null,
    });
    expect(turn?.userMessage).toMatchObject({
      sourceMarkdown: "Duplicate user",
      rawEventIds: ["raw-400", "raw-500"],
    });
    expect(turn?.steeringMessages).toEqual([
      expect.objectContaining({
        sourceMarkdown: "Reverse duplicate",
        rawEventIds: ["raw-600", "raw-700"],
      }),
    ]);
    expect(turn?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "reasoning", summary: "", encrypted: true }),
        expect.objectContaining({ kind: "web_search", id: "web-same-search", status: "failed" }),
        expect.objectContaining({ kind: "web_search", query: "fallback", status: "pending" }),
        expect.objectContaining({ kind: "status", message: "Rolled back 0 turns." }),
      ]),
    );
  });

  it("attaches an unscoped unknown event to a synthetic turn", () => {
    const result = normalizeSession({
      sourcePath: "unknown-only.jsonl",
      scope: "active",
      sessionIndexEntries: [],
      stateSnapshot: null,
      records: jsonlRecords([
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "12121212-1212-4212-8212-121212121212" },
        },
        {
          timestamp: "2026-01-01T00:00:01.000Z",
          type: "future_event",
          payload: { value: 1 },
        },
      ]),
    });

    expect(result.session?.turns).toEqual([
      expect.objectContaining({
        id: "12121212-1212-4212-8212-121212121212:turn-0",
        userMessage: null,
        activities: [expect.objectContaining({ kind: "unknown", eventType: "future_event" })],
      }),
    ]);
  });
});
