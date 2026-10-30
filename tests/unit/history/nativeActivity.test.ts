import { describe, expect, it } from "vitest";

import {
  adaptCoreTurnItem,
  adaptCommandEvent,
  adaptNativeThreadItem,
} from "#server/history/nativeItemAdapter.ts";
import { nativeActivity, historyActivity } from "#shared/timeline/activityPresentation.ts";

const context = { turnId: "turn", sessionId: "thread", rawEventIds: ["original", "update"] };
describe("native activity semantics", () => {
  it("preserves vector/actions/process identity and never invents a call ID from an item ID", () => {
    const item = adaptCoreTurnItem({
      type: "CommandExecution",
      id: "native-command",
      command: ["pwsh", "-Command", "Get-Content file"],
      cwd: "C:/repo",
      parsed_cmd: [{ type: "read", cmd: "Get-Content file", name: "file", path: "file" }],
      process_id: "77",
      source: "agent",
      status: "completed",
      exit_code: 7,
      aggregated_output: "failure",
    })!;
    expect(nativeActivity(item, context)).toMatchObject({
      id: "native-command",
      callId: null,
      nativeItemId: "native-command",
      status: "failed",
      input: { commandArgs: ["pwsh", "-Command", "Get-Content file"], processId: "77" },
      output: "failure",
      presentation: { category: "read", evidenceKind: "native", status: "failed" },
    });
  });
  it("preserves explicit false and unknown dynamic outcomes despite completed lifecycle", () => {
    for (const [success, expected] of [
      [false, "failed"],
      [null, "unknown"],
      [true, "succeeded"],
    ] as const) {
      const item = adaptNativeThreadItem({
        type: "dynamicToolCall",
        id: "dynamic",
        tool: "execute",
        arguments: { path: "x" },
        status: "completed",
        success,
        contentItems: [{ type: "image", url: "image" }],
      })!;
      expect(nativeActivity(item, context)).toMatchObject({
        status: expected,
        output: [{ type: "image", url: "image" }],
        callId: null,
      });
    }
  });
  it("keeps file moves and all child links while distinguishing agent operation completion from child outcome", () => {
    const file = adaptCoreTurnItem({
      type: "FileChange",
      id: "patch",
      status: "completed",
      changes: { "a.ts": { type: "update", unified_diff: "-old\n+new", move_path: "b.ts" } },
    })!;
    expect(nativeActivity(file, context)).toMatchObject({
      kind: "file_change",
      files: [{ path: "b.ts", previousPath: "a.ts", change: "move" }],
      presentation: { category: "edit", evidenceKind: "native" },
    });
    const agents = adaptNativeThreadItem({
      type: "collabAgentToolCall",
      id: "wait",
      tool: "wait",
      status: "completed",
      senderThreadId: "parent",
      receiverThreadIds: ["a", "b"],
      agentsStates: {
        a: { status: "running", message: null },
        b: { status: "failed", message: "failed" },
      },
    })!;
    expect(nativeActivity(agents, context)).toMatchObject({
      kind: "tool",
      status: "succeeded",
      presentation: { category: "agent", childIds: ["a", "b"] },
      output: { a: { status: "running" }, b: { status: "failed" } },
    });
  });
});

it("does not turn missing native command or MCP outcomes into success", () => {
  const command = adaptNativeThreadItem({
    type: "commandExecution",
    id: "missing-command",
    command: "job",
    cwd: "/",
    status: "completed",
    commandActions: [],
  })!;
  const mcp = adaptNativeThreadItem({
    type: "mcpToolCall",
    id: "missing-mcp",
    server: "service",
    tool: "operation",
    arguments: {},
    status: "completed",
  })!;
  expect(nativeActivity(command, context)).toMatchObject({
    status: "unknown",
    output: null,
    durationMs: null,
  });
  expect(nativeActivity(mcp, context)).toMatchObject({
    status: "unknown",
    output: null,
    durationMs: null,
  });
});

it("retains invalid raw timestamps as unknown while preserving the original envelope", () => {
  const item = adaptNativeThreadItem({
    type: "dynamicToolCall",
    id: "raw",
    tool: "read_file",
    arguments: { path: "a" },
    status: "inProgress",
  })!;
  item.evidence = {
    source: {
      type: "response_item",
      timestamp: "invalid",
      payload: {
        type: "function_call",
        call_id: "direct",
        name: "read_file",
        arguments: { path: "a" },
      },
    },
  };
  expect(historyActivity(item, context)).toMatchObject({
    createdAt: null,
    startedAt: null,
    callId: "direct",
    status: "unknown",
    presentation: { evidenceKind: "direct" },
  });
});

it("attributes direct lifecycle records separately from canonical native items", () => {
  const raw = {
    type: "exec_command_end",
    call_id: "direct-command",
    command: ["node", "task"],
    cwd: "/",
    parsed_cmd: [],
    status: "completed",
    exit_code: 0,
    aggregated_output: "done",
  };
  const item = adaptCommandEvent(raw)!;
  expect(item.evidence).toEqual(raw);
  expect(nativeActivity(item, context)).toMatchObject({
    callId: "direct-command",
    nativeItemId: null,
    status: "succeeded",
    presentation: { evidenceKind: "direct", itemId: null, callId: "direct-command" },
  });
});

it("distinguishes complete add/delete content from update diffs and unavailable counters", () => {
  const cases = [
    [{ type: "add", content: "line one\nline two\n" }, 2, 0],
    [{ type: "add", content: "+literal\n-literal\n" }, 2, 0],
    [{ type: "delete", content: "+literal\n-literal\n" }, 0, 2],
    [{ type: "update", unified_diff: "@@ -1,2 +1,1 @@\n-first\n-second\n+replacement\n" }, 1, 2],
    [{ type: "update" }, null, null],
  ] as const;
  for (const [change, addedLines, removedLines] of cases) {
    const item = adaptCoreTurnItem({
      type: "FileChange",
      id: "file",
      status: "completed",
      changes: { "a.txt": change },
    })!;
    expect(nativeActivity(item, context)).toMatchObject({ files: [{ addedLines, removedLines }] });
  }
});
