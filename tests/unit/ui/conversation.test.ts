import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import ConversationInspector from "../../../app/components/conversation/ConversationInspector.vue";
import ConversationMessage from "../../../app/components/conversation/ConversationMessage.vue";
import ConversationTurn from "../../../app/components/conversation/ConversationTurn.vue";
import { formatDuration } from "../../../app/components/conversation/format.ts";
import TurnMinimap from "../../../app/components/conversation/TurnMinimap.vue";
import type {
  ConversationMessage as Message,
  ConversationTurn as Turn,
  TurnNavigatorItem,
} from "../../../shared/types/conversation.ts";
import type { InspectorRecord } from "../../../shared/types/repository.ts";

function message(id: string, role: "assistant" | "user", sourceMarkdown: string): Message {
  return {
    id,
    turnId: "turn-1",
    role,
    phase: role === "assistant" ? "final" : null,
    createdAt: "2026-08-15T09:00:00.000Z",
    sourceMarkdown,
    body: { type: "document", children: [{ type: "text", text: sourceMarkdown }] },
    attachmentIds: [],
    rawEventIds: [`event-${id}`],
  };
}

function turn(): Turn {
  return {
    id: "turn-1",
    sourceTurnId: "source-turn-1",
    sessionId: "session-1",
    index: 0,
    userMessage: message("user-1", "user", "Please inspect the parser."),
    assistantMessages: [message("assistant-1", "assistant", "The parser is ready.")],
    activities: [
      {
        id: "reasoning-1",
        turnId: "turn-1",
        kind: "reasoning",
        createdAt: "2026-08-15T09:00:01.000Z",
        rawEventIds: ["event-reasoning"],
        summary: "Inspect the event shapes.",
        body: null,
        encrypted: false,
      },
      {
        id: "tool-1",
        turnId: "turn-1",
        kind: "tool",
        createdAt: "2026-08-15T09:00:02.000Z",
        rawEventIds: ["event-tool"],
        namespace: "filesystem",
        name: "read_file",
        callId: "call-1",
        status: "failed",
        startedAt: "2026-08-15T09:00:02.000Z",
        completedAt: "2026-08-15T09:00:02.250Z",
        durationMs: 250,
        input: { path: "README.md" },
        output: null,
        error: "Access denied",
      },
      {
        id: "unknown-1",
        turnId: "turn-1",
        kind: "unknown",
        createdAt: null,
        rawEventIds: ["event-unknown"],
        eventType: "future_payload",
        payload: { secret: "protocol-only" },
      },
    ],
    startedAt: "2026-08-15T09:00:00.000Z",
    completedAt: "2026-08-15T09:00:03.000Z",
    durationMs: 3_000,
    timeToFirstTokenMs: 400,
    tokenDelta: null,
    models: ["gpt-5"],
    reasoningEfforts: ["high"],
    toolCounts: { "filesystem/read_file": 1 },
    diagnosticIds: [],
  };
}

