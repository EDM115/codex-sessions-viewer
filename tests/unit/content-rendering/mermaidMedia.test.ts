import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RichTextRenderer from "../../../app/components/content/RichTextRenderer.vue";
import type { ResolvedAsset } from "../../../shared/types/repository.ts";
import type { RichTextDocument } from "../../../shared/types/richText.ts";

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn<(config: Record<string, unknown>) => void>(),
  render: vi.fn<(id: string, source: string) => Promise<{ svg: string }>>(async () => ({
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><script>alert(1)</script><foreignObject><p>HTML</p></foreignObject><text>Safe graph</text></svg>',
  })),
}));

vi.mock("mermaid", () => ({ default: mermaidMocks }));
enableAutoUnmount(afterEach);

function document(children: RichTextDocument["children"]): RichTextDocument {
  return { type: "document", children };
}

describe("Task 11 Mermaid and inline media", () => {
  beforeEach(() => {
    mermaidMocks.initialize.mockClear();
    mermaidMocks.render.mockClear();
    mermaidMocks.render.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><script>alert(1)</script><foreignObject><p>HTML</p></foreignObject><text>Safe graph</text></svg>',
    });
  });

  it("keeps Mermaid source untouched until Preview is explicitly selected", async () => {
    const source = "graph TD\n  A[Source] --> B[Preview]";
    const wrapper = mount(RichTextRenderer, {
      props: { document: document([{ type: "mermaid", source }]) },
    });

    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toBe("Code");
    expect(wrapper.get("pre").text()).toBe(source);
    expect(mermaidMocks.render).not.toHaveBeenCalled();

    await wrapper.get('[role="tab"][aria-label="Preview Mermaid diagram"]').trigger("click");
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(mermaidMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        htmlLabels: false,
        securityLevel: "strict",
        startOnLoad: false,
        suppressErrorRendering: true,
      }),
    );
    expect(mermaidMocks.render).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/u), source);
    expect(wrapper.get("[data-mermaid-preview] svg").text()).toContain("Safe graph");
    expect(wrapper.find("[data-mermaid-preview] script").exists()).toBe(false);
    expect(wrapper.find("[data-mermaid-preview] foreignObject").exists()).toBe(false);

    await wrapper.get('button[aria-label="Open Mermaid diagram"]').trigger("click");
    expect(wrapper.emitted("openMedia")?.at(-1)?.[0]).toMatchObject({
      kind: "svg",
      alt: "Mermaid diagram",
      source,
    });
  });

  it("shows a readable Mermaid error and preserves the Code tab source", async () => {
    mermaidMocks.render.mockRejectedValueOnce(new Error("Parse error on line 2"));
    const source = "graph ???";
    const wrapper = mount(RichTextRenderer, {
      props: { document: document([{ type: "mermaid", source }]) },
    });

    await wrapper.get('[role="tab"][aria-label="Preview Mermaid diagram"]').trigger("click");
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(wrapper.get('[role="status"]').text()).toContain("Mermaid preview failed");
    await wrapper.get('[role="tab"][aria-label="Show Mermaid code"]').trigger("click");
    expect(wrapper.get("pre").text()).toBe(source);
  });

  it("resolves local images through the repository and never fetches remote image bodies", async () => {
    const resolved: ResolvedAsset = {
      id: "asset-diagram",
      url: "/api/assets/asset-diagram/content",
      mimeType: "image/png",
      byteSize: 123,
      sha256: "a".repeat(64),
      width: 640,
      height: 360,
      status: "available",
      originalPath: "C:\\work\\diagram.png",
    };
    const resolveAsset = vi.fn<(assetId: string) => Promise<ResolvedAsset>>(async () => resolved);
    const wrapper = mount(RichTextRenderer, {
      props: {
        document: document([
          {
            type: "media",
            mediaType: "image",
            source: "asset",
            assetId: "asset-diagram",
            originalSource: "C:\\work\\diagram.png",
            alt: "Architecture diagram",
            title: null,
          },
          {
            type: "media",
            mediaType: "image",
            source: "external",
            assetId: null,
            originalSource: "https://cdn.example/remote.png",
            alt: "Remote diagram",
            title: null,
          },
        ]),
        resolveAsset,
      },
    });
    await vi.dynamicImportSettled();
    await flushPromises();

    const image = wrapper.get('img[alt="Architecture diagram"]');
    expect(image.attributes()).toMatchObject({
      src: "/api/assets/asset-diagram/content",
      loading: "lazy",
      width: "640",
      height: "360",
    });
    expect(resolveAsset).toHaveBeenCalledWith("asset-diagram");
    expect(wrapper.find('img[src="https://cdn.example/remote.png"]').exists()).toBe(false);
    expect(wrapper.get('a[href="https://cdn.example/remote.png"]').attributes("target")).toBe(
      "_blank",
    );

    await wrapper.get('button[aria-label="Open image: Architecture diagram"]').trigger("click");
    expect(wrapper.emitted("openMedia")?.at(-1)?.[0]).toMatchObject({
      kind: "image",
      src: "/api/assets/asset-diagram/content",
      width: 640,
      height: 360,
    });
  });

  it("keeps cached audio inline with local controls and download", async () => {
    const wrapper = mount(RichTextRenderer, {
      props: {
        document: document([
          {
            type: "media",
            mediaType: "audio",
            source: "asset",
            assetId: "asset-audio",
            originalSource: "C:\\work\\note.wav",
            alt: "Voice note",
            title: null,
          },
        ]),
        resolveAsset: async () => ({
          id: "asset-audio",
          url: "/api/assets/asset-audio/content",
          mimeType: "audio/wav",
          byteSize: 456,
          sha256: "b".repeat(64),
          width: null,
          height: null,
          status: "available",
          originalPath: "C:\\work\\note.wav",
        }),
      },
    });
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(wrapper.get("audio").attributes()).toMatchObject({
      controls: "",
      preload: "metadata",
      src: "/api/assets/asset-audio/content",
    });
    expect(wrapper.get('a[aria-label="Download audio"]').attributes()).toMatchObject({
      href: "/api/assets/asset-audio/content",
      download: "note.wav",
    });
  });

  it("renders cached files, missing sources, unavailable assets, and resolver failures without remote fetches", async () => {
    const resolveAsset = vi.fn<(assetId: string) => Promise<ResolvedAsset>>(
      async (assetId: string): Promise<ResolvedAsset> => {
        if (assetId === "asset-reject") {
          throw new Error("cache unavailable");
        }
        return {
          id: assetId,
          url: assetId === "asset-file" ? "/api/assets/asset-file/content" : null,
          mimeType: assetId === "asset-file" ? "image/svg+xml" : null,
          byteSize: assetId === "asset-file" ? 42 : null,
          sha256: assetId === "asset-file" ? "c".repeat(64) : null,
          width: null,
          height: null,
          status: assetId === "asset-file" ? "available" : "missing",
          originalPath: null,
        };
      },
    );
    const wrapper = mount(RichTextRenderer, {
      props: {
        document: document([
          {
            type: "media",
            mediaType: "file",
            source: "asset",
            assetId: "asset-file",
            originalSource: "data:image/svg+xml;base64,AA==",
            alt: "",
            title: null,
          },
          {
            type: "media",
            mediaType: "video",
            source: "missing",
            assetId: null,
            originalSource: "C:\\lost\\clip.mp4",
            alt: "",
            title: null,
          },
          {
            type: "media",
            mediaType: "image",
            source: "asset",
            assetId: null,
            originalSource: "",
            alt: "",
            title: null,
          },
          {
            type: "media",
            mediaType: "image",
            source: "asset",
            assetId: "asset-missing",
            originalSource: "missing.png",
            alt: "Missing image",
            title: null,
          },
          {
            type: "media",
            mediaType: "audio",
            source: "asset",
            assetId: "asset-reject",
            originalSource: "broken",
            alt: "Broken audio",
            title: null,
          },
        ]),
        resolveAsset,
      },
    });
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(wrapper.get('a[download="attachment.svg"]').attributes("href")).toBe(
      "/api/assets/asset-file/content",
    );
    expect(wrapper.text()).toContain("Download cached file");
    expect(wrapper.text()).toContain("clip.mp4");
    expect(wrapper.text()).toContain("attachment.bin");
    expect(wrapper.text()).toContain("Missing image");
    expect(wrapper.text()).toContain("Broken audio");
    expect(wrapper.findAll("[role=status]")).toHaveLength(4);
    expect(resolveAsset).toHaveBeenCalledTimes(3);
  });

  it("uses image fallbacks and marks an available image unavailable after a decode error", async () => {
    const wrapper = mount(RichTextRenderer, {
      props: {
        document: document([
          {
            type: "media",
            mediaType: "image",
            source: "asset",
            assetId: "asset-photo",
            originalSource: "C:\\work\\photo",
            alt: "",
            title: null,
          },
        ]),
        resolveAsset: async () => ({
          id: "asset-photo",
          url: "/api/assets/asset-photo/content",
          mimeType: null,
          byteSize: 12,
          sha256: "d".repeat(64),
          width: null,
          height: null,
          status: "available",
          originalPath: null,
        }),
      },
    });
    await vi.dynamicImportSettled();
    await flushPromises();

    const open = wrapper.get('button[aria-label="Open image: photo"]');
    await open.trigger("click");
    expect(wrapper.emitted("openMedia")?.at(-1)?.[0]).toMatchObject({
      alt: "photo",
      filename: "photo",
      mimeType: "image/png",
      width: null,
      height: null,
    });
    await wrapper.get("img").trigger("error");
    expect(wrapper.find('button[aria-label="Open image: photo"]').exists()).toBe(false);
    expect(wrapper.get("[role=status]").text()).toContain("Cached media is unavailable");
  });

  it("supports Mermaid keyboard tabs, sanitizes URL attributes, and renders at most once", async () => {
    globalThis.document.documentElement.style.colorScheme = "dark";
    mermaidMocks.render.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" onclick="bad()"><a href="javascript:bad()"><text onmouseover="bad()">Safe</text></a></svg>',
    });
    const wrapper = mount(RichTextRenderer, {
      props: { document: document([{ type: "mermaid", source: "graph TD; A-->B" }]) },
    });
    const tabs = wrapper.get('[role="tablist"]');
    await tabs.trigger("keydown", { key: "PageDown" });
    expect(mermaidMocks.render).not.toHaveBeenCalled();
    await tabs.trigger("keydown", { key: "Home" });
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(mermaidMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark" }),
    );
    expect(wrapper.get("[data-mermaid-preview] svg").attributes("onclick")).toBeUndefined();
    expect(wrapper.get("[data-mermaid-preview] a").attributes("href")).toBeUndefined();
    expect(wrapper.get("[data-mermaid-preview] text").attributes("onmouseover")).toBeUndefined();
    await wrapper.get('[role="tab"][aria-label="Preview Mermaid diagram"]').trigger("click");
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(mermaidMocks.render).toHaveBeenCalledTimes(1);
    await tabs.trigger("keydown", { key: "End" });
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toBe("Code");
    globalThis.document.documentElement.style.colorScheme = "";
  });

  it("rejects non-SVG Mermaid output and does not open an idle preview", async () => {
    mermaidMocks.render.mockResolvedValueOnce({ svg: "<html><body>not svg</body></html>" });
    const wrapper = mount(RichTextRenderer, {
      props: { document: document([{ type: "mermaid", source: "invalid" }]) },
    });

    await wrapper.get('button[aria-label="Open Mermaid diagram"]').trigger("click");
    expect(wrapper.emitted("openMedia")).toBeUndefined();
    await wrapper.get('[role="tab"][aria-label="Preview Mermaid diagram"]').trigger("click");
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain("Mermaid preview failed");
  });

  it("replaces a mounted diagram source and cannot commit an obsolete asynchronous render", async () => {
    let resolveOld!: (value: { svg: string }) => void;
    mermaidMocks.render.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const wrapper = mount(RichTextRenderer, {
      props: { document: document([{ type: "mermaid", source: "graph TD; Old-->OldResult" }]) },
    });
    await wrapper.get('[aria-label="Preview Mermaid diagram"]').trigger("click");
    await vi.dynamicImportSettled();
    await flushPromises();
    mermaidMocks.render.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Current graph</text><image href="https://remote.example/image.png" /></svg>',
    });
    await wrapper.setProps({
      document: document([{ type: "mermaid", source: "graph TD; New-->Current" }]),
    });
    await vi.dynamicImportSettled();
    await flushPromises();
    resolveOld({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Obsolete graph</text></svg>',
    });
    await flushPromises();
    expect(wrapper.get("[data-mermaid-preview] svg").text()).toBe("Current graph");
    expect(wrapper.get("[data-mermaid-preview] image").attributes("href")).toBeUndefined();
    expect(mermaidMocks.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ layout: "dagre", look: "classic", htmlLabels: false }),
    );
  });
});
