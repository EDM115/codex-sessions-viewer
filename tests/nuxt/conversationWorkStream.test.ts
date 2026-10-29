import { mountSuspended } from "@nuxt/test-utils/runtime";
import { flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import type {
  ConversationMessage,
  ConversationTurn as Turn,
  TurnEntryReference,
} from "#shared/types/conversation.ts";
import ConversationTurn from "~/components/conversation/ConversationTurn.vue";

import { detailsElement } from "./helpers/elements.ts";

function message(
  id: string,
  role: "assistant" | "user",
  sourceMarkdown: string,
  phase: string | null = null,
): ConversationMessage {
  return {
    id,
    turnId: "turn-1",
    role,
    phase,
    createdAt: "2026-08-16T08:00:00.000Z",
    sourceMarkdown,
    body: {
      type: "document",
      children: [
        sourceMarkdown.includes("**")
          ? {
              type: "element",
              tagName: "strong",
              attributes: {},
              children: [{ type: "text", text: sourceMarkdown.replaceAll("**", "") }],
            }
          : { type: "text", text: sourceMarkdown },
      ],
    },
    attachmentIds: [],
    rawEventIds: [`event-${id}`],
  };
}

function orderedTurn(): Turn {
  const user = message("user", "user", "Build the feature.");
  const steering = message("steering", "user", "Also preserve the existing API.");
  const progress = message("progress", "assistant", "I am checking the call sites.", "commentary");
  const final = message("final", "assistant", "Implemented and verified.", "final");
  const entryOrder: TurnEntryReference[] = [
    { kind: "message", id: user.id },
    { kind: "activity", id: "reasoning-a" },
    { kind: "message", id: progress.id },
    { kind: "activity", id: "command-a" },
    { kind: "message", id: steering.id },
    { kind: "activity", id: "reasoning-b" },
    { kind: "activity", id: "command-b" },
    { kind: "activity", id: "command-c" },
    { kind: "activity", id: "agent" },
    { kind: "activity", id: "file-a" },
    { kind: "activity", id: "file-b" },
    { kind: "message", id: final.id },
  ];
  return {
    id: "turn-1",
    sourceTurnId: "source-turn-1",
    sessionId: "session-1",
    index: 0,
    userMessage: user,
    steeringMessages: [steering],
    assistantMessages: [progress, final],
    activities: [
      {
        id: "reasoning-a",
        turnId: "turn-1",
        kind: "reasoning",
        createdAt: null,
        rawEventIds: [],
        summary: "Planning the implementation",
        body: message("reasoning-body-a", "assistant", "**Planning the implementation**").body,
        encrypted: true,
      },
      {
        id: "command-a",
        turnId: "turn-1",
        kind: "tool",
        createdAt: null,
        rawEventIds: [],
        namespace: "functions",
        name: "exec_command",
        callId: "call-a",
        status: "succeeded",
        startedAt: null,
        completedAt: null,
        durationMs: 250,
        input: { cmd: "pnpm typecheck" },
        output: { exit_code: 0 },
        error: null,
        approval: {
          reviewedAction: { cmd: "pnpm typecheck" },
          outcome: "allow",
          riskLevel: "low",
          userAuthorization: null,
          rationale: "Read-only verification command.",
          reviewedAt: null,
        },
      },
      {
        id: "reasoning-b",
        turnId: "turn-1",
        kind: "reasoning",
        createdAt: null,
        rawEventIds: [],
        summary: "Drafting the patch",
        body: message("reasoning-body-b", "assistant", "**Drafting the patch**").body,
        encrypted: true,
      },
      ...["b", "c"].map((suffix) => ({
        id: `command-${suffix}`,
        turnId: "turn-1",
        kind: "tool" as const,
        createdAt: null,
        rawEventIds: [],
        namespace: "functions",
        name: "exec_command",
        callId: `call-${suffix}`,
        status: "succeeded" as const,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        input: { cmd: `pnpm test:${suffix}` },
        output: { exit_code: 0 },
        error: null,
      })),
      {
        id: "agent",
        turnId: "turn-1",
        kind: "subagent",
        createdAt: null,
        rawEventIds: [],
        status: "succeeded",
        agentId: "agent-child",
        parentThreadId: "session-1",
        childThreadId: "child-session",
        description: "Reviewed the cache path",
      },
      ...["a", "b"].map((suffix, index) => ({
        id: `file-${suffix}`,
        turnId: "turn-1",
        kind: "file_change" as const,
        createdAt: null,
        rawEventIds: [],
        status: "succeeded" as const,
        files: [
          {
            path: `server/file-${suffix}.ts`,
            change: index === 0 ? ("update" as const) : ("add" as const),
            previousPath: null,
            diff: index === 0 ? "@@ -1 +1 @@\n-old\n+new" : "@@ -0,0 +1 @@\n+created",
            content: null,
            addedLines: 1,
            removedLines: index === 0 ? 1 : 0,
          },
        ],
      })),
    ],
    entryOrder,
    finalAssistantMessageId: final.id,
    startedAt: null,
    completedAt: null,
    durationMs: 621_000,
    timeToFirstTokenMs: null,
    tokenDelta: null,
    models: ["gpt-5"],
    reasoningEfforts: ["high"],
    toolCounts: { "functions/exec_command": 3 },
    diagnosticIds: [],
  };
}

describe("ConversationWorkStream", () => {
  it("interleaves work chronologically and leaves only the final assistant response visible", async () => {
    const wrapper = await mountSuspended(ConversationTurn, {
      props: {
        turn: orderedTurn(),
        reasoningDefault: "expanded",
        toolCallsDefault: "collapsed",
        timestampFormat: "absolute",
      },
      global: {
        stubs: {
          ContentDiffBlock: {
            props: ["source"],
            template: '<pre class="rich-diff-test">{{ source }}</pre>',
          },
        },
      },
    });

    expect(wrapper.findAll(".conversation-message--assistant")).toHaveLength(1);
    expect(wrapper.get(".conversation-message--assistant").text()).toContain(
      "Implemented and verified.",
    );
    expect(wrapper.text()).not.toContain("I am checking the call sites.");
    expect(wrapper.get('[data-activity-group="worked"] summary').text()).toContain(
      "Worked for 10m 21s",
    );

    const work = wrapper.get('[data-activity-group="worked"]');
    detailsElement(work.element).open = true;
    await work.trigger("toggle");

    expect(wrapper.text()).toContain("I am checking the call sites.");
    expect(wrapper.text()).toContain("Also preserve the existing API.");
    expect(wrapper.findAll(".conversation-reasoning")).toHaveLength(2);
    expect(wrapper.findAll(".conversation-reasoning strong").map((node) => node.text())).toEqual([
      "Planning the implementation",
      "Drafting the patch",
    ]);
    expect(wrapper.text()).not.toContain("Encrypted source retained");
    expect(wrapper.findAll(".conversation-tool-row__header strong")).toHaveLength(1);
    expect(
      wrapper.findAll("[data-tool-group]").map((group) => group.attributes("data-tool-group")),
    ).toEqual(["command-b", "file-a", "file-b"]);
    expect(wrapper.findAll(".conversation-tool-row pre")).toHaveLength(0);
    await Promise.all(
      wrapper.findAll("[data-tool-group]").map((group) => {
        detailsElement(group.element).open = true;
        return group.trigger("toggle");
      }),
    );
    expect(
      wrapper.findAll(".conversation-tool-row__header strong").map((node) => node.text()),
    ).toEqual(["Ran command", "Ran command", "Ran command"]);
    expect(wrapper.text()).not.toContain("Approved · low risk");
    expect(wrapper.text()).not.toContain("Read-only verification command.");
    const child = wrapper.get('[data-entry-id="agent"] details');
    detailsElement(child.element).open = true;
    await child.trigger("toggle");
    expect(wrapper.get('a[href="/session/child-session"]').text()).toContain(
      "Reviewed the cache path",
    );
    expect(wrapper.findAll(".conversation-file-changes")).toHaveLength(2);
    expect(wrapper.get('[data-tool-group="file-a"] > summary').text()).toContain("Edited files");
    await Promise.all(
      wrapper.findAll(".conversation-file-changes").map((details) => {
        detailsElement(details.element).open = true;
        return details.trigger("toggle");
      }),
    );
    const fileDetails = wrapper.findAll(".conversation-file-changes__files details");
    await Promise.all(
      fileDetails.map((details) => {
        detailsElement(details.element).open = true;
        return details.trigger("toggle");
      }),
    );
    await flushPromises();
    expect(wrapper.findAll(".rich-diff-test")).toHaveLength(2);

    expect(
      wrapper.findAll("[data-entry-id]").map((node) => node.attributes("data-entry-id")),
    ).toEqual([
      "reasoning-a",
      "progress",
      "command-a",
      "steering",
      "reasoning-b",
      "command-b",
      "command-c",
      "agent",
      "file-a",
      "file-b",
    ]);
  });
});

it("preserves explicit work disclosure intent across virtual remounts when browser storage is unavailable", async () => {
  vi.spyOn(localStorage, "getItem").mockImplementation(() => {
    throw new Error("disabled");
  });
  vi.spyOn(localStorage, "setItem").mockImplementation(() => {
    throw new Error("disabled");
  });
  const props = {
    turn: orderedTurn(),
    disclosureKey: "virtual-remount",
    reasoningDefault: "collapsed" as const,
    toolCallsDefault: "collapsed" as const,
    timestampFormat: "absolute" as const,
  };
  const first = await mountSuspended(ConversationTurn, { props });
  const work = first.get('[data-activity-group="worked"]');
  detailsElement(work.element).open = true;
  await work.trigger("toggle");
  first.unmount();
  const second = await mountSuspended(ConversationTurn, { props });
  expect(detailsElement(second.get('[data-activity-group="worked"]').element).open).toBe(true);
  second.unmount();
});
