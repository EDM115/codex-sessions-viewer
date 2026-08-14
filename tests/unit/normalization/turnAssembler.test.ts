import { describe, expect, it } from "vitest";

import { parseCodexEvent, type CodexEvent } from "../../../server/normalization/eventSchema.ts";
import { assembleTurnEvents } from "../../../server/normalization/turnAssembler.ts";
import { jsonValueSchema } from "../../../shared/types/conversation.ts";

function event(lineNumber: number, type: string, payload: Record<string, unknown>): CodexEvent {
  const value = jsonValueSchema.parse({
    timestamp: `2026-01-01T10:00:${String(lineNumber).padStart(2, "0")}.000Z`,
    type,
    payload,
  });
  const parsed = parseCodexEvent({
    lineNumber,
    byteStart: lineNumber * 100,
    byteEnd: lineNumber * 100 + 99,
    raw: JSON.stringify(value),
    value,
  });
  if (!parsed.success) {
    throw new Error("Expected turn fixture to parse");
  }
  return parsed.event;
}

describe("turn event assembly", () => {
  it("uses explicit task boundaries and associates response items with the active turn", () => {
    const result = assembleTurnEvents(
      [
        event(1, "session_meta", { id: "session-1" }),
        event(2, "event_msg", { type: "task_started", turn_id: "turn-explicit" }),
        event(3, "response_item", { type: "message", role: "user", content: [] }),
        event(4, "response_item", { type: "function_call", call_id: "call-1", name: "run" }),
        event(5, "event_msg", { type: "task_complete", turn_id: "turn-explicit" }),
        event(6, "event_msg", { type: "agent_message", message: "late duplicate" }),
      ],
      "session-1",
    );

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]).toMatchObject({ id: "turn-explicit", index: 0 });
    expect(result.turns[0]?.events.map(({ event: item }) => item.lineNumber)).toEqual([
      2, 3, 4, 5, 6,
    ]);
    expect(result.unscopedEvents.map(({ lineNumber }) => lineNumber)).toEqual([1]);
  });

  it("renames a provisional prompt turn when a later task-start event supplies its ID", () => {
    const result = assembleTurnEvents(
      [
        event(1, "event_msg", { type: "user_message", message: "prompt" }),
        event(2, "event_msg", { type: "task_started", turn_id: "turn-late" }),
        event(3, "response_item", { type: "message", role: "assistant", content: [] }),
      ],
      "session-1",
    );

    expect(result.turns).toEqual([
      expect.objectContaining({
        id: "turn-late",
        index: 0,
        events: [
          expect.objectContaining({ turnId: "turn-late" }),
          expect.objectContaining({ turnId: "turn-late" }),
          expect.objectContaining({ turnId: "turn-late" }),
        ],
      }),
    ]);
  });

  it("closes an aborted turn and starts a distinct chronological turn for the next prompt", () => {
    const result = assembleTurnEvents(
      [
        event(1, "event_msg", { type: "task_started", turn_id: "turn-aborted" }),
        event(2, "event_msg", { type: "turn_aborted", turn_id: "turn-aborted" }),
        event(3, "event_msg", { type: "user_message", message: "retry" }),
        event(4, "turn_context", { turn_id: "turn-retry", model: "gpt-test" }),
      ],
      "session-1",
    );

    expect(result.turns.map(({ id }) => id)).toEqual(["turn-aborted", "turn-retry"]);
    expect(result.turns[1]?.events.map(({ event: item }) => item.lineNumber)).toEqual([3, 4]);
  });

  it("gives an in-flight steering prompt a distinct viewer ID while retaining the raw turn ID", () => {
    const result = assembleTurnEvents(
      [
        event(1, "event_msg", { type: "task_started", turn_id: "turn-running" }),
        event(2, "event_msg", { type: "user_message", message: "initial prompt" }),
        event(3, "event_msg", { type: "agent_reasoning", text: "still working" }),
        event(4, "event_msg", { type: "user_message", message: "steer the running model" }),
        event(5, "event_msg", { type: "task_complete", turn_id: "turn-running" }),
      ],
      "session-1",
    );

    expect(result.turns).toEqual([
      expect.objectContaining({
        id: "turn-running",
        sourceTurnId: "turn-running",
        events: [
          expect.objectContaining({ turnId: "turn-running" }),
          expect.objectContaining({ turnId: "turn-running" }),
          expect.objectContaining({ turnId: "turn-running" }),
        ],
      }),
      expect.objectContaining({
        id: "turn-running:raw-400",
        sourceTurnId: "turn-running",
        events: [
          expect.objectContaining({ turnId: "turn-running:raw-400" }),
          expect.objectContaining({ turnId: "turn-running:raw-400" }),
        ],
      }),
    ]);
  });

  it("keeps protocol-only records unscoped when no turn is active", () => {
    const result = assembleTurnEvents(
      [
        event(1, "world_state", { full: true, state: {} }),
        event(2, "inter_agent_communication_metadata", { trigger_turn: {} }),
        event(3, "session_meta", { id: "session-1" }),
      ],
      "session-1",
    );

    expect(result.turns).toEqual([]);
    expect(result.unscopedEvents).toHaveLength(3);
  });

  it("honors response-item turn IDs carried in modern passthrough metadata", () => {
    const result = assembleTurnEvents(
      [
        event(1, "response_item", {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "answer" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-metadata" },
        }),
      ],
      "session-1",
    );

    expect(result.turns).toEqual([
      expect.objectContaining({
        id: "turn-metadata",
        events: [expect.objectContaining({ turnId: "turn-metadata" })],
      }),
    ]);
  });
});
