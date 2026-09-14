import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { publishFaviconAvailability } from "../../../app/components/content/faviconAvailability.ts";
import RichTextRenderer from "../../../app/components/content/RichTextRenderer.vue";
import { LiveApiConversationRepository } from "../../../app/repositories/live.ts";
import { parseRichText } from "../../../server/content/parseRichText.ts";
import type { ResolvedAsset } from "../../../shared/types/repository.ts";
import type { RichTextDocument, RichTextLinkNode } from "../../../shared/types/richText.ts";

enableAutoUnmount(afterEach);
const documentFor = (node: RichTextLinkNode): RichTextDocument => ({
  type: "document",
  children: [node],
});
const link = (origin: string): RichTextLinkNode => ({
  type: "link",
  url: `${origin}/docs`,
  origin,
  title: null,
  children: [{ type: "text", text: "Documentation" }],
});
const asset = (id: string): ResolvedAsset => ({
  id,
  url: `/api/assets/${id}/content`,
  mimeType: "image/png",
  byteSize: 123,
  sha256: "a".repeat(64),
  width: 30,
  height: 20,
  status: "available",
  originalPath: null,
});

describe("rich-content actual renderer hierarchy", () => {
  it("recovers the same link after live enrichment and remembers revisions for later mounts", async () => {
    class LocalEvents extends EventTarget {
      static current: LocalEvents;
      constructor() {
        super();
        LocalEvents.current = this;
      }
      close() {}
    }
    vi.stubGlobal("EventSource", LocalEvents);
    const repository = new LiveApiConversationRepository();
    const listener = vi.fn<(event: unknown) => void>();
    const unsubscribe = repository.subscribe(listener);
    const origin = "https://cold-cache.example";
    const resolveFavicon = vi.fn<(origin: string) => Promise<string>>(
      repository.resolveFavicon.bind(repository),
    );
    const props = { document: documentFor(link(origin)), resolveFavicon };
    const wrapper = mount(RichTextRenderer, { props });
    await flushPromises();
    const anchor = wrapper.get("a").element;
    await wrapper.get("img").trigger("error");
    expect(wrapper.find("img").exists()).toBe(false);
    LocalEvents.current.dispatchEvent(
      new MessageEvent("favicon.updated", {
        data: JSON.stringify({ type: "favicon.updated", ids: [origin], revision: "ready-1" }),
      }),
    );
    await flushPromises();
    expect(wrapper.get("a").element).toBe(anchor);
    expect(wrapper.get("img").attributes("src")).toContain("?v=ready-1");
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "favicon.updated" }));
    const later = mount(RichTextRenderer, { props });
    await flushPromises();
    expect(later.get("img").attributes("src")).toContain("?v=ready-1");
    await wrapper.get("img").trigger("error");
    publishFaviconAvailability([origin], "ready-1");
    await flushPromises();
    expect(wrapper.find("img").exists()).toBe(false);
    expect(resolveFavicon).toHaveBeenCalledTimes(3);
    unsubscribe();
    vi.unstubAllGlobals();
  });

  it("does not let a stale origin overwrite its replacement or retry missing icons on a loop", async () => {
    let resolveA!: (value: string | null) => void;
    const resolveFavicon = vi.fn<(origin: string) => Promise<string | null>>((origin: string) =>
      origin.endsWith("a.example")
        ? new Promise<string | null>((resolve) => {
            resolveA = resolve;
          })
        : Promise.resolve("/favicons/b.png"),
    );
    const wrapper = mount(RichTextRenderer, {
      props: { document: documentFor(link("https://a.example")), resolveFavicon },
    });
    await wrapper.setProps({ document: documentFor(link("https://b.example")) });
    await flushPromises();
    resolveA("/favicons/a.png");
    await flushPromises();
    expect(wrapper.get("img").attributes("src")).toBe("/favicons/b.png");
    await wrapper.get("img").trigger("error");
    await flushPromises();
    expect(wrapper.find("img").exists()).toBe(false);
    expect(resolveFavicon).toHaveBeenCalledTimes(2);
  });

  it("scopes footnote navigation and repeated backlinks within each rendered document", async () => {
    const { document } = await parseRichText("Note[^1] again[^1].\n\n[^1]: Body.");
    const wrapper = mount({
      components: { RichTextRenderer },
      setup: () => ({ document }),
      template:
        '<main><RichTextRenderer :document="document" /><RichTextRenderer :document="document" /></main>',
    });
    const documents = wrapper.findAll(".rich-text-document");
    expect(documents).toHaveLength(2);
    const allIds = wrapper.findAll("[id]").map((target) => target.attributes("id"));
    expect(allIds.length).toBeGreaterThanOrEqual(6);
    expect(new Set(allIds).size).toBe(allIds.length);
    for (const rich of documents) {
      const references = rich.findAll('sup a[href^="#"]');
      const backlinks = rich.findAll('section a[href^="#"]');
      expect(references).toHaveLength(2);
      expect(backlinks).toHaveLength(2);
      expect(references.map((reference) => reference.attributes("href"))).toEqual([
        references[0]!.attributes("href"),
        references[0]!.attributes("href"),
      ]);
      expect(backlinks.map((backlink) => backlink.attributes("href"))).toEqual(
        references.map((reference) => `#${reference.attributes("id")}`),
      );
      expect(rich.get(`[id="${references[0]!.attributes("href").slice(1)}"]`).text()).toContain(
        "Body.",
      );
      for (const reference of [...references, ...backlinks]) {
        expect(rich.findAll(`[id="${reference.attributes("href").slice(1)}"]`)).toHaveLength(1);
      }
    }
  });

  it("renders Windows file coordinates and copies a decoded path without opening it", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>(async (_: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { document } = await parseRichText("[reader](<C:/work/my%20file.ts:12:4>)");
    const wrapper = mount(RichTextRenderer, { props: { document } });
    expect(wrapper.get(".rich-file-reference__path").text()).toBe("C:\\work\\my file.ts");
    expect(wrapper.get(".rich-file-reference__position").text()).toBe("L12:C4");
    await wrapper.get('button[aria-label="Copy file path"]').trigger("click");
    expect(writeText).toHaveBeenCalledWith("C:\\work\\my file.ts");
  });

  it("resolves linked images and exposes separate preview and destination actions", async () => {
    const { document } = await parseRichText(
      "[![diagram](file:///C:/work/a.png)](https://example.com)",
      { assetIdsByPath: new Map([["C:\\work\\a.png", "asset-a"]]) },
    );
    const resolveAsset = vi.fn<(id: string) => Promise<ResolvedAsset>>(async (id: string) =>
      asset(id),
    );
    const wrapper = mount(RichTextRenderer, { props: { document, resolveAsset } });
    await flushPromises();
    expect(wrapper.get('img[alt="diagram"]').attributes("src")).toBe("/api/assets/asset-a/content");
    expect(wrapper.find("a button, button a, a a").exists()).toBe(false);
    expect(wrapper.get("a").attributes("href")).toBe("https://example.com/");
    await wrapper.get('button[aria-label="Open image: diagram"]').trigger("click");
    expect(wrapper.emitted("openMedia")?.[0]?.[0]).toMatchObject({
      kind: "image",
      src: "/api/assets/asset-a/content",
    });
  });

  it("updates a mounted media node and ignores the old asset resolver result", async () => {
    let resolveOld!: (value: ResolvedAsset) => void;
    const resolveAsset = vi.fn<(id: string) => Promise<ResolvedAsset>>((id: string) =>
      id === "old"
        ? new Promise<ResolvedAsset>((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(asset(id)),
    );
    const media = (id: string): RichTextDocument => ({
      type: "document",
      children: [
        {
          type: "media",
          mediaType: "image",
          source: "asset",
          assetId: id,
          originalSource: `${id}.png`,
          alt: id,
          title: null,
        },
      ],
    });
    const wrapper = mount(RichTextRenderer, { props: { document: media("old"), resolveAsset } });
    await wrapper.setProps({ document: media("new") });
    await flushPromises();
    resolveOld(asset("old"));
    await flushPromises();
    expect(wrapper.get("img").attributes("src")).toBe("/api/assets/new/content");
    await wrapper.get("img").trigger("error");
    await wrapper.setProps({ document: media("recovered") });
    await flushPromises();
    expect(wrapper.get("img").attributes("src")).toBe("/api/assets/recovered/content");
  });
});
