import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import RichTextRenderer from "../../../app/components/content/RichTextRenderer.vue";
import type { RichTextDocument } from "../../../shared/types/richText.ts";

const diffMocks = vi.hoisted(() => ({
  cleanUp: vi.fn<() => void>(),
  parsePatchFiles: vi.fn<
    (
      source: string,
      filename?: string,
      stripPrefix?: boolean,
    ) => Array<{
      files: Array<{ marker: string }>;
    }>
  >(() => [{ files: [{ marker: "parsed-diff" }] }]),
  render: vi.fn<(options: unknown) => boolean>(() => true),
}));

vi.mock("@pierre/diffs", () => ({
  FileDiff: class {
    cleanUp = diffMocks.cleanUp;
    render = diffMocks.render;
  },
  parsePatchFiles: diffMocks.parsePatchFiles,
}));

function document(children: RichTextDocument["children"]): RichTextDocument {
  return { type: "document", children };
}

describe("Task 11 rich-text rendering", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recursively renders the typed allowlist and resolves only cached external-link icons", async () => {
    const resolveFavicon = vi.fn<(origin: string) => Promise<string | null>>(async (origin) =>
      origin === "https://nuxt.com" ? "/favicons/nuxt.png" : null,
    );
    const wrapper = mount(RichTextRenderer, {
      props: {
        document: document([
          {
            type: "element",
            tagName: "p",
            attributes: { onclick: "alert(1)" },
            children: [
              { type: "text", text: "Read " },
              {
                type: "link",
                url: "https://nuxt.com/docs",
                origin: "https://nuxt.com",
                title: "Nuxt docs",
                children: [
                  {
                    type: "element",
                    tagName: "strong",
                    attributes: {},
                    children: [{ type: "text", text: "Nuxt" }],
                  },
                ],
              },
              { type: "text", text: "." },
            ],
          },
        ]),
        resolveFavicon,
      },
    });
    await flushPromises();

    expect(wrapper.get("p").text()).toBe("Read Nuxt.");
    expect(wrapper.get("p").attributes("onclick")).toBeUndefined();
    expect(wrapper.get("a").attributes()).toMatchObject({
      href: "https://nuxt.com/docs",
      rel: "noreferrer noopener",
      target: "_blank",
      title: "Nuxt docs",
    });
    expect(wrapper.get('img[alt=""]').attributes("src")).toBe("/favicons/nuxt.png");
    expect(resolveFavicon).toHaveBeenCalledOnce();
    expect(resolveFavicon).toHaveBeenCalledWith("https://nuxt.com");
    expect(wrapper.html()).not.toContain("v-html");
  });

  it("shows normalized file coordinates and copies only the path", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const wrapper = mount(RichTextRenderer, {
      props: {
        document: document([
          {
            type: "link",
            url: "file:///C:/work/src/reader.ts#L12C4",
            origin: null,
            title: null,
            children: [{ type: "text", text: "reader.ts" }],
          },
        ]),
      },
    });

    expect(wrapper.get(".rich-file-reference__path").text()).toBe("C:\\work\\src\\reader.ts");
    expect(wrapper.get(".rich-file-reference__position").text()).toBe("L12:C4");
    await wrapper.get('button[aria-label="Copy file path"]').trigger("click");
    expect(writeText).toHaveBeenCalledWith("C:\\work\\src\\reader.ts");
    expect(wrapper.get('button[aria-label="Copied: Copy file path"]')).toBeTruthy();
  });

  it("renders safe highlighted code, preserves plain unknown languages, and toggles wrapping", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const wrapper = mount(RichTextRenderer, {
      props: {
        document: document([
          {
            type: "code",
            language: "ts",
            title: "reader.ts",
            source: "const answer = 42",
            highlighted: {
              type: "root",
              children: [
                {
                  type: "element",
                  tagName: "pre",
                  attributes: { className: ["shiki"], onclick: "alert(1)" },
                  children: [
                    {
                      type: "element",
                      tagName: "code",
                      attributes: {},
                      children: [{ type: "text", text: "const answer = 42" }],
                    },
                  ],
                },
              ],
            },
          },
          {
            type: "code",
            language: "made-up-language",
            title: null,
            source: "plain <source>",
            highlighted: null,
          },
        ]),
      },
    });

    const blocks = wrapper.findAll(".rich-code-block");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.get(".rich-code-block__language").text()).toBe("TypeScript");
    expect(blocks[0]?.get(".rich-code-block__title").text()).toBe("reader.ts");
    expect(blocks[0]?.get("pre").attributes("onclick")).toBeUndefined();
    expect(blocks[1]?.get("code").text()).toBe("plain <source>");
    expect(blocks[1]?.html()).not.toContain("&lt;source&gt;</code><source");

    await blocks[0]?.get('button[aria-label="Copy code"]').trigger("click");
    expect(writeText).toHaveBeenCalledWith("const answer = 42");
    await blocks[0]?.get('button[aria-label="Wrap code"]').trigger("click");
    expect(blocks[0]?.classes()).toContain("is-wrapped");
    expect(blocks[0]?.get('button[aria-label="Disable code wrapping"]')).toBeTruthy();
  });

  it("keeps tables inside their own scroll region and copies Markdown or CSV", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const wrapper = mount(RichTextRenderer, {
      props: {
        document: document([
          {
            type: "element",
            tagName: "table",
            attributes: {},
            children: [
              {
                type: "element",
                tagName: "thead",
                attributes: {},
                children: [
                  {
                    type: "element",
                    tagName: "tr",
                    attributes: {},
                    children: [
                      {
                        type: "element",
                        tagName: "th",
                        attributes: {},
                        children: [{ type: "text", text: "Field" }],
                      },
                      {
                        type: "element",
                        tagName: "th",
                        attributes: {},
                        children: [{ type: "text", text: "Value" }],
                      },
                    ],
                  },
                ],
              },
              {
                type: "element",
                tagName: "tbody",
                attributes: {},
                children: [
                  {
                    type: "element",
                    tagName: "tr",
                    attributes: {},
                    children: [
                      {
                        type: "element",
                        tagName: "td",
                        attributes: {},
                        children: [{ type: "text", text: "model" }],
                      },
                      {
                        type: "element",
                        tagName: "td",
                        attributes: {},
                        children: [{ type: "text", text: "gpt, exact" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ]),
      },
    });

    expect(wrapper.get(".rich-table__scroller").attributes("tabindex")).toBe("0");
    await wrapper.get('button[aria-label="Copy table options"]').trigger("click");
    const items = wrapper.findAll('[role="menuitem"]');
    await items[0]?.trigger("click");
    expect(writeText).toHaveBeenLastCalledWith(
      "| Field | Value |\n| --- | --- |\n| model | gpt, exact |",
    );
    await wrapper.get('button[aria-label="Copy table options"]').trigger("click");
    await wrapper.findAll('[role="menuitem"]')[1]?.trigger("click");
    expect(writeText).toHaveBeenLastCalledWith('Field,Value\nmodel,"gpt, exact"');
  });

  it("lazy-loads @pierre/diffs for unified patches and releases its DOM adapter", async () => {
    const source =
      "diff --git a/reader.ts b/reader.ts\n--- a/reader.ts\n+++ b/reader.ts\n@@ -1 +1 @@\n-old\n+new";
    const wrapper = mount(RichTextRenderer, {
      props: {
        document: document([
          {
            type: "code",
            language: "diff",
            title: "reader.ts",
            source,
            highlighted: null,
          },
        ]),
      },
    });
    await flushPromises();

    expect(diffMocks.parsePatchFiles).toHaveBeenCalledWith(source, undefined, true);
    expect(diffMocks.render).toHaveBeenCalledWith(
      expect.objectContaining({
        fileDiff: { marker: "parsed-diff" },
        fileContainer: expect.any(HTMLElement),
      }),
    );
    expect(wrapper.get('[data-diff-renderer="@pierre/diffs"]').attributes("data-state")).toBe(
      "ready",
    );

    wrapper.unmount();
    expect(diffMocks.cleanUp).toHaveBeenCalledOnce();
  });

  it("keeps invalid diff source readable when the renderer cannot parse it", async () => {
    diffMocks.parsePatchFiles.mockReturnValueOnce([]);
    const wrapper = mount(RichTextRenderer, {
      props: {
        document: document([
          {
            type: "code",
            language: "patch",
            title: null,
            source: "not a unified patch",
            highlighted: null,
          },
        ]),
      },
    });
    await flushPromises();

    expect(wrapper.get('[data-diff-renderer="@pierre/diffs"]').attributes("data-state")).toBe(
      "error",
    );
    expect(wrapper.get('[role="status"]').text()).toContain("Diff preview failed");
    expect(wrapper.get("pre").text()).toBe("not a unified patch");
  });
});
