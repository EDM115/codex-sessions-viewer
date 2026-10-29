import { describe, expect, it } from "vitest";

import { adaptNativeThreadItem } from "../../../server/history/nativeItemAdapter.ts";
import { normalizeSession } from "../../../server/normalization/normalizeSession.ts";
import { historyWindowPresentation } from "../../../shared/timeline/historyPresentation.ts";
import type { JsonObject, JsonValue } from "../../../shared/types/conversation.ts";
import type { HistoryTurnWindow } from "../../../shared/types/history.ts";

describe("source-qualified outcomes on both active consumers", () => {
  it.each([
    ["inspect", [{ type: "input_text", text: "Tool request failed" }], null, "unknown"],
    ["inspect", null, null, "unknown"],
    ["inspect", '{"Ok":{"isError":true}}', null, "unknown"],
    [
      "inspect",
      { Ok: { isError: true, content: [{ type: "text", text: "denied" }] } },
      null,
      "failed",
    ],
    ["inspect", [{ type: "input_text", text: "failure prose" }], "completed", "succeeded"],
    ["inspect", { exit_code: 7 }, null, "unknown"],
    ["exec_command", { exit_code: 7, output: "failure" }, null, "failed"],
    ["exec_command", { exit_code: 0, output: "success" }, null, "succeeded"],
  ] satisfies Array<[string, JsonValue, string | null, string]>)(
    "preserves independently expected %s outcome %#",
    (name, output, status, expected) => {
      const call: JsonObject = {
        type: "response_item",
        payload: {
          type: "function_call",
          namespace: "functions",
          name,
          call_id: "provider-call",
          arguments: "{}",
        },
      };
      const result: JsonObject = {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "provider-call",
          output,
          ...(status ? { status } : {}),
        },
      };
      const values: JsonObject[] = [
        { type: "session_meta", payload: { id: "stable" } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
        { type: "event_msg", payload: { type: "user_message", message: "inspect" } },
        call,
        result,
      ];
      const legacy = normalizeSession({
        sourcePath: "C:/fixture/source.jsonl",
        scope: "active",
        sessionIndexEntries: [],
        stateSnapshot: null,
        records: values.map((value, index) => ({
          lineNumber: index + 1,
          byteStart: index * 100,
          byteEnd: index * 100 + 100,
          raw: JSON.stringify(value),
          value,
        })),
      }).session!;
      const a = adaptNativeThreadItem({
        type: "dynamicToolCall",
        id: "raw-call",
        namespace: "functions",
        tool: name,
        arguments: {},
        status: "inProgress",
      })!;
      const b = adaptNativeThreadItem({
        type: "functionCallOutput",
        id: "raw-result",
        namespace: "functions",
        name,
        output,
      })!;
      a.evidence = { source: call };
      b.evidence = { source: result };
      const window: HistoryTurnWindow = {
        turnId: "turn",
        physicalRolloutId: "physical",
        order: 0,
        status: "completed",
        startedAt: null,
        completedAt: null,
        durationMs: null,
        opening: { itemId: null, item: null, availability: "absent" },
        items: [a, b].map((item, index) => ({
          physicalRolloutId: "physical",
          ordinal: index,
          updatedAtOrdinal: index,
          detail: "full",
          itemId: item.id,
          item,
        })),
        itemsView: "full",
        beforeCursor: null,
        afterCursor: null,
        loadedRanges: [],
        coverage: { status: "complete", segments: [], gaps: [] },
        finalAnswerItemId: null,
        historyEpoch: "epoch",
        contentRevision: "revision",
      };
      const progressive = historyWindowPresentation("stable", window);
      for (const activities of [
        legacy.turns.flatMap((turn) => turn.activities),
        progressive.activities,
      ]) {
        expect(
          activities.find(
            (activity) => activity.kind === "tool" && activity.callId === "provider-call",
          ),
        ).toMatchObject({
          status: expected,
          output: typeof output === "string" ? { Ok: { isError: true } } : output,
        });
      }
    },
  );
});
