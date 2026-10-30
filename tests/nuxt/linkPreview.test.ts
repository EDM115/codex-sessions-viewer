import { mountSuspended } from "@nuxt/test-utils/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LinkPreview } from "#shared/types/linkPreview.ts";
import RichLink from "~/components/content/RichLink.vue";
import { linkPreviewResolverKey } from "~/composables/useLinkPreview.ts";

afterEach(() => {
  vi.useRealTimers();
});
const preview: LinkPreview = {
  version: 1,
  provenance: "viewer-enrichment",
  url: "https://example.com/page",
  finalUrl: "https://example.com/page",
  revision: "saved",
  availability: "ready",
  title: "A saved title",
  description: "A useful description",
  image: null,
  fetchedAt: "2026-10-30T00:00:00Z",
  retryAt: "2026-10-30T00:10:00Z",
  reason: null,
};
const node = {
  type: "link" as const,
  url: preview.url,
  origin: "https://example.com",
  title: null,
  children: [{ type: "text" as const, text: "Example" }],
};

describe("lazy website previews", () => {
  it("does no startup or short-dwell request and leaves touch navigation intact", async () => {
    const resolve = vi.fn(async () => preview);
    const wrapper = await mountSuspended(RichLink, {
      props: { node },
      global: { provide: { [linkPreviewResolverKey as symbol]: resolve } },
    });
    try {
      vi.useFakeTimers();
      expect(resolve).not.toHaveBeenCalled();
      await wrapper
        .find(".rich-link-shell")
        .trigger("pointerenter", { pointerType: "mouse", buttons: 0 });
      await vi.advanceTimersByTimeAsync(199);
      await wrapper.find(".rich-link-shell").trigger("pointerleave");
      await vi.advanceTimersByTimeAsync(1000);
      expect(resolve).not.toHaveBeenCalled();
      await wrapper
        .find(".rich-link-shell")
        .trigger("pointerenter", { pointerType: "touch", buttons: 0 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(resolve).not.toHaveBeenCalled();
      expect(wrapper.find("a.rich-link").attributes("href")).toBe(preview.url);
    } finally {
      wrapper.unmount();
    }
  });
  it("shows a focus-accessible saved card and dismisses with Escape without changing the original link", async () => {
    const resolve = vi.fn(async () => preview);
    const wrapper = await mountSuspended(RichLink, {
      attachTo: document.body,
      props: { node },
      global: { provide: { [linkPreviewResolverKey as symbol]: resolve } },
    });
    try {
      await wrapper.find("a.rich-link").trigger("focus");
      await vi.waitFor(() =>
        expect(document.querySelector(".website-preview")?.textContent).toContain("A saved title"),
      );
      expect(resolve).toHaveBeenCalledOnce();
      expect(document.querySelector(".website-preview")?.getAttribute("role")).toBe("dialog");
      await wrapper.find("a.rich-link").trigger("keydown", { key: "Escape" });
      expect(document.querySelector(".website-preview")).toBeNull();
      expect(wrapper.find("a.rich-link").attributes("href")).toBe(preview.url);
    } finally {
      wrapper.unmount();
    }
  });
});
