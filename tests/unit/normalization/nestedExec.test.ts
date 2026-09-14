import { describe, expect, it } from "vitest";

import { deriveNestedExecActivities } from "../../../server/normalization/nestedExec.ts";
import type { ToolActivity } from "../../../shared/types/conversation.ts";

function outer(code: string, output: ToolActivity["output"] = {}): ToolActivity {
  return {
    id: "tool-outer",
    turnId: "turn-1",
    createdAt: "2026-08-16T08:00:00.000Z",
    rawEventIds: ["raw-call", "raw-output"],
    kind: "tool",
    namespace: "functions",
    name: "exec",
    callId: "outer-call",
    status: "succeeded",
    startedAt: "2026-08-16T08:00:00.000Z",
    completedAt: "2026-08-16T08:00:01.000Z",
    durationMs: 1000,
    input: code,
    output,
    error: null,
  };
}

describe("nested functions.exec derivation", () => {
  it("turns an apply_patch constant into structured file-change evidence", () => {
    const code = String.raw`const patch="*** Begin Patch\n*** Update File: C:\\repo\\server\\export\\verifyOutput.ts\n@@\n-old\n+new one\n+new two\n*** End Patch";
text(await tools.apply_patch(patch));`;
    const derived = deriveNestedExecActivities(outer(code));

    expect(derived).toEqual([
      expect.objectContaining({
        kind: "file_change",
        files: [
          expect.objectContaining({
            change: "update",
            path: expect.stringMatching(/verifyOutput\.ts$/u),
            addedLines: 2,
            removedLines: 1,
            diff: expect.stringContaining("+new two"),
          }),
        ],
      }),
    ]);
  });

  it("turns three Promise.all commands into three individually paired command activities", () => {
    const code = `const results=await Promise.all([
 tools.exec_command({cmd:"pnpm exec vitest run --project node tests/unit/export/verifyOutput.test.ts",workdir:"C:\\repo",yield_time_ms:30000}),
 tools.exec_command({cmd:"pnpm verify:output --output .tmp/task12",workdir:"C:\\repo",yield_time_ms:30000}),
 tools.exec_command({cmd:"pnpm run doctor -- --codex-home tests/fixtures",workdir:"C:\\repo",yield_time_ms:30000})
]);`;
    const derived = deriveNestedExecActivities(
      outer(code, [
        { gate: "focused", exit_code: 0, output: "passed", wall_time_seconds: 1.5 },
        { gate: "verify", exit_code: 0, output: "verified", wall_time_seconds: 2 },
        { gate: "doctor", exit_code: 1, output: "failed", wall_time_seconds: 0.5 },
      ]),
    );

    expect(derived.map(({ kind }) => kind)).toEqual(["tool", "tool", "tool"]);
    expect(derived.map((activity) => (activity.kind === "tool" ? activity.input : null))).toEqual([
      expect.objectContaining({ cmd: expect.stringContaining("verifyOutput.test.ts") }),
      expect.objectContaining({ cmd: expect.stringContaining("verify:output") }),
      expect.objectContaining({ cmd: expect.stringContaining("doctor") }),
    ]);
    expect(derived).toMatchObject([
      {
        kind: "tool",
        name: "exec_command",
        status: "succeeded",
        output: { gate: "focused", output: "passed", exit_code: 0, wall_time_seconds: 1.5 },
        durationMs: 1500,
      },
      {
        kind: "tool",
        name: "exec_command",
        status: "succeeded",
        output: { gate: "verify", output: "verified", exit_code: 0, wall_time_seconds: 2 },
        durationMs: 2000,
      },
      {
        kind: "tool",
        name: "exec_command",
        status: "failed",
        output: { gate: "doctor", output: "failed", exit_code: 1, wall_time_seconds: 0.5 },
        durationMs: 500,
      },
    ]);
  });

  it("supports created, moved, and deleted files and falls back losslessly on dynamic or mismatched envelopes", () => {
    const patch =
      "*** Begin Patch\n*** Add File: created.ts\n+export const ready = true;\n*** Delete File: old.ts\n*** Update File: before.ts\n*** Move to: after.ts\n@@\n-old\n+new\n*** End Patch";
    const derived = deriveNestedExecActivities(
      outer(`text(await tools.apply_patch(${JSON.stringify(patch)}));`),
    );
    expect(derived[0]).toMatchObject({
      kind: "file_change",
      files: [
        expect.objectContaining({ change: "add", path: "created.ts" }),
        expect.objectContaining({ change: "delete", path: "old.ts" }),
        expect.objectContaining({ change: "move", path: "after.ts", previousPath: "before.ts" }),
      ],
    });

    const dynamic = outer("text(await tools.apply_patch(buildPatch()));");
    expect(deriveNestedExecActivities(dynamic)).toEqual([dynamic]);
    const mismatched = outer(
      "await Promise.all([tools.exec_command({cmd:'one'}), tools.exec_command({cmd:'two'})]);",
      [{ exit_code: 0 }],
    );
    expect(deriveNestedExecActivities(mismatched)).toEqual([mismatched]);
  });
});
