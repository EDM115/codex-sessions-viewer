import { describe, expect, it } from "vitest";

import {
  serializeAgentWork,
  serializeAssistantMessage,
  serializeCodeBlock,
  serializeConversation,
  serializeToolActivity,
  serializeUserPrompt,
} from "../../../server/export/serializeMarkdown.ts";
import type { NormalizedSession } from "../../../server/normalization/normalizeSession.ts";
import type {
  ConversationMessage,
  ConversationTurn,
  MediaActivity,
  ToolActivity,
} from "../../../shared/types/conversation.ts";
import type { RichTextCodeNode } from "../../../shared/types/richText.ts";

const timestamp = "2026-08-13T10:00:00.000Z";

function message(role: ConversationMessage["role"], sourceMarkdown: string): ConversationMessage {
  return {
    id: `message-${role}`,
    turnId: "turn-1",
    role,
    phase: role === "assistant" ? "final" : null,
    createdAt: timestamp,
    sourceMarkdown,
    body: { type: "document", children: [{ type: "text", text: sourceMarkdown }] },
    attachmentIds: [],
    rawEventIds: [`event-${role}`],
  };
}

const tool: ToolActivity = {
  id: "activity-tool",
  turnId: "turn-1",
  createdAt: "2026-08-13T10:00:02.000Z",
  rawEventIds: ["event-tool"],
  kind: "tool",
  namespace: "functions",
  name: "shell_command",
  callId: "call-1",
  status: "succeeded",
  startedAt: "2026-08-13T10:00:01.000Z",
  completedAt: "2026-08-13T10:00:02.000Z",
  durationMs: 1_000,
  input: { command: "printf '```'" },
  output: { exitCode: 0 },
  error: null,
};

function turn(): ConversationTurn {
  return {
    id: "turn-1",
    sessionId: "11111111-1111-4111-8111-111111111111",
    index: 0,
    userMessage: message("user", "Inspect `src/index.ts`."),
    assistantMessages: [message("assistant", "Implemented the requested change.")],
    activities: [
      {
        id: "activity-reasoning",
        turnId: "turn-1",
        createdAt: "2026-08-13T10:00:01.000Z",
        rawEventIds: ["event-reasoning"],
        kind: "reasoning",
        summary: "Check the existing boundary first.",
        body: null,
        encrypted: false,
      },
      tool,
      {
        id: "activity-status",
        turnId: "turn-1",
        createdAt: "2026-08-13T10:00:03.000Z",
        rawEventIds: ["event-status"],
        kind: "status",
        status: "succeeded",
        message: "Verification passed.",
      },
      {
        id: "activity-unknown",
        turnId: "turn-1",
        createdAt: "2026-08-13T10:00:04.000Z",
        rawEventIds: ["event-unknown"],
        kind: "unknown",
        eventType: "future_protocol_record",
        payload: { secretProtocolDetail: true },
      },
    ],
    startedAt: timestamp,
    completedAt: "2026-08-13T10:00:05.000Z",
    durationMs: 5_000,
    timeToFirstTokenMs: 500,
    tokenDelta: null,
    models: ["gpt-5.6"],
    reasoningEfforts: ["high"],
    toolCounts: { "functions.shell_command": 1 },
    diagnosticIds: [],
  };
}

describe("Markdown copy serializers", () => {
  it("returns untouched assistant and code source for their primary copy actions", () => {
    const assistant = message("assistant", "Keep  trailing spaces  \n\n```ts\nconst n = 1\n```");
    const code: RichTextCodeNode = {
      type: "code",
      language: "ts",
      title: "index.ts",
      source: "const ticks = '```';\n",
      highlighted: null,
    };

    expect(serializeAssistantMessage(assistant)).toBe(assistant.sourceMarkdown);
    expect(serializeCodeBlock(code)).toBe("const ticks = '```';\n");
  });

  it("copies one user prompt with visible local attachment references and no agent work", () => {
    const prompt = message("user", "Describe this recording.");
    const attachments: MediaActivity[] = [
      {
        id: "media-1",
        turnId: "turn-1",
        createdAt: timestamp,
        rawEventIds: ["event-user"],
        kind: "media",
        assetId: "asset-1",
        mediaType: "audio",
        sourcePath: "C:\\Recordings\\sample.wav",
      },
    ];

    expect(serializeUserPrompt(prompt, attachments)).toBe(
      "Describe this recording.\n\n### Attachments\n\n- [Audio: `C:\\Recordings\\sample.wav`](file:///C:/Recordings/sample.wav)",
    );
  });

  it("serializes tool input and output with a fence longer than transcript backticks", () => {
    const markdown = serializeToolActivity(tool);

    expect(markdown).toContain("<summary>functions.shell_command — succeeded — 1s</summary>");
    expect(markdown).toContain('````json\n{\n  "command": "printf \'```\'"\n}\n````');
    expect(markdown).toContain('```json\n{\n  "exitCode": 0\n}\n```');
  });

  it("copies agent work without the user prompt or protocol-only unknown records", () => {
    const markdown = serializeAgentWork(turn());

    expect(markdown).toContain("Check the existing boundary first.");
    expect(markdown).toContain("functions.shell_command");
    expect(markdown).toContain("Verification passed.");
    expect(markdown).toContain("Implemented the requested change.");
    expect(markdown).not.toContain("Inspect `src/index.ts`.");
    expect(markdown).not.toContain("future_protocol_record");
    expect(markdown).not.toContain("secretProtocolDetail");
  });

  it("serializes a complete conversation with safe YAML metadata and distinct prompt/work sections", () => {
    const conversation: NormalizedSession = {
      summary: {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Export: --- and # headings",
        scope: "archived",
        sourcePath: "C:\\Codex\\rollout.jsonl",
        createdAt: timestamp,
        updatedAt: timestamp,
        cwd: "C:\\Repo",
        gitBranch: "main",
        gitSha: null,
        gitOriginUrl: null,
        models: ["gpt-5.6"],
        reasoningEfforts: ["high"],
        turnCount: 1,
        assistantMessageCount: 1,
        toolCallCount: 1,
        toolCounts: { "functions.shell_command": 1 },
        preview: "Inspect src/index.ts",
        pinned: false,
        sectionName: null,
        parentThreadId: null,
        childThreadIds: [],
        hasMedia: false,
        diagnosticCount: 0,
        revision: "sha256:fixture",
      },
      turns: [turn()],
      rawEvents: [],
    };

    const markdown = serializeConversation(conversation);

    expect(markdown).toMatch(/^---\nid: 11111111-1111-4111-8111-111111111111\n/u);
    expect(markdown).toContain('title: "Export: --- and # headings"');
    expect(markdown).toContain("## Turn 1");
    expect(markdown).toContain("### User prompt");
    expect(markdown).toContain("### Agent work");
    expect(markdown).toContain("Inspect `src/index.ts`.");
  });
});
