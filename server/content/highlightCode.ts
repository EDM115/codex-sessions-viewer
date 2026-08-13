import type { Properties, RootContent } from "hast";
import { codeToHast } from "shiki";

import {
  highlightedCodeRootSchema,
  type HighlightedCodeNode,
  type HighlightedCodeRoot,
  type RichTextAttribute,
} from "../../shared/types/richText.ts";

const safeStyle =
  /^(?:(?:background-color|color):#[\da-f]{6})(?:;(?:(?:background-color|color):#[\da-f]{6}))*$/iu;

function safeAttributes(properties: Properties | undefined): Record<string, RichTextAttribute> {
  const result: Record<string, RichTextAttribute> = {};
  if (properties === undefined) {
    return result;
  }
  const className = properties["className"] ?? properties["class"];
  if (typeof className === "string" || Array.isArray(className)) {
    result["className"] = Array.isArray(className)
      ? className.filter((value): value is string => typeof value === "string")
      : className;
  }
  const style = properties["style"];
  if (typeof style === "string" && safeStyle.test(style)) {
    result["style"] = style;
  }
  return result;
}

function highlightedNode(node: RootContent): HighlightedCodeNode | null {
  if (node.type === "text") {
    return { type: "text", text: node.value ?? "" };
  }
  if (
    node.type !== "element" ||
    (node.tagName !== "pre" && node.tagName !== "code" && node.tagName !== "span")
  ) {
    return null;
  }
  return {
    type: "element",
    tagName: node.tagName,
    attributes: safeAttributes(node.properties),
    children: (node.children ?? [])
      .map(highlightedNode)
      .filter((child): child is HighlightedCodeNode => child !== null),
  };
}

export async function highlightCode(
  source: string,
  language: string | null,
): Promise<HighlightedCodeRoot | null> {
  if (language === null || language.trim() === "") {
    return null;
  }
  try {
    const tree = await codeToHast(source, {
      lang: language,
      theme: "github-dark-default",
    });
    return highlightedCodeRootSchema.parse({
      type: "root",
      children: (tree.children ?? [])
        .map(highlightedNode)
        .filter((child): child is HighlightedCodeNode => child !== null),
    });
  } catch {
    return null;
  }
}
