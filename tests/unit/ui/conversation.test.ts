import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import ConversationActivityList from "../../../app/components/conversation/ConversationActivityList.vue";
import ConversationInspector from "../../../app/components/conversation/ConversationInspector.vue";
import ConversationMessage from "../../../app/components/conversation/ConversationMessage.vue";
import ConversationTurn from "../../../app/components/conversation/ConversationTurn.vue";
import {
  agentWorkText,
  formatDuration,
  formattedJson,
  formatTimestamp,
} from "../../../app/components/conversation/format.ts";
import TurnMinimap from "../../../app/components/conversation/TurnMinimap.vue";
import type {
  ConversationActivity,
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

function activityVariants(): ConversationActivity[] {
  const base = { turnId: "turn-1", createdAt: null, rawEventIds: [] } as const;
  return [
    { ...base, id: "reasoning-empty", kind: "reasoning", summary: "", body: null, encrypted: true },
    {
      ...base,
      id: "web",
      kind: "web_search",
      query: "Nuxt tracing",
      status: "succeeded",
      resultCount: 2,
    },
    { ...base, id: "patch", kind: "patch", status: "failed", patch: "diff", affectedPaths: [] },
    {
      ...base,
      id: "plan",
      kind: "plan",
      status: "running",
      title: null,
      items: [{ step: "Verify", status: "in_progress" }],
    },
    {
      ...base,
      id: "agent",
      kind: "subagent",
      status: "failed",
      agentId: null,
      parentThreadId: null,
      childThreadId: null,
      description: "Review performance",
    },
    { ...base, id: "status", kind: "status", status: "succeeded", message: "Cache ready" },
    { ...base, id: "compact", kind: "compaction", summary: null },
    {
      ...base,
      id: "media",
      kind: "media",
      assetId: "asset-1",
      mediaType: "image",
      reference: {
        kind: "invalid",
        reason: "missing",
        preview: "",
        sourceHash: null,
      },
    },
    { ...base, id: "unknown", kind: "unknown", eventType: "future", payload: null },
  ];
}

describe("conversation presentation", () => {
  it("carries rounded seconds into the next minute", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(999.4)).toBe("999 ms");
    expect(formatDuration(9_500)).toBe("9.5 s");
    expect(formatDuration(10_500)).toBe("11 s");
    expect(formatDuration(3_599_600)).toBe("60m 0s");
  });

  it("formats absolute, relative, unavailable, and JSON values deterministically", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-15T12:00:00.000Z"));
    const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    expect(formatTimestamp(null, "both")).toBe("Time unavailable");
    expect(formatTimestamp("2026-08-15T11:59:40.000Z", "absolute")).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" }).format(
        new Date("2026-08-15T11:59:40.000Z"),
      ),
    );
    expect(formatTimestamp("2026-08-15T11:59:40.000Z", "relative")).toBe(
      relative.format(-20, "second"),
    );
    expect(formatTimestamp("2026-08-15T11:30:00.000Z", "relative")).toBe(
      relative.format(-30, "minute"),
    );
    expect(formatTimestamp("2026-08-15T09:00:00.000Z", "relative")).toBe(
      relative.format(-3, "hour"),
    );
    expect(formatTimestamp("2026-08-13T12:00:00.000Z", "relative")).toBe(
      relative.format(-2, "day"),
    );
    expect(formatTimestamp("2026-08-15T12:00:20.000Z", "both")).toContain(
      `${relative.format(20, "second")} ·`,
    );
    expect(formattedJson("plain")).toBe("plain");
    expect(formattedJson({ nested: true })).toBe('{\n  "nested": true\n}');
  });

  it("renders every known work activity, its fallbacks, statuses, and resize events", async () => {
    const activities = activityVariants();
    const wrapper = mount(ConversationActivityList, {
      props: { activities, reasoningDefault: "expanded", toolCallsDefault: "expanded" },
    });

    expect(wrapper.text()).toContain("Reasoning details unavailable");
    expect(wrapper.text()).toContain("Encrypted source retained");
    expect(wrapper.text()).toContain("Web search · Nuxt tracing");
    expect(wrapper.text()).toContain("Patch · no paths");
    expect(wrapper.text()).toContain("Plan update");
    expect(wrapper.text()).toContain("Agent · Review performance");
    expect(wrapper.text()).toContain("Cache ready");
    expect(wrapper.text()).toContain("Conversation compacted");
    expect(wrapper.text()).toContain("image · asset-1");
    expect(wrapper.text()).not.toContain("future");
    expect(wrapper.findAll(".conversation-work-row.is-failed")).toHaveLength(2);

    const summaries = wrapper.findAll("summary");
    await summaries[0].trigger("pointerdown");
    await summaries[1].trigger("keydown", { key: "Enter" });
    await summaries[1].trigger("toggle");
    expect(wrapper.emitted("beforeResize")).toHaveLength(2);
    expect(wrapper.emitted("resized")).toHaveLength(1);

    const enriched: ConversationActivity[] = activities.map((activity) => {
      if (activity.kind === "patch") {
        return { ...activity, affectedPaths: ["app.vue"] };
      }
      if (activity.kind === "plan") {
        return { ...activity, title: "Release" };
      }
      if (activity.kind === "compaction") {
        return { ...activity, summary: "Earlier context" };
      }
      if (activity.kind === "media") {
        return {
          ...activity,
          reference: {
            kind: "local-file" as const,
            path: "C:/diagram.png",
            provenance: "user-message" as const,
          },
        };
      }
      return activity;
    });
    await wrapper.setProps({ activities: enriched });
    expect(wrapper.text()).toContain("Patch · app.vue");
    expect(wrapper.text()).toContain("Release");
    expect(wrapper.text()).toContain("Earlier context");
    expect(wrapper.text()).toContain("diagram.png");
  });

  it("serializes all agent-work variants while omitting unknown and blank reasoning records", () => {
    const value = turn();
    value.activities = [
      ...activityVariants(),
      {
        id: "tool-2",
        turnId: value.id,
        kind: "tool",
        createdAt: null,
        rawEventIds: [],
        namespace: null,
        name: "read",
        callId: null,
        status: "failed",
        startedAt: null,
        completedAt: null,
        durationMs: null,
        input: "README.md",
        output: { ok: false },
        error: "denied",
      },
      {
        id: "compact-2",
        turnId: value.id,
        kind: "compaction",
        createdAt: null,
        rawEventIds: [],
        summary: "Earlier context",
      },
      {
        id: "media-2",
        turnId: value.id,
        kind: "media",
        createdAt: null,
        rawEventIds: [],
        assetId: "asset-2",
        mediaType: "file",
        reference: {
          kind: "local-file",
          path: "C:/report.txt",
          provenance: "user-message",
        },
      },
    ];
    const text = agentWorkText(value);
    expect(text).toContain("tool/read · failed");
    expect(text).toContain("Input\nREADME.md");
    expect(text).toContain('Output\n{\n  "ok": false\n}');
    expect(text).toContain("Error\ndenied");
    expect(text).toContain("Web search · succeeded");
    expect(text).toContain("Patch · failed");
    expect(text).toContain("Plan\n[in_progress] Verify");
    expect(text).toContain("Agent · failed");
    expect(text).toContain("Status · succeeded");
    expect(text).toContain("Conversation compacted\nEarlier context");
    expect(text).toContain("Media · file\nC:/report.txt");
    expect(text).not.toContain("The parser is ready.");
    expect(text).not.toContain("future");
  });

  it("separates user and assistant prose while keeping protocol-only events out of the timeline", async () => {
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
    expect(wrapper.findAll(".conversation-message--assistant")).toHaveLength(1);
    expect(wrapper.get('[data-activity-group="worked"]').attributes()).not.toHaveProperty("open");
    expect(wrapper.get('[data-activity-group="worked"] summary').text()).toContain(
      "Worked for 3.0 s",
    );
    expect(wrapper.text()).not.toContain("filesystem/read_file");
    expect(wrapper.text()).not.toContain("Access denied");
    expect(wrapper.text()).not.toContain("protocol-only");

    const work = wrapper.get('[data-activity-group="worked"]');
    (work.element as HTMLDetailsElement).open = true;
    await work.trigger("toggle");
    expect(wrapper.text()).toContain("Read file");
    expect(wrapper.text()).toContain("Access denied");
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

  it("centers the minimap preview on the active marker and updates it after scroll", async () => {
    const items: TurnNavigatorItem[] = [
      {
        turnId: "turn-0",
        index: 0,
        userMessageId: "user-0",
        promptPreview: "Prompt zero",
        assistantPreview: "Assistant zero",
        proseLengthBucket: 2,
        createdAt: null,
      },
    ];
    const wrapper = mount(TurnMinimap, {
      attachTo: document.body,
      props: { items, currentTurnId: "turn-0" },
    });
    const nav = wrapper.get(".turn-minimap").element as HTMLElement;
    const marker = wrapper.get(".turn-minimap__marker").element as HTMLElement;
    let markerTop = 172;
    vi.spyOn(nav, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 47,
      top: 47,
      right: 80,
      bottom: 447,
      left: 0,
      width: 80,
      height: 400,
      toJSON: () => undefined,
    });
    vi.spyOn(marker, "getBoundingClientRect").mockImplementation(() => ({
      x: 50,
      y: markerTop,
      top: markerTop,
      right: 80,
      bottom: markerTop + 2,
      left: 50,
      width: 30,
      height: 2,
      toJSON: () => undefined,
    }));

    await wrapper.get('button[data-turn-id="turn-0"]').trigger("focus");
    await wrapper.vm.$nextTick();
    expect(
      (wrapper.get('[role="tooltip"]').element as HTMLElement).style.getPropertyValue(
        "--turn-preview-center",
      ),
    ).toBe("126px");

    markerTop = 232;
    await wrapper.get(".turn-minimap__scroll").trigger("scroll");
    expect(
      (wrapper.get('[role="tooltip"]').element as HTMLElement).style.getPropertyValue(
        "--turn-preview-center",
      ),
    ).toBe("186px");
    wrapper.unmount();
  });

  it("exposes complete inspector metadata and lazily opens preserved protocol records", async () => {
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
    expect(wrapper.find("pre").exists()).toBe(false);
    const raw = wrapper.get(".conversation-inspector__raw");
    (raw.element as HTMLDetailsElement).open = true;
    await raw.trigger("toggle");
    const selected = wrapper.get(".conversation-raw");
    (selected.element as HTMLDetailsElement).open = true;
    await selected.trigger("toggle");
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

  it("renders inspector failure recovery and unavailable metadata fallbacks", async () => {
    const wrapper = mount(ConversationInspector, {
      props: { record: null, loading: false, error: "Metadata read failed" },
    });
    expect(wrapper.text()).toContain("Metadata read failed");
    await wrapper.get("button:not(.ui-icon-button)").trigger("click");
    expect(wrapper.emitted("retry")).toHaveLength(1);
    await wrapper.get('[aria-label="Close message info"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);

    await wrapper.setProps({
      error: null,
      record: {
        sessionId: "session-1",
        target: { type: "turn", id: "turn-1" },
        models: [],
        reasoningEfforts: [],
        phase: null,
        createdAt: null,
        completedAt: null,
        durationMs: null,
        timeToFirstTokenMs: null,
        tokenDelta: null,
        toolCounts: {},
        activityIds: [],
        eventIds: [],
        diagnosticIds: [],
        rawRecords: [],
      },
    });
    expect(wrapper.text()).toContain("Unavailable");
    expect(wrapper.text()).toContain("No tool calls.");
    expect(wrapper.text()).toContain("None");
    expect(wrapper.find("pre").exists()).toBe(false);
  });
});
