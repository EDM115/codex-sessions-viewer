import { describe, expect, it } from "vitest";

import { JsonlStreamParser, type JsonlRecord } from "../../../server/ingestion/jsonlStream.ts";
import {
  createSessionNormalizer,
  normalizeSession,
} from "../../../server/normalization/normalizeSession.ts";

function records(payloads: unknown[]): JsonlRecord[] {
  const result: JsonlRecord[] = [];
  const parser = new JsonlStreamParser({ onRecord: (record) => result.push(record) });
  const bytes = Buffer.from(payloads.map((record) => JSON.stringify(record)).join("\n") + "\n");
  parser.write(bytes, 0);
  return result;
}
const event = (payload: unknown) => ({
  timestamp: "2026-09-14T10:00:00.000Z",
  type: "event_msg",
  payload,
});
const response = (payload: unknown) => ({
  timestamp: "2026-09-14T10:00:01.000Z",
  type: "response_item",
  payload,
});
const meta = {
  type: "session_meta",
  payload: { id: "11111111-1111-4111-8111-111111111111", timestamp: "2026-09-14T10:00:00.000Z" },
};
const settings = {
  sourcePath: "C:/fixtures/memo.jsonl",
  scope: "active" as const,
  sessionIndexEntries: [],
  stateSnapshot: null,
  revision: "fixture",
};

describe("source-owned normalization memo", () => {
  it("reuses stable turns while late tool results and web results update their original earlier turn", () => {
    const all = records([
      meta,
      event({ type: "task_started", turn_id: "stable" }),
      event({ type: "user_message", message: "A stable prompt" }),
      event({ type: "task_complete", turn_id: "stable" }),
      event({ type: "task_started", turn_id: "origin" }),
      event({ type: "user_message", message: "Start both activities" }),
      response({
        type: "function_call",
        call_id: "late-tool",
        name: "read_file",
        arguments: '{"path":"one.txt"}',
      }),
      response({
        type: "web_search_call",
        id: "late-web",
        action: { query: "first query" },
        status: "in_progress",
      }),
      event({ type: "task_complete", turn_id: "origin" }),
      event({ type: "task_started", turn_id: "next" }),
      event({ type: "user_message", message: "Continue with a different prompt" }),
      response({
        type: "function_call_output",
        call_id: "late-tool",
        output: '{"content":"late output"}',
      }),
      event({
        type: "web_search_end",
        call_id: "late-web",
        results: [{ id: "result-1" }, { id: "result-2" }],
      }),
    ]);
    const normalize = createSessionNormalizer();
    const before = normalize({ ...settings, records: all.slice(0, 11) }).session!;
    const after = normalize({ ...settings, records: all }).session!;
    expect(after).toEqual(normalizeSession({ ...settings, records: all }).session);
    expect(after.turns[0]).toBe(before.turns[0]);
    expect(after.turns[1]).not.toBe(before.turns[1]);
    expect(after.turns[1]?.activities.find(({ kind }) => kind === "tool")).toMatchObject({
      status: "succeeded",
      output: { content: "late output" },
    });
    expect(after.turns[1]?.activities.find(({ kind }) => kind === "web_search")).toMatchObject({
      status: "succeeded",
      resultCount: 2,
      query: "first query",
    });
    expect(before.turns[1]?.activities.find(({ kind }) => kind === "web_search")).toMatchObject({
      resultCount: null,
    });
  });

  it("invalidates same-offset replacement records and provisional turn renames", () => {
    const normalize = createSessionNormalizer();
    const first = records([meta, event({ type: "user_message", message: "Before" })]);
    const before = normalize({ ...settings, records: first }).session!;
    const replacement = records([meta, event({ type: "user_message", message: "After!" })]);
    const replaced = normalize({ ...settings, records: replacement }).session!;
    expect(replaced.turns[0]?.userMessage?.sourceMarkdown).toBe("After!");
    expect(replaced).toEqual(normalizeSession({ ...settings, records: replacement }).session);
    expect(before.turns[0]?.userMessage?.sourceMarkdown).toBe("Before");
    const renamed = records([
      meta,
      event({ type: "user_message", message: "After!" }),
      event({ type: "task_started", turn_id: "named-turn" }),
    ]);
    const renamedSession = normalize({ ...settings, records: renamed }).session!;
    expect(renamedSession.turns).toMatchObject([
      {
        id: "named-turn",
        sourceTurnId: "named-turn",
        userMessage: { turnId: "named-turn", sourceMarkdown: "After!" },
      },
    ]);
    expect(renamedSession.rawEvents.slice(1).map(({ turnId }) => turnId)).toEqual([
      "named-turn",
      "named-turn",
    ]);
  });
});
