import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { JsonlStreamParser, type JsonlRecord } from "../../../server/ingestion/jsonlStream.ts";
import { normalizeSession } from "../../../server/normalization/normalizeSession.ts";
import {
  conversationSummarySchema,
  conversationTurnSchema,
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
        sourceMarkdown: "The parser is ready.",
      }),
    ]);
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
});
