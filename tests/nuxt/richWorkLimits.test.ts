import { mountSuspended } from "@nuxt/test-utils/runtime";
import { expect, it } from "vitest";

import DiffBlock from "~/components/content/DiffBlock.client.vue";

it("keeps a directly expanded giant activity patch plain through wrapping and source changes", async () => {
  const source = `diff --git a/large b/large\n--- a/large\n+++ b/large\n@@ -0,0 +1,1500 @@\n${"+retained source\n".repeat(1500)}`;
  const wrapper = await mountSuspended(DiffBlock, { props: { source, wrapped: false } });
  expect(wrapper.get(".rich-diff").attributes("data-state")).toBe("plain");
  expect(wrapper.findAll("[data-diff-file]")).toHaveLength(0);
  expect(wrapper.get("pre > code").element.textContent).toBe(source);
  await wrapper.setProps({ source: `${source}+another line\n`, wrapped: true });
  expect(wrapper.get(".rich-diff").attributes("data-state")).toBe("plain");
  expect(wrapper.findAll("[data-diff-file]")).toHaveLength(0);
  expect(wrapper.get("pre > code").element.textContent).toBe(`${source}+another line\n`);
  wrapper.unmount();
});
