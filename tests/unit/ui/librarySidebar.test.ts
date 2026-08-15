import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import LibraryEmptyState from "../../../app/components/library/LibraryEmptyState.vue";
import LibrarySearchResults from "../../../app/components/library/LibrarySearchResults.vue";
import LibrarySessionList from "../../../app/components/library/LibrarySessionList.vue";
import LibrarySidebar from "../../../app/components/library/LibrarySidebar.vue";
import LibrarySkeleton from "../../../app/components/library/LibrarySkeleton.vue";

const baseProps = {
  scope: "active" as const,
  counts: { active: 12, archived: 4 },
  query: "",
  model: "",
  cwd: "",
  tool: "",
  hasMedia: false,
  items: [],
  hits: [],
  loading: false,
  error: null,
  settledTotal: 12,
  nextCursor: null,
  searchExactTurns: true,
};

describe("LibrarySidebar", () => {
  it("exposes URL-owned search and scope controls while announcing only settled results", async () => {
    const wrapper = mount(LibrarySidebar, {
      props: baseProps,
    });

    await wrapper.get('input[type="search"]').setValue("viewer");
    const archivedTab = wrapper.findAll('[role="tab"]')[1];
    if (archivedTab === undefined) {
      throw new Error("Expected an Archived tab.");
    }
    await archivedTab.trigger("click");

    expect(wrapper.emitted("update:query")?.at(-1)).toEqual(["viewer"]);
    expect(wrapper.emitted("update:scope")?.at(-1)).toEqual(["archived"]);
    expect(wrapper.get('[aria-live="polite"]').text()).toBe("12 sessions");

    await wrapper.setProps({ query: "viewer", settledTotal: 3 });
    expect(wrapper.get('[aria-live="polite"]').text()).toBe("3 results for “viewer”");
  });

  it("renders each result state and forwards retry, filters, pagination, and close actions", async () => {
    const wrapper = mount(LibrarySidebar, {
      props: { ...baseProps, mode: "static" as const, loading: true, settledTotal: 1 },
    });
    expect(wrapper.findComponent(LibrarySkeleton).exists()).toBe(true);
    expect(wrapper.text()).toContain("Static read-only export");
    expect(wrapper.get('[aria-live="polite"]').text()).toBe("1 session");

    await wrapper.setProps({ loading: false, error: "Read failed" });
    await wrapper.findComponent(LibraryEmptyState).get("button").trigger("click");
    expect(wrapper.emitted("retry")).toHaveLength(1);

    await wrapper.setProps({
      error: null,
      query: "needle",
      searchExactTurns: true,
      settledTotal: 1,
      hits: [
        {
          sessionId: "session-1",
          turnId: "turn-1",
          messageId: null,
          scope: "active",
          title: "Needle",
          excerpt: "needle",
          score: 1,
        },
      ],
    });
    expect(wrapper.findComponent(LibrarySearchResults).exists()).toBe(true);
    expect(wrapper.get('[aria-live="polite"]').text()).toBe("1 result for “needle”");

    await wrapper.setProps({
      hits: [],
      searchExactTurns: false,
      items: [
        {
          id: "session-1",
          title: "Session",
          scope: "active",
          sourcePath: "C:/session.jsonl",
          createdAt: "2026-08-15T08:00:00.000Z",
          updatedAt: "2026-08-15T09:00:00.000Z",
          cwd: null,
          gitBranch: null,
          gitSha: null,
          gitOriginUrl: null,
          models: [],
          reasoningEfforts: [],
          turnCount: 1,
          assistantMessageCount: 1,
          toolCallCount: 0,
          toolCounts: {},
          preview: "Preview",
          pinned: false,
          sectionName: null,
          parentThreadId: null,
          childThreadIds: [],
          hasMedia: false,
          diagnosticCount: 0,
          revision: "revision-1",
        },
      ],
      nextCursor: "1",
    });
    expect(wrapper.text()).toContain("Transcript search was not included");
    expect(wrapper.findComponent(LibrarySessionList).exists()).toBe(true);
    await wrapper.get(".library-sidebar__more").trigger("click");
    expect(wrapper.emitted("load-more")).toHaveLength(1);

    await wrapper.setProps({ items: [], nextCursor: null });
    expect(wrapper.findComponent(LibraryEmptyState).props("title")).toBe("No matching turns");
    await wrapper.setProps({ query: "", scope: "archived", settledTotal: 0 });
    expect(wrapper.findComponent(LibraryEmptyState).props("title")).toBe("No archived sessions");

    await wrapper.setProps({ model: "gpt-5", cwd: "C:/repo", tool: "exec", hasMedia: true });
    const inputs = wrapper.findAll("input");
    await inputs.find((input) => input.attributes("id") === "library-model")!.setValue("gpt-6");
    await inputs.find((input) => input.attributes("id") === "library-cwd")!.setValue("C:/other");
    await inputs.find((input) => input.attributes("id") === "library-tool")!.setValue("read");
    await wrapper.get('input[type="checkbox"]').setValue(false);
    await wrapper.get('[aria-label="Close session library"]').trigger("click");
    expect(wrapper.emitted("update:model")?.at(-1)).toEqual(["gpt-6"]);
    expect(wrapper.emitted("update:cwd")?.at(-1)).toEqual(["C:/other"]);
    expect(wrapper.emitted("update:tool")?.at(-1)).toEqual(["read"]);
    expect(wrapper.emitted("update:hasMedia")?.at(-1)).toEqual([false]);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
