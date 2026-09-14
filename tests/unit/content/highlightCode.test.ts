import { describe, expect, it } from "vitest";

import { highlightCode } from "../../../server/content/highlightCode.ts";
import type { HighlightedCodeNode } from "../../../shared/types/richText.ts";

function renderedText(nodes: readonly HighlightedCodeNode[]): string {
  return nodes
    .map((node) => (node.type === "text" ? node.text : renderedText(node.children)))
    .join("");
}

describe("code highlighting", () => {
  it("returns a constrained Shiki AST without changing source code", async () => {
    const source = 'const answer: string = "<tag> & café";  \n\tconsole.log(answer);\n';
    const highlighted = await highlightCode(source, "ts");

    expect(highlighted).not.toBeNull();
    expect(renderedText(highlighted!.children)).toBe(source);
    expect(JSON.stringify(highlighted)).toContain("light-dark(");
  });

  it("falls back cleanly for an unknown language", async () => {
    await expect(highlightCode("plain <source>", "made-up-language")).resolves.toBeNull();
  });
});
