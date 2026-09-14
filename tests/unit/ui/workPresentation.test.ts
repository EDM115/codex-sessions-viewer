import { flushPromises, mount, type DOMWrapper } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { h } from "vue";

import ConversationInspector from "../../../app/components/conversation/ConversationInspector.vue";
import ConversationMessage from "../../../app/components/conversation/ConversationMessage.vue";
import ConversationRaw from "../../../app/components/conversation/ConversationRaw.vue";
import ConversationTurn from "../../../app/components/conversation/ConversationTurn.vue";
import type {
  ConversationMessage as Message,
  ConversationTurn as Turn,
  ToolActivity,
} from "../../../shared/types/conversation.ts";
import type { ResolvedAsset } from "../../../shared/types/repository.ts";
function message(id: string): Message {
  return {
    id,
    turnId: "t",
    role: "assistant",
    createdAt: "2026-09-14T12:00:00Z",
    phase: null,
    sourceMarkdown: id,
    body: { type: "document", children: [{ type: "text", text: id }] },
    attachmentIds: [],
    rawEventIds: [],
  };
}
function tool(id: string, name = "exec_command"): ToolActivity {
  return {
    id,
    kind: "tool",
    turnId: "t",
    createdAt: null,
    rawEventIds: [],
    namespace: null,
    name,
    callId: id,
    status: "succeeded",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    input: { cmd: `node ${id}` },
    output: { output: `${id} result` },
    error: null,
  };
}
function turn(): Turn {
  return {
    id: "t",
    sourceTurnId: null,
    sessionId: "s",
    index: 0,
    userMessage: null,
    assistantMessages: [message("final")],
    activities: [],
    startedAt: null,
    completedAt: null,
    durationMs: null,
    timeToFirstTokenMs: null,
    tokenDelta: null,
    models: [],
    reasoningEfforts: [],
    toolCounts: {},
    diagnosticIds: [],
  };
}
async function open(details: DOMWrapper<Element>): Promise<void> {
  if (!(details.element instanceof HTMLDetailsElement)) {
    throw new Error("Expected details element");
  }
  details.element.open = true;
  await details.trigger("toggle");
}
const settings = {
  reasoningDefault: "collapsed",
  toolCallsDefault: "collapsed",
  timestampFormat: "absolute",
} as const;
describe("work disclosure and media integration", () => {
  it("groups mixed adjacent successful calls, preserves commentary/failure boundaries, and retains live-append expansion", async () => {
    const value = turn();
    value.assistantMessages.unshift(message("progress"));
    value.activities = [
      tool("a"),
      tool("b", "apply_patch"),
      { ...tool("failure"), status: "failed", error: "Exit 7" },
      tool("c"),
    ];
    value.entryOrder = [
      { kind: "activity", id: "a" },
      { kind: "activity", id: "b" },
      { kind: "message", id: "progress" },
      { kind: "activity", id: "failure" },
      { kind: "activity", id: "c" },
      { kind: "message", id: "final" },
    ];
    const wrapper = mount(ConversationTurn, { props: { ...settings, turn: value } });
    await open(wrapper.get('[data-activity-group="worked"]'));
    expect(wrapper.findAll("[data-tool-group]")).toHaveLength(2);
    expect(wrapper.text()).toContain("Ran a command, edited files");
    expect(wrapper.text()).toContain("Exit 7");
    await open(wrapper.get('[data-tool-group="a"]'));
    expect(wrapper.findAll(".conversation-tool-row__detail-body")).toHaveLength(0);
    await open(wrapper.get('[data-entry-id="a"] details'));
    expect(wrapper.text()).toContain("a result");
    expect(wrapper.text()).not.toContain("b result");
    const next = {
      ...value,
      activities: [...value.activities, tool("d")],
      entryOrder: [
        ...value.entryOrder.slice(0, -1),
        { kind: "activity" as const, id: "d" },
        value.entryOrder.at(-1)!,
      ],
    };
    await wrapper.setProps({ turn: next });
    expect(wrapper.get('[data-tool-group="a"]').attributes()).toHaveProperty("open");
    expect(wrapper.text()).toContain("a result");
  });
  it("does not format raw payloads or agent work until explicit open/copy", async () => {
    const producer = vi.fn<() => string>(() => "complete agent work");
    const writeText = vi.fn<() => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const wrapper = mount(ConversationMessage, {
      props: { message: message("final"), timestampFormat: "absolute", agentWork: producer },
    });
    expect(producer).not.toHaveBeenCalled();
    await wrapper.get('[aria-label="Assistant copy options"]').trigger("click");
    expect(producer).not.toHaveBeenCalled();
    await wrapper.get('[role="menuitem"]').trigger("click");
    expect(producer).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("complete agent work");
    const raw = mount(ConversationRaw, {
      props: { label: "Large output", value: "x".repeat(100_000) },
    });
    expect(raw.find("pre").exists()).toBe(false);
    await open(raw.get("details"));
    expect(raw.get("pre").text().length).toBeLessThan(17_000);
    expect(raw.text()).toContain("Partial preview");
    await raw.get('[aria-label="Copy complete Large output"]').trigger("click");
    expect(writeText).toHaveBeenLastCalledWith("x".repeat(100_000));
  });
  it("forwards cached attachment and reasoning/progress media through the real turn hierarchy", async () => {
    const asset: ResolvedAsset = {
      id: "image",
      url: "/api/assets/image",
      mimeType: "image/png",
      byteSize: 4,
      sha256: null,
      width: 20,
      height: 20,
      status: "available",
      originalPath: "image.png",
    };
    const resolveAsset = vi.fn<(id: string) => Promise<ResolvedAsset>>(async (id) => ({
      ...asset,
      id,
      url: `/api/assets/${id}`,
    }));
    const value = turn();
    const progress = message("progress");
    progress.attachmentIds = ["progress-image"];
    value.assistantMessages.unshift(progress);
    value.activities = [
      {
        id: "r",
        kind: "reasoning",
        turnId: "t",
        createdAt: null,
        rawEventIds: [],
        summary: "diagram",
        encrypted: false,
        body: {
          type: "document",
          children: [
            {
              type: "media",
              mediaType: "image",
              source: "asset",
              assetId: "reasoning-image",
              originalSource: "image.png",
              alt: "reasoning diagram",
              title: null,
            },
          ],
        },
      },
      {
        id: "media",
        kind: "media",
        turnId: "t",
        createdAt: null,
        rawEventIds: [],
        assetId: "activity-image",
        mediaType: "image",
        reference: { kind: "invalid", reason: "missing", preview: "", sourceHash: null },
      },
    ];
    value.entryOrder = [
      { kind: "message", id: "progress" },
      { kind: "activity", id: "r" },
      { kind: "activity", id: "media" },
      { kind: "message", id: "final" },
    ];
    const wrapper = mount(ConversationTurn, { props: { ...settings, turn: value, resolveAsset } });
    await open(wrapper.get('[data-activity-group="worked"]'));
    await flushPromises();
    expect(wrapper.findAll(".rich-media-image")).toHaveLength(3);
    await Promise.all(
      wrapper.findAll(".rich-media-image").map((button) => button.trigger("click")),
    );
    expect(wrapper.emitted("openMedia")).toEqual([
      [expect.objectContaining({ kind: "image", src: "/api/assets/progress-image" })],
      [expect.objectContaining({ kind: "image", src: "/api/assets/reasoning-image" })],
      [expect.objectContaining({ kind: "image", src: "/api/assets/activity-image" })],
    ]);
  });
  it("keeps inspector raw closed and resolves readable related activity selection", async () => {
    const activity = tool("a");
    const wrapper = mount(ConversationInspector, {
      props: {
        error: null,
        loading: false,
        activities: [activity],
        record: {
          sessionId: "s",
          target: { type: "turn", id: "t" },
          models: [],
          reasoningEfforts: [],
          phase: null,
          createdAt: null,
          completedAt: null,
          durationMs: null,
          timeToFirstTokenMs: null,
          tokenDelta: null,
          toolCounts: {},
          activityIds: ["a"],
          eventIds: [],
          diagnosticIds: [],
          rawRecords: [{ huge: "x".repeat(100_000) }],
        },
      },
    });
    expect(wrapper.find("pre").exists()).toBe(false);
    const related = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Ran command"))!;
    await related.trigger("click");
    expect(wrapper.emitted("inspect")).toEqual([[{ type: "activity", id: "a" }]]);
  });
  it("does not visit heavyweight tool output while the work and call group open", async () => {
    let reads = 0;
    const payload = Object.defineProperty({}, "huge", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "x".repeat(100_000);
      },
    });
    const value = turn();
    value.activities = [{ ...tool("large"), output: payload }];
    const wrapper = mount({ render: () => h(ConversationTurn, { ...settings, turn: value }) });
    await open(wrapper.get('[data-activity-group="worked"]'));
    await open(wrapper.get('[data-tool-group="large"]'));
    expect(reads).toBe(0);
    expect(wrapper.findAll(".conversation-tool-row pre")).toHaveLength(0);
    await open(wrapper.get('[data-entry-id="large"] details'));
    expect(reads).toBeGreaterThan(0);
    expect(wrapper.text()).toContain("Partial output preview");
  });
  it("renders standalone user audio and missing attachments with local resolver status", async () => {
    const user = { ...message("user"), role: "user" as const, attachmentIds: ["audio", "missing"] };
    const resolver = async (id: string): Promise<ResolvedAsset> => ({
      id,
      url: id === "audio" ? "/api/assets/audio" : null,
      mimeType: "audio/wav",
      byteSize: null,
      sha256: null,
      width: null,
      height: null,
      status: id === "audio" ? "available" : "missing",
      originalPath: "recording.wav",
    });
    const wrapper = mount(ConversationMessage, {
      props: { message: user, timestampFormat: "absolute", resolveAsset: resolver },
    });
    await flushPromises();
    expect(wrapper.get("audio").attributes("src")).toBe("/api/assets/audio");
    expect(wrapper.text()).toContain("Cached media is unavailable");
  });
});
