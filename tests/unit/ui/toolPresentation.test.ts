import { describe, expect, it } from "vitest";

import {
  boundedJson,
  groupLabel,
  statusLabel,
  toolPresentation,
  subagentLabel,
  toolOutput,
} from "../../../app/components/conversation/toolPresentation.ts";
import type { ToolActivity } from "../../../shared/types/conversation.ts";
function tool(name: string, namespace: string | null = null): ToolActivity {
  return {
    kind: "tool",
    id: name,
    turnId: "t",
    createdAt: null,
    rawEventIds: [],
    name,
    namespace,
    callId: null,
    status: "succeeded",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    input: { cmd: "node check.js" },
    output: null,
    error: null,
  };
}
describe("semantic tool presentation", () => {
  it("matches exact canonical families and preserves unfamiliar qualified identity", () => {
    expect(toolPresentation(tool("exec_command", "functions"))).toMatchObject({
      category: "shell",
      label: "Ran command",
    });
    expect(toolPresentation(tool("functions.exec_command"))).toMatchObject({ category: "shell" });
    expect(toolPresentation(tool("exec_command", "different_app"))).toMatchObject({
      category: "other",
      rawName: "different_app/exec_command",
    });
    for (const [name, namespace, category] of [
      ["read_file", "filesystem", "read"],
      ["search_files", null, "search"],
      ["apply_patch", null, "edit"],
      ["run", "web", "web"],
      ["mcp__calendar__list_events", null, "app"],
      ["spawn_agent", "agents", "agent"],
    ]) {
      expect(toolPresentation(tool(name!, namespace)).category).toBe(category);
    }
  });
  it("does not reinterpret normalized status, including a completed wait", () => {
    for (const [state, label] of [
      ["pending", "Pending"],
      ["running", "Running"],
      ["failed", "Failed"],
      ["cancelled", "Cancelled"],
      ["unknown", "Unknown"],
      ["succeeded", "Success"],
    ] as const) {
      expect(statusLabel(state)).toBe(label);
    }
    expect(toolPresentation(tool("wait_agent", "agents")).label).toBe("Waited for subagents");
  });
  it("describes mixed groups in first-category chronological order", () => {
    expect(groupLabel([tool("apply_patch"), tool("exec_command"), tool("run", "web")])).toBe(
      "Edited files, ran a command, searched the web",
    );
  });
  it("bounds traversed raw data and preserves exact small strings", () => {
    const large = { text: "x".repeat(100_000), neverRead: "secret" };
    expect(boundedJson(large).partial).toBe(true);
    expect(boundedJson(large).text.length).toBeLessThan(17_000);
    expect(boundedJson(large).text).not.toContain("secret");
    expect(boundedJson("one\ntwo")).toEqual({ text: "one\ntwo", partial: false });
  });
  it("classifies simple read/search shell commands without guessing compound programs", () => {
    expect(
      toolPresentation({ ...tool("exec_command"), input: { cmd: "rg parser app" } }).category,
    ).toBe("search");
    expect(
      toolPresentation({ ...tool("exec_command"), input: { cmd: "rg --files app" } }).label,
    ).toBe("Listed files");
    expect(
      toolPresentation({ ...tool("exec_command"), input: { cmd: "Get-Content README.md" } })
        .category,
    ).toBe("read");
    expect(
      toolPresentation({
        ...tool("exec_command"),
        input: { cmd: "cat README.md | node transform.js" },
      }).category,
    ).toBe("shell");
  });
  it("shows explicit named child completion without treating messages as completion", () => {
    const base = {
      kind: "subagent" as const,
      id: "child-event",
      turnId: "t",
      createdAt: null,
      rawEventIds: [],
      status: "succeeded" as const,
      agentId: "/root/reviewer",
      parentThreadId: null,
      childThreadId: "child",
    };
    expect(subagentLabel({ ...base, description: "Ada · completed" })).toBe("Finished Ada");
    expect(subagentLabel({ ...base, description: "Ada · still reviewing" })).toBe(
      "Ada · still reviewing",
    );
    expect(
      toolOutput({
        ...tool("mcp__app__image"),
        output: { content: [{ type: "image", data: "secret encoded payload" }] },
      }),
    ).not.toContain("secret encoded payload");
  });
});