describe("conversation presentation", () => {
  it("carries rounded seconds into the next minute", () => {
    expect(formatDuration(3_599_600)).toBe("60m 0s");
  });

  it("separates user and assistant prose while keeping protocol-only events out of the timeline", () => {
    const wrapper = mount(ConversationTurn, {
      props: {
        turn: turn(),
        reasoningDefault: "expanded",
        toolCallsDefault: "collapsed",
        timestampFormat: "absolute",
      },
    });

    expect(wrapper.get(".conversation-message--user").text()).toContain(
      "Please inspect the parser.",
    );
    expect(wrapper.get(".conversation-message--assistant").text()).toContain(
      "The parser is ready.",
    );
    expect(wrapper.get('[data-activity-group="reasoning"]').attributes()).toHaveProperty("open");
    expect(wrapper.get('[data-activity-group="work"]').attributes()).not.toHaveProperty("open");
    expect(wrapper.text()).toContain("filesystem/read_file");
    expect(wrapper.text()).toContain("Access denied");
    expect(wrapper.text()).not.toContain("protocol-only");
  });

  it("preserves the selected assistant message as the Info target", async () => {
    const wrapper = mount(ConversationTurn, {
      props: {
        turn: turn(),
        reasoningDefault: "collapsed",
        toolCallsDefault: "collapsed",
        timestampFormat: "absolute",
      },
    });

    await wrapper.get('button[aria-label="Open message info"]').trigger("click");

    expect(wrapper.emitted("inspect")).toEqual([[{ type: "message", id: "assistant-1" }]]);
  });

  it("copies assistant prose by default and exposes full agent work from the split menu", async () => {
    const writeText = vi.fn<() => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const assistant = message("assistant-1", "assistant", "The parser is ready.");
    const wrapper = mount(ConversationMessage, {
      props: {
        message: assistant,
        timestampFormat: "absolute",
        durationMs: 3_000,
        agentWork: "Inspect the event shapes.\n\nThe parser is ready.",
      },
    });

    await wrapper.get('button[aria-label="Copy assistant message"]').trigger("click");
    expect(writeText).toHaveBeenCalledWith("The parser is ready.");
    expect(wrapper.get('button[aria-label="Assistant copy options"]')).toBeTruthy();
    await wrapper.get('button[aria-label="Assistant copy options"]').trigger("click");
    await wrapper.get('[role="menuitem"]').trigger("click");
    expect(writeText).toHaveBeenLastCalledWith("Inspect the event shapes.\n\nThe parser is ready.");
  });

  it("navigates minimap markers with the keyboard and emits exact turn selections", async () => {
    const buckets = [1, 2, 3] as const;
    const items: TurnNavigatorItem[] = Array.from({ length: 3 }, (_, index) => ({
      turnId: `turn-${index}`,
      index,
      userMessageId: `user-${index}`,
      promptPreview: `Prompt ${index}`,
      assistantPreview: `Assistant ${index}`,
      proseLengthBucket: buckets[index],
      createdAt: null,
    }));
    const wrapper = mount(TurnMinimap, {
      attachTo: document.body,
      props: { items, currentTurnId: "turn-0" },
    });
    const first = wrapper.get('button[data-turn-id="turn-0"]');

    expect(first.attributes("aria-current")).toBe("true");
    await first.trigger("keydown", { key: "End" });
    expect(wrapper.emitted("select")?.at(-1)).toEqual(["turn-2"]);
    expect(document.activeElement).toBe(wrapper.get('button[data-turn-id="turn-2"]').element);
    wrapper.unmount();
  });

  it("exposes complete inspector metadata and preserved protocol records", () => {
    const record: InspectorRecord = {
      sessionId: "session-1",
      target: { type: "message", id: "assistant-1" },
      models: ["gpt-5"],
      reasoningEfforts: ["high"],
      phase: "final",
      createdAt: "2026-08-15T09:00:00.000Z",
      completedAt: "2026-08-15T09:00:03.000Z",
      durationMs: 3_000,
      timeToFirstTokenMs: 400,
      tokenDelta: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 8,
        reasoningOutputTokens: 3,
        totalTokens: 21,
      },
      toolCounts: { "filesystem/read_file": 1 },
      activityIds: ["reasoning-1", "tool-1"],
      eventIds: ["event-assistant-1"],
      diagnosticIds: ["diagnostic-1"],
      rawRecords: [{ type: "future_payload", value: 7 }],
    };
    const wrapper = mount(ConversationInspector, {
      props: { record, loading: false, error: null },
    });

    expect(wrapper.text()).toContain("gpt-5");
    expect(wrapper.text()).toContain("TTFT");
    expect(wrapper.text()).toContain("filesystem/read_file");
    expect(wrapper.text()).toContain("reasoning-1");
    expect(wrapper.text()).toContain("event-assistant-1");
    expect(wrapper.text()).toContain("diagnostic-1");
    expect(wrapper.get("pre").text()).toContain("future_payload");
  });

  it("moves focus into the Info surface and closes it with Escape", async () => {
    const wrapper = mount(ConversationInspector, {
      attachTo: document.body,
      props: { record: null, loading: true, error: null },
    });

    expect(document.activeElement).toBe(wrapper.get('[role="dialog"]').element);
    await wrapper.get('[role="dialog"]').trigger("keydown", { key: "Escape" });
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });
});
