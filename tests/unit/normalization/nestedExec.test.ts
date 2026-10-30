import { describe, expect, it } from "vitest";

import { deriveNestedExecActivities } from "#server/normalization/nestedExec.ts";
import type { ToolActivity } from "#shared/types/conversation.ts";

function outer(input: string, output: ToolActivity["output"] = null): ToolActivity {
  return {
    id: "outer",
    turnId: "t",
    createdAt: null,
    rawEventIds: ["call", "result"],
    kind: "tool",
    namespace: "functions",
    name: "exec",
    callId: "wrapper-call",
    status: "succeeded",
    startedAt: null,
    completedAt: null,
    durationMs: 900,
    input,
    output,
    error: null,
  };
}

describe("Code Mode evidence boundary", () => {
  it.each([
    [
      "const a = await tools.exec_command({cmd:'first'}); const b = await tools.exec_command({cmd:'second'}); text(b); text(a)",
      [
        { exit_code: 7, output: "second" },
        { exit_code: 0, output: "first" },
      ],
    ],
    ["try { await tools.exec_command({cmd:'fails'}) } catch {}", { exit_code: 0 }],
    ["await tools.exec_command({cmd:'unprinted'})", null],
    ["// tools.exec_command({cmd:'comment'})\ntext('tools.exec_command({cmd: 1})')", null],
    ["for (let i=0;i<4;i++) await tools.exec_command({cmd:'loop'})", null],
    [
      "if (false) await tools.apply_patch('*** Begin Patch\\n*** Add File: never\\n+x\\n*** End Patch')",
      null,
    ],
    ["await tools[name]({cmd:'dynamic'})", null],
  ] as const)(
    "retains outer identity and raw script without fabricated children %#",
    (code, output) => {
      const activity = outer(code, output === null ? null : JSON.parse(JSON.stringify(output)));
      expect(deriveNestedExecActivities(activity)).toEqual([activity]);
    },
  );
});
