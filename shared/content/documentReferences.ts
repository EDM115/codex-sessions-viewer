import type { RichTextDocument, RichTextNode } from "#shared/types/richText.ts";

export function documentReferences(document: RichTextDocument) {
  const origins = new Set<string>();
  const urls = new Set<string>();
  const assetIds = new Set<string>();
  function visit(nodes: readonly RichTextNode[]) {
    for (const node of nodes) {
      if (node.type === "link" && node.origin !== null) {
        origins.add(node.origin);
        urls.add(node.url);
      }
      if (node.type === "media" && node.assetId !== null) {
        assetIds.add(node.assetId);
      }
      if ("children" in node) {
        visit(node.children);
      }
    }
  }
  visit(document.children);
  return { origins, urls, assetIds };
}
