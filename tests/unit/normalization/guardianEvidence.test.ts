import { describe, expect, it } from "vitest";

import type { JsonlRecord } from "../../../server/ingestion/jsonlStream.ts";
import {
  matchGuardianEvidence,
  parseGuardianTurn,
} from "../../../server/normalization/guardianEvidence.ts";
import type { ToolActivity } from "../../../shared/types/conversation.ts";

function records(values: JsonlRecord["value"][]): JsonlRecord[] {
  return values.map((value, index) => ({
    lineNumber: index + 1,
    byteStart: index * 100,
    byteEnd: (index + 1) * 100,
    raw: JSON.stringify(value),
    value,
  }));
}

function tool(id: string, input: ToolActivity["input"]): ToolActivity {
  return {
    id,
    turnId: "turn-1",
    createdAt: null,
    rawEventIds: [],
    kind: "tool",
    namespace: null,
    name: "exec_command",
    callId: id,
    status: "succeeded",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    input,
    output: null,
    error: null,
  };
}

describe("guardian approval evidence", () => {
  it("parses the planned action and final allow result without exposing encrypted transcript content", () => {
    const review = parseGuardianTurn(
      records([
        {
          timestamp: "2026-08-16T08:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "guardian-1",
            parent_thread_id: "parent-1",
            source: { subagent: { other: "guardian", parent_thread_id: "parent-1" } },
          },
        },
        {
          timestamp: "2026-08-16T08:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message:
              'Review this command.\nPlanned action JSON:\n{"cmd":"git status","workdir":"C:/repo"}',
          },
        },
        {
          timestamp: "2026-08-16T08:00:02.000Z",
          type: "response_item",
          payload: { type: "reasoning", encrypted_content: "opaque" },
        },
        {
          timestamp: "2026-08-16T08:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "final",
            message:
              '{"risk_level":"low","user_authorization":"requested","outcome":"allow","rationale":"The command is read-only."}',
          },
        },
      ]),
    );

    expect(review).toMatchObject({
      guardianSessionId: "guardian-1",
      parentThreadId: "parent-1",
      reviewedAction: { cmd: "git status", workdir: "C:/repo" },
      outcome: "allow",
      riskLevel: "low",
      rationale: expect.stringContaining("read-only"),
    });
    expect(JSON.stringify(review)).not.toContain("opaque");
  });

  it("matches one exact action, preserves denial, and rejects ambiguous repeated commands", () => {
    const review = {
      reviewedAction: { cmd: "git status", workdir: "C:/repo" },
      outcome: "deny" as const,
      riskLevel: "medium",
      userAuthorization: null,
      rationale: "The command changes state.",
      reviewedAt: null,
      guardianSessionId: "guardian-1",
      parentThreadId: "parent-1",
      rawEventIds: [],
    };
    const exact = tool("tool-a", { workdir: "C:/repo", cmd: "git status" });
    expect(matchGuardianEvidence([exact], [review])).toEqual(
      new Map([["tool-a", expect.objectContaining({ outcome: "deny" })]]),
    );
    expect(
      matchGuardianEvidence(
        [exact, tool("tool-b", { cmd: "git status", workdir: "C:/repo" })],
        [review],
      ),
    ).toEqual(new Map());
    expect(
      parseGuardianTurn(
        records([{ type: "event_msg", payload: { type: "agent_message", message: "{bad" } }]),
      ),
    ).toBeNull();
  });
});
