import { describe, expect, it } from "vitest";

import { parseRichText } from "../../../server/content/parseRichText.ts";
import type { RichTextNode } from "../../../shared/types/richText.ts";

const flatten = (nodes: readonly RichTextNode[]): RichTextNode[] =>
  nodes.flatMap((node) => [node, ...("children" in node ? flatten(node.children) : [])]);

describe("rich-content destination and source regressions", () => {
  it.each([
    "C:/work/reader.ts:12:4",
    "C:\\work\\reader.ts#L12C4",
    "\\\\server\\share\\reader.ts:12",
    "file://server/share/reader.ts#L12",
    "/work/reader.ts:12",
    "C:/work/my%20file.ts:12",
    "C:/work/my file.ts:12",
    "C:/work/my(file).ts:12",
    "\\\\server\\share\\my(file).ts:12",
  ])("preserves inert local destination %s", async (path) => {
    const { document } = await parseRichText(`[reader](<${path}>)`);
    expect(flatten(document.children)).toContainEqual(
      expect.objectContaining({ type: "link", url: path, origin: null }),
    );
  });

  it("keeps HTTP, mailto and fragment semantics", async () => {
    const { document } = await parseRichText(
      "[web](https://example.com/x) [mail](mailto:a@example.com) [fragment](#outside)",
      { baseUrl: "https://base.example/" },
    );
    expect(
      flatten(document.children)
        .filter((node) => node.type === "link")
        .map((node) => node.url),
    ).toEqual(["https://example.com/x", "mailto:a@example.com", "#outside"]);
  });

  it("normalizes footnote references, repeated backlinks and accessibility targets", async () => {
    const { document } = await parseRichText("Note[^1] and again[^1].\n\n[^1]: Body.");
    const nodes = flatten(document.children);
    const ids = nodes.flatMap((node) =>
      (node.type === "element" || node.type === "link") &&
      typeof node.attributes?.["id"] === "string"
        ? [node.attributes["id"]]
        : [],
    );
    const references = nodes
      .filter((node) => node.type === "link")
      .filter((node) => node.url.startsWith("#"));
    expect(references).toHaveLength(4);
    for (const node of references) {
      expect(ids).toContain(node.url.slice(1));
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("user-content-user-content-fn-1");
  });

  it("infers safe raw HTML language classes and preserves raw trailing newlines", async () => {
    const { document } = await parseRichText(
      '<pre><code class="language-python">print("hello")\n</code></pre>\n\n<pre><code data-language="ts" class="language-python">const n = 1</code></pre>',
    );
    const blocks = flatten(document.children).filter((node) => node.type === "code");
    expect(blocks[0]).toMatchObject({
      language: "python",
      source: 'print("hello")\n',
      highlighted: expect.any(Object),
    });
    expect(blocks[1]).toMatchObject({
      language: "ts",
      source: "const n = 1",
      highlighted: expect.any(Object),
    });
    expect(JSON.stringify(blocks[0]?.highlighted)).toContain("light-dark(");
  });
});
