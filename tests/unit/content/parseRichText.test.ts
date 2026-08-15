import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseRichText } from "../../../server/content/parseRichText.ts";
import type { RichTextNode } from "../../../shared/types/richText.ts";

function descendants(nodes: readonly RichTextNode[]): RichTextNode[] {
  return nodes.flatMap((node) => [node, ...("children" in node ? descendants(node.children) : [])]);
}

describe("rich-text parsing", () => {
  it("preserves GFM structures and safe details while stripping active HTML", async () => {
    const markdown = `# Parser notes

- [x] Preserve task lists
- [ ] Keep unchecked state

| Field | Value |
| --- | --- |
| model | gpt |

> [!WARNING]
> Treat fetched markup as hostile.

Read the [documentation](/docs?q=1) and the [unsafe link](javascript:alert(1)).

<details open onclick="alert(1)"><summary style="color:red">More</summary><p>Readable <strong>content</strong>.</p><script>alert(1)</script><iframe src="https://evil.example"></iframe></details>

Footnote reference[^1].

[^1]: Footnote body.
`;

    const result = await parseRichText(markdown, { baseUrl: "https://viewer.example/base/" });
    const nodes = descendants(result.document.children);
    const serialized = JSON.stringify(result.document);

    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "element", tagName: "table" }),
        expect.objectContaining({ type: "element", tagName: "details" }),
        expect.objectContaining({ type: "element", tagName: "summary" }),
        expect.objectContaining({ type: "alert", kind: "warning" }),
        expect.objectContaining({
          type: "link",
          url: "https://viewer.example/docs?q=1",
          origin: "https://viewer.example",
        }),
      ]),
    );
    expect(serialized).toContain("Footnote body");
    expect(serialized).not.toMatch(/script|iframe|onclick|javascript:|color:red/iu);
    expect(serialized).toContain("unsafe link");
  });

  it("creates explicit code, Mermaid, local, external, and embedded-media nodes", async () => {
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const dataUri = `data:image/png;base64,${pngBytes.toString("base64")}`;
    const markdown = `\`\`\`ts title="reader.ts"
const answer: number = 42
\`\`\`

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

\`\`\`made-up-language
plain <source>
\`\`\`

![local diagram](file:///C:/work/diagram.png)
![remote diagram](https://cdn.example/diagram.png)
![embedded pixel](${dataUri})
`;

    const result = await parseRichText(markdown, {
      assetIdsByPath: new Map([["C:\\work\\diagram.png", "asset-local-diagram"]]),
    });
    const nodes = descendants(result.document.children);
    const code = nodes.find((node) => node.type === "code");
    const unknown = nodes.find(
      (node) => node.type === "code" && node.language === "made-up-language",
    );

    expect(code).toMatchObject({
      type: "code",
      language: "ts",
      title: "reader.ts",
      source: "const answer: number = 42",
    });
    expect(code && code.type === "code" ? code.highlighted : null).not.toBeNull();
    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "mermaid", source: "graph TD\n  A --> B" }),
        expect.objectContaining({
          type: "media",
          source: "asset",
          assetId: "asset-local-diagram",
          originalSource: "C:\\work\\diagram.png",
        }),
        expect.objectContaining({
          type: "media",
          source: "external",
          assetId: null,
          originalSource: "https://cdn.example/diagram.png",
        }),
      ]),
    );
    expect(unknown).toMatchObject({ highlighted: null, source: "plain <source>" });
    expect(result.embeddedMedia).toEqual([
      expect.objectContaining({
        assetId: `asset-${createHash("sha256").update(pngBytes).digest("hex")}`,
        mimeType: "image/png",
        byteSize: pngBytes.byteLength,
        bytes: pngBytes,
      }),
    ]);
  });

  it("keeps malformed Markdown readable instead of dropping it", async () => {
    const result = await parseRichText("Before **unfinished\n\n<not-a-real-tag>after");

    expect(JSON.stringify(result.document)).toContain("Before");
    expect(JSON.stringify(result.document)).toContain("unfinished");
    expect(JSON.stringify(result.document)).toContain("after");
  });

  it("preserves inert file references for viewer-side path presentation", async () => {
    const result = await parseRichText(
      "Inspect [reader.ts](file:///C:/work/src/reader.ts#L12C4) before retrying.",
    );
    const nodes = descendants(result.document.children);

    expect(nodes).toContainEqual(
      expect.objectContaining({
        type: "link",
        url: "file:///C:/work/src/reader.ts#L12C4",
        origin: null,
      }),
    );
  });
});
