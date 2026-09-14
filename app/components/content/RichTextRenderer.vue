<script setup lang="ts">
import { computed, useId } from "vue";

import type { ResolvedAsset } from "#shared/types/repository.ts";
import type {
  RichTextDocument,
  RichTextNode as RichNode,
  RichTextAttribute,
} from "#shared/types/richText.ts";

import type { MediaViewerItem } from "../../composables/useMediaViewer.ts";
import RichTextNode from "./RichTextNode.vue";

const props = withDefaults(
  defineProps<{
    document: RichTextDocument;
    resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
    resolveFavicon?: (origin: string) => Promise<string | null>;
  }>(),
  {
    resolveAsset: undefined,
    resolveFavicon: undefined,
  },
);

const emit = defineEmits<{ openMedia: [item: MediaViewerItem] }>();
const scope = `rich-${useId().replaceAll(/[^a-z\d_-]/giu, "")}`;
const scopedChildren = computed(() => {
  const ids = new Set<string>();
  function collect(node: RichNode): void {
    if (
      (node.type === "element" || node.type === "link") &&
      typeof node.attributes?.["id"] === "string"
    ) {
      ids.add(node.attributes["id"]);
    }
    if ("children" in node) {
      node.children.forEach(collect);
    }
  }
  props.document.children.forEach(collect);
  const scopedId = (id: string) => (ids.has(id) ? `${scope}-${id}` : id);
  function rewrite(node: RichNode): RichNode {
    if (!("children" in node)) {
      return node;
    }
    const children = node.children.map(rewrite);
    if (node.type === "alert") {
      return { ...node, children };
    }
    const attributes: Record<string, RichTextAttribute> = { ...node.attributes };
    if (typeof attributes["id"] === "string") {
      attributes["id"] = scopedId(attributes["id"]);
    }
    for (const key of ["ariaDescribedBy", "ariaLabelledBy"]) {
      const value = attributes[key];
      if (Array.isArray(value)) {
        attributes[key] = value.map(scopedId);
      } else if (typeof value === "string") {
        attributes[key] = value.split(/\s+/u).map(scopedId).join(" ");
      }
    }
    return node.type === "link"
      ? {
          ...node,
          attributes,
          children,
          url: node.url.startsWith("#") ? `#${scopedId(node.url.slice(1))}` : node.url,
        }
      : { ...node, attributes, children };
  }
  return props.document.children.map(rewrite);
});
</script>

<template>
  <div class="rich-text-document">
    <RichTextNode
      v-for="(node, index) in scopedChildren"
      :key="index"
      :node="node"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      @open-media="emit('openMedia', $event)"
    />
  </div>
</template>
