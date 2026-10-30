import { mountSuspended } from "@nuxt/test-utils/runtime";
import { flushPromises, type DOMWrapper } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import type {
  ConversationMessage as Message,
  ConversationTurn as Turn,
  ToolActivity,
} from "#shared/types/conversation.ts";
import type { ResolvedAsset } from "#shared/types/repository.ts";
import ConversationInspector from "~/components/conversation/ConversationInspector.vue";
import ConversationMessage from "~/components/conversation/ConversationMessage.vue";
import ConversationRaw from "~/components/conversation/ConversationRaw.vue";
import ConversationTurn from "~/components/conversation/ConversationTurn.vue";
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
    finalAssistantMessageId: "final",
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
async function open(details: Pick<DOMWrapper<Element>, "element" | "trigger">): Promise<void> {
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
  it("honors an observed running lifecycle and renders an isolated gap without an empty Worked wrapper", async () => {
    const running = {
      ...turn(),
      id: "running-final",
      status: "inProgress" as const,
      activities: [tool("still-running")],
    };
    const wrapper = await mountSuspended(ConversationTurn, {
      props: { ...settings, turn: running },
    });
    expect(wrapper.get(".conversation-work-stream").attributes()).toHaveProperty("open");
    wrapper.unmount();
    const hidden = {
      ...turn(),
      id: "isolated-gap",
      activities: [
        {
          id: "empty-reasoning",
          kind: "reasoning" as const,
          turnId: "t",
          createdAt: null,
          rawEventIds: [],
          summary: "",
          body: null,
          encrypted: true,
        },
      ],
    };
    const gap = await mountSuspended(ConversationTurn, {
      props: { ...settings, turn: hidden, unloadedBefore: ["empty-reasoning"] },
    });
    expect(gap.find(".conversation-work-stream").exists()).toBe(false);
    expect(gap.get(".history-gap").text()).toContain("not loaded");
  });
  it("keeps source-ordered commentary after the actual final without repeating that answer", async () => {
    const after = message("after-final");
    const value = {
      ...turn(),
      id: "final-order",
      assistantMessages: [message("final"), after],
      entryOrder: [
        { kind: "message" as const, id: "final" },
        { kind: "message" as const, id: after.id },
      ],
    };
    const wrapper = await mountSuspended(ConversationTurn, { props: { ...settings, turn: value } });
    await Promise.all(wrapper.findAll(".conversation-work-stream").map(open));
    expect(wrapper.findAll('[data-message-id="final"]')).toHaveLength(1);
    expect(
      wrapper
        .findAll('[data-message-id="final"], [data-entry-id="after-final"]')
        .map((node) => node.attributes("data-message-id") ?? node.attributes("data-entry-id")),
    ).toEqual(["final", "after-final"]);
  });
  it("keeps an explicitly missing native final in work and expands active work", async () => {
    const value = turn();
    value.finalAssistantMessageId = null;
    const wrapper = await mountSuspended(ConversationTurn, { props: { ...settings, turn: value } });
    expect(wrapper.findAll(".conversation-message--assistant")).toHaveLength(0);
    expect(wrapper.get('[data-activity-group="worked"]').attributes()).toHaveProperty("open");
    expect(wrapper.text()).toContain("Assistant · progress");
  });
  it("omits encrypted-only reasoning before counting work and shows plaintext summary fallback once", async () => {
    const value = turn();
    value.finalAssistantMessageId = "final";
    value.activities = [
      {
        id: "encrypted",
        turnId: "t",
        kind: "reasoning",
        createdAt: null,
        rawEventIds: [],
        summary: "",
        body: null,
        encrypted: true,
      },
    ];
    const wrapper = await mountSuspended(ConversationTurn, { props: { ...settings, turn: value } });
    expect(wrapper.find('[data-activity-group="worked"]').exists()).toBe(false);
    value.activities = [
      {
        id: "plaintext",
        turnId: "t",
        kind: "reasoning",
        createdAt: null,
        rawEventIds: [],
        summary: "Supplied summary",
        body: null,
        encrypted: true,
      },
    ];
    await wrapper.setProps({ turn: { ...value } });
    await open(wrapper.get('[data-activity-group="worked"]'));
    await open(wrapper.get(".conversation-reasoning"));
    expect(wrapper.text()).toContain("Supplied summary");
    expect(wrapper.text()).not.toContain("Reasoning details unavailable");
  });
  it("preserves modified child-link navigation while primary click selects a child", async () => {
    const value = turn();
    value.finalAssistantMessageId = "final";
    value.activities = [{ ...tool("spawn", "spawn_agent"), output: { thread_id: "child" } }];
    const wrapper = await mountSuspended(ConversationTurn, { props: { ...settings, turn: value } });
    await open(wrapper.get('[data-activity-group="worked"]'));
    await open(wrapper.get('[data-entry-id="spawn"] details'));
    const link = wrapper.get('a[href="/session/child"]');
    for (const options of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { button: 1 },
    ]) {
      const event = new MouseEvent("click", { ...options, bubbles: true, cancelable: true });
      link.element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(wrapper.emitted("openChild")).toBeUndefined();
    await link.trigger("click", { button: 0 });
    expect(wrapper.emitted("openChild")).toEqual([["child"]]);
  });
  it("collapses at an observed final boundary while preserving explicit open and remounted intent", async () => {
    const active = {
      ...turn(),
      id: "transition",
      finalAssistantMessageId: null,
      activities: [tool("transition-tool")],
    };
    const wrapper = await mountSuspended(ConversationTurn, {
      props: { ...settings, turn: active },
    });
    const disclosure = wrapper.get('[data-activity-group="worked"]');
    expect(disclosure.attributes()).toHaveProperty("open");
    await wrapper.setProps({ turn: { ...active, finalAssistantMessageId: "final" } });
    expect(disclosure.attributes()).not.toHaveProperty("open");
    await open(disclosure);
    await wrapper.setProps({
      turn: {
        ...active,
        finalAssistantMessageId: "final",
        activities: [...active.activities, tool("later")],
      },
    });
    expect(disclosure.attributes()).toHaveProperty("open");
    wrapper.unmount();
    const remounted = await mountSuspended(ConversationTurn, {
      props: { ...settings, turn: { ...active, finalAssistantMessageId: "final" } },
    });
    expect(remounted.get('[data-activity-group="worked"]').attributes()).toHaveProperty("open");
    remounted.unmount();
    localStorage.removeItem("codex-sessions-viewer:disclosure:v1:s:transition:work");
  });
  it("applies expanded reasoning and tool defaults only after completed work is disclosed", async () => {
    const value = {
      ...turn(),
      id: "expanded-defaults",
      activities: [
        tool("expanded-tool"),
        {
          id: "expanded-reasoning",
          kind: "reasoning" as const,
          turnId: "t",
          createdAt: null,
          rawEventIds: [],
          summary: "Supplied plaintext",
          body: null,
          encrypted: false,
        },
      ],
    };
    const wrapper = await mountSuspended(ConversationTurn, {
      props: {
        ...settings,
        turn: value,
        reasoningDefault: "expanded",
        toolCallsDefault: "expanded",
      },
    });
    expect(wrapper.find(".conversation-tool-row__detail-body").exists()).toBe(false);
    await open(wrapper.get('[data-activity-group="worked"]'));
    expect(wrapper.get('[data-tool-group="expanded-tool"]').attributes()).toHaveProperty("open");
    expect(wrapper.get('[data-entry-id="expanded-tool"] details').attributes()).toHaveProperty(
      "open",
    );
    expect(wrapper.text()).toContain("expanded-tool result");
    expect(wrapper.text()).toContain("Supplied plaintext");
    wrapper.unmount();
  });
  it("keeps cancelled work expanded and renders distinct summary/body without duplicate reasoning rows", async () => {
    const value = {
      ...turn(),
      id: "cancelled",
      finalAssistantMessageId: null,
      activities: [
        { ...tool("cancelled-command"), status: "cancelled" as const },
        ...["r-one", "r-two"].map((id) => ({
          id,
          kind: "reasoning" as const,
          turnId: "t",
          createdAt: null,
          rawEventIds: [],
          summary: "Summary",
          encrypted: true,
          body: {
            type: "document" as const,
            children: [{ type: "text" as const, text: "Plain body" }],
          },
        })),
      ],
    };
    const wrapper = await mountSuspended(ConversationTurn, {
      props: { ...settings, reasoningDefault: "expanded", turn: value },
    });
    expect(wrapper.get('[data-activity-group="worked"]').attributes()).toHaveProperty("open");
    expect(wrapper.findAll(".conversation-reasoning")).toHaveLength(1);
    expect(wrapper.text()).toContain("Summary");
    expect(wrapper.text()).toContain("Plain body");
  });
  it("hides successful reviews and preserves denied, timeout, pending attempts without null becoming denial", async () => {
    const attempt = {
      reviewedAction: null,
      outcome: "allow" as const,
      riskLevel: "low",
      userAuthorization: null,
      rationale: "Private allowed rationale",
      reviewedAt: null,
    };
    const value = {
      ...turn(),
      id: "approval-attempts",
      finalAssistantMessageId: "final",
      activities: [
        {
          ...tool("attempted"),
          approvalAttempts: [
            attempt,
            { ...attempt, outcome: "deny" as const, rationale: "Denied reason" },
            { ...attempt, outcome: null, status: "timed_out", rationale: "Timeout reason" },
            { ...attempt, outcome: null, status: "pending", rationale: "Pending reason" },
          ],
        },
      ],
    };
    const wrapper = await mountSuspended(ConversationTurn, { props: { ...settings, turn: value } });
    await open(wrapper.get('[data-activity-group="worked"]'));
    expect(wrapper.findAll(".conversation-tool-row__approval")).toHaveLength(3);
    expect(wrapper.text()).toContain("Denied");
    expect(wrapper.text()).toContain("Timed out");
    expect(wrapper.text()).toContain("Review pending");
    expect(wrapper.text()).not.toContain("Approved");
    expect(wrapper.text()).not.toContain("Private allowed rationale");
    expect(wrapper.text()).not.toContain("Denied reason");
  });
  it("separates incompatible successful calls, preserves commentary/failure boundaries, and retains live-append expansion", async () => {
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
    const wrapper = await mountSuspended(ConversationTurn, { props: { ...settings, turn: value } });
    await open(wrapper.get('[data-activity-group="worked"]'));
    expect(wrapper.findAll("[data-tool-group]")).toHaveLength(3);
    expect(wrapper.text()).toContain("Ran a command");
    expect(wrapper.text()).toContain("Edited files");
    expect(wrapper.text()).toContain("Exit 7");
    await open(wrapper.get('[data-tool-group="a"]'));
    expect(wrapper.find('[data-entry-id="a"] .conversation-tool-row__detail-body').exists()).toBe(
      false,
    );
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
    const wrapper = await mountSuspended(ConversationMessage, {
      props: { message: message("final"), timestampFormat: "absolute", agentWork: producer },
    });
    expect(producer).not.toHaveBeenCalled();
    await wrapper.get('[aria-label="Assistant copy options"]').trigger("click");
    expect(producer).not.toHaveBeenCalled();
    await wrapper.get('[role="menuitem"]').trigger("click");
    expect(producer).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("complete agent work");
    const raw = await mountSuspended(ConversationRaw, {
      props: { label: "Large output", value: "x".repeat(100_000) },
    });
    expect(raw.find("pre").exists()).toBe(false);
    await open(raw.get("details"));
    expect(raw.get("pre").text().length).toBeLessThan(17_000);
    expect(raw.text()).toContain("Partial preview");
    await raw.get('[aria-label="Copy complete Large output"]').trigger("click");
    expect(writeText).toHaveBeenLastCalledWith("x".repeat(100_000));
  });
  it("opens copy options with the keyboard and restores focus after Escape and copy", async () => {
    const writeText = vi.fn<() => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const wrapper = await mountSuspended(ConversationMessage, {
      props: { message: message("keyboard-final"), timestampFormat: "absolute", agentWork: "Work" },
      attachTo: document.body,
    });
    const button = wrapper.get('[aria-label="Assistant copy options"]');
    if (!(button.element instanceof HTMLButtonElement)) {
      throw new Error("Expected copy menu button");
    }
    button.element.focus();
    await button.trigger("keydown", { key: "ArrowDown" });
    await flushPromises();
    expect(button.attributes("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(wrapper.get('[role="menuitem"]').element);
    await wrapper.get('[role="menuitem"]').trigger("keydown", { key: "Escape" });
    await flushPromises();
    expect(button.attributes("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button.element);
    await button.trigger("click");
    await wrapper.get('[role="menuitem"]').trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("Work");
    expect(document.activeElement).toBe(button.element);
    wrapper.unmount();
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
    const wrapper = await mountSuspended(ConversationTurn, {
      props: { ...settings, turn: value, resolveAsset },
    });
    await open(wrapper.get('[data-activity-group="worked"]'));
    await open(wrapper.get(".conversation-reasoning"));
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
    const wrapper = await mountSuspended(ConversationInspector, {
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
    const wrapper = await mountSuspended({
      render: () => h(ConversationTurn, { ...settings, turn: value }),
    });
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
    const wrapper = await mountSuspended(ConversationMessage, {
      props: { message: user, timestampFormat: "absolute", resolveAsset: resolver },
    });
    await flushPromises();
    expect(wrapper.get("audio").attributes("src")).toBe("/api/assets/audio");
    expect(wrapper.text()).toContain("Cached media is unavailable");
  });
});
