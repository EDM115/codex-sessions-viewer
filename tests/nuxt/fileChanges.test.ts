import { mountSuspended, mockComponent } from "@nuxt/test-utils/runtime";
import { describe, expect, it } from "vitest";

import { ConversationFileChanges } from "#components";
import type { FileChangeActivity } from "#shared/types/conversation.ts";
mockComponent("ContentDiffBlock", () => ({
  props: ["source"],
  template: '<pre data-test="diff">{{ source }}</pre>',
}));

function change(
  content: string | null,
  kind: "add" | "delete" | "update",
  addedLines: number | null,
  removedLines: number | null,
): FileChangeActivity {
  return {
    id: "file",
    turnId: "turn",
    createdAt: null,
    rawEventIds: [],
    kind: "file_change",
    status: "succeeded",
    files: [
      {
        path: "file.txt",
        previousPath: null,
        change: kind,
        content,
        diff: null,
        addedLines,
        removedLines,
      },
    ],
  };
}
describe("observed file counters", () => {
  it("renders unavailable update counts explicitly instead of zero", async () => {
    const wrapper = await mountSuspended(ConversationFileChanges, {
      props: { activities: [change(null, "update", null, null)] },
    });
    expect(wrapper.text()).toContain("Line counts unavailable");
    expect(wrapper.text()).not.toContain("+0");
    expect(wrapper.text()).not.toContain("0 added");
    wrapper.unmount();
  });
  it.each(["add", "delete"] as const)(
    "renders full %s content with literal sign-prefixed lines and known counts",
    async (kind) => {
      const wrapper = await mountSuspended(ConversationFileChanges, {
        props: {
          activities: [
            change("+literal\n-literal\n", kind, kind === "add" ? 2 : 0, kind === "delete" ? 2 : 0),
          ],
        },
      });
      expect(wrapper.text()).toContain(
        kind === "add" ? "2 added · 0 removed" : "0 added · 2 removed",
      );
      const outer = wrapper.find("details");
      (outer.element as HTMLDetailsElement).open = true;
      await outer.trigger("toggle");
      const inner = wrapper.findAll("details")[1]!;
      (inner.element as HTMLDetailsElement).open = true;
      await inner.trigger("toggle");
      expect(wrapper.find('[data-test="diff"]').text()).toContain(
        kind === "add" ? "++literal\n+-literal" : "-+literal\n--literal",
      );
      wrapper.unmount();
    },
  );
});
