import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import LibraryEmptyState from "../../../app/components/library/LibraryEmptyState.vue";
import LibraryPreparationState from "../../../app/components/library/LibraryPreparationState.vue";
import LibrarySearchResults from "../../../app/components/library/LibrarySearchResults.vue";
import LibrarySessionList from "../../../app/components/library/LibrarySessionList.vue";
import type { ConversationSummary } from "../../../shared/types/conversation.ts";

function session(id: string, title: string): ConversationSummary {
  return {
    id,
    title,
    scope: "active",
    sourcePath: `C:/codex/sessions/${id}.jsonl`,
    createdAt: "2026-08-15T08:00:00.000Z",
    updatedAt: "2026-08-15T09:00:00.000Z",
    cwd: "C:/repo/viewer",
    gitBranch: "main",
    gitSha: null,
    gitOriginUrl: null,
    models: ["gpt-5"],
    reasoningEfforts: ["high"],
    turnCount: 4,
    assistantMessageCount: 4,
    toolCallCount: 2,
    toolCounts: { exec_command: 2 },
    preview: "Implement the local viewer shell",
    pinned: false,
    sectionName: "Today",
    parentThreadId: null,
    childThreadIds: [],
    hasMedia: false,
    diagnosticCount: 0,
    revision: "revision-1",
  };
}

describe("library presentation components", () => {
  it("shows a session skeleton while the read-only live cache is preparing and a visible failure if preparation stops", async () => {
    const wrapper = mount(LibraryPreparationState, {
      props: { state: "preparing", message: null },
    });

    expect(wrapper.get('[role="status"]').text()).toContain("Preparing your local archive");
    expect(wrapper.text()).toContain("Codex source files remain read-only");
    expect(wrapper.findAll(".library-skeleton__row")).toHaveLength(4);

    await wrapper.setProps({
      state: "error",
      message: "The local session cache could not be prepared.",
    });
    expect(wrapper.get('[role="alert"]').text()).toContain(
      "The local session cache could not be prepared.",
    );
    expect(wrapper.find(".library-skeleton").exists()).toBe(false);
  });

  it("renders safe highlighted excerpts with exact turn destinations", () => {
    const wrapper = mount(LibrarySearchResults, {
      props: {
        hits: [
          {
            sessionId: "session/1",
            turnId: "turn 3",
            messageId: null,
            scope: "active",
            title: "Build the viewer — Turn 3",
            excerpt: "The <mark>viewer</mark> &lt;script&gt; stays read-only.",
            score: 1,
          },
        ],
        query: "viewer",
      },
    });

    expect(wrapper.get("a").attributes("href")).toBe(
      "/session/session%2F1?turn=turn%203#turn-turn%203",
    );
    expect(wrapper.get("mark").text()).toBe("viewer");
    expect(wrapper.find("script").exists()).toBe(false);
    expect(wrapper.text()).toContain("<script> stays read-only.");
  });

  it("marks the selected session and supports arrow-key focus movement", async () => {
    const wrapper = mount(LibrarySessionList, {
      attachTo: document.body,
      props: {
        items: [session("session-1", "First"), session("session-2", "Second")],
        selectedId: "session-1",
      },
    });
    const links = wrapper.findAll("a");
    const firstLink = links[0];
    const secondLink = links[1];
    if (firstLink === undefined || secondLink === undefined) {
      throw new Error("Expected two session links.");
    }

    expect(firstLink.attributes("aria-current")).toBe("page");
    await firstLink.trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(secondLink.element);
    await secondLink.trigger("keydown", { key: "ArrowUp" });
    expect(document.activeElement).toBe(firstLink.element);

    wrapper.unmount();
  });

  it("offers retry only when an empty state is recoverable", async () => {
    const wrapper = mount(LibraryEmptyState, {
      props: {
        title: "The source could not be read",
        description: "Check the diagnostic and try again.",
        recoverable: true,
      },
    });

    await wrapper.get("button").trigger("click");
    expect(wrapper.emitted("retry")).toHaveLength(1);
    await wrapper.setProps({ recoverable: false });
    expect(wrapper.find("button").exists()).toBe(false);
  });
});
