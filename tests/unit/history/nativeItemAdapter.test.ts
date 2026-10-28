import { describe, expect, it } from "vitest";

import {
  adaptCoreTurnItem,
  adaptNativeThreadItem,
  adaptGuardianReviewEnvelope,
} from "../../../server/history/nativeItemAdapter.ts";
import { classifyCatalogThread } from "../../../server/metadata/threadClassification.ts";

describe("native and canonical item boundaries", () => {
  it("normalizes Core rolloutIds to native threadIds for cited assistant messages while retaining original evidence", () => {
    const entries = [{ path: "MEMORY.md", lineStart: 4, lineEnd: 8, note: "source evidence" }];
    const canonical = {
      type: "AgentMessage",
      id: "cited",
      content: [{ type: "Text", text: "Cited answer" }],
      phase: "final_answer",
      memory_citation: { entries, rolloutIds: ["original-rollout"] },
    };
    const native = {
      type: "agentMessage",
      id: "cited",
      text: "Cited answer",
      phase: "final_answer",
      memoryCitation: { entries, threadIds: ["original-rollout"] },
    };
    const coreResult = adaptCoreTurnItem(canonical);
    const nativeResult = adaptNativeThreadItem(native);
    expect(coreResult).toMatchObject({
      type: "agentMessage",
      memoryCitation: { entries, threadIds: ["original-rollout"] },
      evidence: canonical,
    });
    expect(nativeResult).toMatchObject({
      type: "agentMessage",
      memoryCitation: { entries, threadIds: ["original-rollout"] },
      evidence: native,
    });
    expect({ ...coreResult, evidence: null }).toEqual({ ...nativeResult, evidence: null });
    expect(
      adaptCoreTurnItem({ ...canonical, memory_citation: { entries, rolloutIds: [42] } }),
    ).toBeNull();
    expect(
      adaptNativeThreadItem({
        ...native,
        memoryCitation: { entries: [{ ...entries[0], lineStart: -1 }], threadIds: [] },
      }),
    ).toBeNull();
  });
  it("converts substantive message and reasoning fields without conflating source families", () => {
    expect(
      adaptCoreTurnItem(
        {
          type: "AgentMessage",
          id: "answer",
          content: [
            { type: "Text", text: "alpha" },
            { type: "Text", text: " beta" },
          ],
          phase: "final_answer",
        },
        { completed_at_ms: 0 },
      ),
    ).toMatchObject({
      id: "answer",
      type: "agentMessage",
      text: "alpha beta",
      phase: "final_answer",
      completedAtMs: null,
    });
    expect(
      adaptCoreTurnItem({
        type: "Reasoning",
        id: "r",
        summary_text: ["summary"],
        raw_content: ["detail"],
      }),
    ).toMatchObject({ type: "reasoning", summary: ["summary"], content: ["detail"] });
    expect(
      adaptNativeThreadItem({ type: "AgentMessage", id: "wrong-family", content: [] }),
    ).toBeNull();
    expect(
      adaptCoreTurnItem({
        type: "AgentMessage",
        id: "invalid",
        content: [{ type: "Text", text: 23 }],
      }),
    ).toBeNull();
  });

  it("retains command arguments, duration and canonical call identities without fabricating output", () => {
    const item = adaptCoreTurnItem({
      type: "CommandExecution",
      id: "cmd-17",
      command: ["echo", "a b"],
      cwd: "/project",
      parsed_cmd: [],
      source: "agent",
      status: "completed",
      aggregated_output: "a b\n",
      exit_code: 0,
      duration: { secs: 2, nanos: 125_000_000 },
    });
    expect(item).toMatchObject({
      id: "cmd-17",
      type: "commandExecution",
      commandArgs: ["echo", "a b"],
      durationMs: 2125,
      status: "completed",
      output: "a b\n",
    });
    expect(
      adaptNativeThreadItem({
        type: "commandExecution",
        id: "cmd-17",
        command: "echo 'a b'",
        cwd: "/project",
        commandActions: [],
        status: "completed",
        exitCode: 0,
        durationMs: 2125,
      }),
    ).toMatchObject({ id: "cmd-17", output: null });
  });

  it("preserves file, MCP, dynamic and collaboration evidence and rejects malformed variants", () => {
    expect(
      adaptCoreTurnItem({
        type: "FileChange",
        id: "f",
        changes: { "/file": { type: "add", content: "hello" } },
        status: "completed",
      }),
    ).toMatchObject({
      type: "fileChange",
      changes: [{ path: "/file", kind: "add", content: "hello" }],
    });
    expect(
      adaptCoreTurnItem({
        type: "McpToolCall",
        id: "m",
        server: "s",
        tool: "lookup",
        arguments: { key: "a" },
        status: "completed",
        result: { content: [{ type: "text", text: "result" }] },
        duration: { secs: 0, nanos: 500_000_000 },
      }),
    ).toMatchObject({
      type: "mcpToolCall",
      id: "m",
      durationMs: 500,
      result: { content: [{ type: "text", text: "result" }] },
    });
    expect(
      adaptCoreTurnItem({
        type: "DynamicToolCall",
        id: "d",
        tool: "lookup",
        arguments: {},
        status: "failed",
        content_items: [],
        success: false,
      }),
    ).toMatchObject({ type: "dynamicToolCall", id: "d", success: false });
    expect(
      adaptCoreTurnItem({
        type: "CollabAgentToolCall",
        id: "c",
        tool: "spawn_agent",
        status: "completed",
        sender_thread_id: "parent",
        receiver_thread_ids: ["child"],
        agents_states: { child: { completed: "done" } },
      }),
    ).toMatchObject({
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      senderThreadId: "parent",
      receiverThreadIds: ["child"],
      agentsStates: { child: { status: "completed", message: "done" } },
    });
    expect(
      adaptCoreTurnItem({
        type: "SubAgentActivity",
        id: "s",
        kind: "spawn",
        agent_thread_id: "child",
        agent_path: "/root/child",
      }),
    ).toMatchObject({ type: "subAgentActivity", agentThreadId: "child", agentPath: "/root/child" });
    expect(
      adaptNativeThreadItem({
        type: "dynamicToolCall",
        id: "d",
        tool: 5,
        arguments: {},
        status: "completed",
      }),
    ).toBeNull();
  });

  it("keeps separate network and stdin approval identities without inventing a persisted item", () => {
    const review = adaptGuardianReviewEnvelope({
      threadId: "t",
      turnId: "turn",
      reviewId: "review",
      targetItemId: null,
      startedAtMs: 1000,
      completedAtMs: 2000,
      review: { status: "approved", riskLevel: "low", rationale: "allowed" },
      action: { type: "network", approvalId: "action" },
    });
    expect(review).toMatchObject({
      reviewId: "review",
      targetItemId: null,
      targetTurnId: "turn",
      parentThreadId: "t",
      outcome: "allow",
      reviewedAction: { type: "network", approvalId: "action" },
    });
    expect(
      adaptNativeThreadItem({ type: "guardianApprovalReview", id: "invented", review }),
    ).toBeNull();
  });

  it("adapts actual canonical file moves and camelCase MCP context to the same presentation as native items", () => {
    expect(
      adaptCoreTurnItem({
        type: "FileChange",
        id: "move",
        changes: { "/old": { type: "update", unified_diff: "@@ changed", move_path: "/new" } },
        status: "completed",
      }),
    ).toMatchObject({
      changes: [
        { path: "/old", kind: "update", movePath: "/new", diff: "@@ changed\n\nMoved to: /new" },
      ],
    });
    expect(
      adaptCoreTurnItem({
        type: "McpToolCall",
        id: "m",
        server: "server",
        tool: "tool",
        arguments: {},
        status: "completed",
        connectorId: "connector",
        appName: "App",
        linkId: "link",
        mcpAppResourceUri: "ui://resource",
        actionName: "Lookup",
      }),
    ).toMatchObject({
      appContext: {
        connectorId: "connector",
        appName: "App",
        linkId: "link",
        resourceUri: "ui://resource",
        actionName: "Lookup",
      },
    });
  });

  it("converts actual user-input image, audio and rich-text marker fields instead of flattening them into text", () => {
    const core = adaptCoreTurnItem({
      type: "UserMessage",
      id: "u",
      content: [
        {
          type: "text",
          text: "image",
          text_elements: [{ byte_range: { start: 0, end: 5 }, placeholder: "image" }],
        },
        { type: "image", image_url: "https://example.test/image" },
        { type: "audio", audio_url: "data:audio/wav;base64,AA==" },
        { type: "local_image", path: "/image.png" },
      ],
    });
    expect(core).toMatchObject({
      content: [
        {
          type: "text",
          text: "image",
          text_elements: [{ byteRange: { start: 0, end: 5 }, placeholder: "image" }],
        },
        { type: "image", url: "https://example.test/image", detail: null },
        { type: "audio", url: "data:audio/wav;base64,AA==" },
        { type: "localImage", path: "/image.png", detail: null },
      ],
    });
    expect(
      adaptNativeThreadItem({
        type: "userMessage",
        id: "bad",
        content: [{ type: "text", text: 42 }],
      }),
    ).toBeNull();
  });

  it("retains observed mixed subAgent.thread_spawn.agent_role with explicit field precedence", () => {
    const source = {
      subAgent: {
        thread_spawn: {
          parent_thread_id: "parent",
          agent_path: "/root/a",
          agent_nickname: "A",
          agent_role: "worker",
        },
      },
    };
    expect(classifyCatalogThread({ source })).toMatchObject({
      visibility: "delegated-child",
      agentRole: "worker",
    });
    expect(classifyCatalogThread({ source, agentRole: "explicit" }).agentRole).toBe("explicit");
  });
});
