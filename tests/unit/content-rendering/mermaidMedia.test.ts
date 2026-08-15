import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
