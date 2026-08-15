import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import LibrarySidebar from "../../../app/components/library/LibrarySidebar.vue";

describe("LibrarySidebar", () => {
  it("exposes URL-owned search and scope controls while announcing only settled results", async () => {
    const wrapper = mount(LibrarySidebar, {
      props: {
        scope: "active",
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
      },
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
});
