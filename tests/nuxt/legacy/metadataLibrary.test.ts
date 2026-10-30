import { mountSuspended as mount } from "@nuxt/test-utils/runtime";
import { flushPromises } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LibraryEntry } from "#shared/types/library.ts";
import LibrarySessionList from "~/components/library/LibrarySessionList.vue";

afterEach(() => vi.unstubAllGlobals());

describe("metadata-only sidebar rows", () => {
  it("mounts and navigates metadata entries without observing or preparing their content", async () => {
    const observer = vi.fn<() => void>();
    const request = vi.fn<() => void>();
    vi.stubGlobal("IntersectionObserver", observer);
    vi.stubGlobal("fetch", request);
    const entries: LibraryEntry[] = Array.from({ length: 5 }, (_, index) => ({
      id: `thread-${index}`,
      title: `A complete accessible title ${index}`,
      scope: "active",
      projectId: null,
      orderKey: String(index),
      kind: "root",
      parentThreadId: null,
      childCount: 0,
    }));
    const wrapper = await mount(LibrarySessionList, {
      attachTo: document.body,
      props: { items: entries, selectedId: "thread-1" },
    });
    try {
      const links = wrapper.findAll("a");
      expect(links).toHaveLength(5);
      expect(links[1]!.attributes("aria-current")).toBe("page");
      expect(links[0]!.text()).toBe(entries[0]!.title);
      await links[0]!.trigger("keydown", { key: "ArrowDown" });
      expect(document.activeElement).toBe(links[1]!.element);
      await wrapper.trigger("scroll");
      await flushPromises();
      expect(observer).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(wrapper.text()).not.toMatch(/pending|cold|queued|turns|preview|Retry preparation/u);
    } finally {
      wrapper.unmount();
    }
  });
});
