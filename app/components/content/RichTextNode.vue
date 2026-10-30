<script setup lang="ts">
import type { ResolvedAsset } from "#shared/types/repository.ts";
import type {
  HighlightedCodeNode,
  RichTextAttribute,
  RichTextNode,
} from "#shared/types/richText.ts";
import { safeCodeStyle } from "#shared/utils/codeStyles.ts";
import type { MediaViewerItem } from "~/composables/useMediaViewer.ts";

const props = withDefaults(
  defineProps<{
    mode?: "highlighted" | "rich";
    node: HighlightedCodeNode | RichTextNode;
    resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
    resolveFavicon?: (origin: string) => Promise<string | null>;
  }>(),
  {
    mode: "rich",
    resolveAsset: undefined,
    resolveFavicon: undefined,
  },
);
const emit = defineEmits<{ openMedia: [item: MediaViewerItem] }>();

function safeAttributeName(name: string): boolean {
  return !/^on/iu.test(name) && name !== "href" && name !== "src" && name !== "style";
}

function richAttributes(
  attributes: Record<string, RichTextAttribute>,
): Record<string, RichTextAttribute> {
  return Object.fromEntries(
    Object.entries(attributes)
      .filter(([name]) => safeAttributeName(name))
      .map(([name, value]) => [
        name === "className" ? "class" : name.replace(/^aria/u, "aria-").toLowerCase(),
        value,
      ]),
  );
}

function highlightedAttributes(
  attributes: Record<string, RichTextAttribute>,
): Record<string, RichTextAttribute> {
  const output: Record<string, RichTextAttribute> = {};
  const className = attributes["className"] ?? attributes["class"];
  if (typeof className === "string" || Array.isArray(className)) {
    output["class"] = className;
  }
  const style = attributes["style"];
  if (typeof style === "string" && safeCodeStyle(style) !== "") {
    output["style"] = safeCodeStyle(style);
  }
  return output;
}

const elementAttributes = computed(() => {
  if (props.node.type !== "element") {
    return {};
  }
  return props.mode === "highlighted"
    ? highlightedAttributes(props.node.attributes)
    : richAttributes(props.node.attributes);
});
</script>

<template>
  <template v-if="node.type === 'text'">{{ node.text }}</template>
  <ContentTableBlock
    v-else-if="mode === 'rich' && node.type === 'element' && node.tagName === 'table'"
    :node="node"
    :resolve-asset="resolveAsset"
    :resolve-favicon="resolveFavicon"
    @open-media="emit('openMedia', $event)"
  />
  <component :is="node.tagName" v-else-if="node.type === 'element'" v-bind="elementAttributes">
    <RichTextNode
      v-for="(child, index) in node.children"
      :key="index"
      :mode="mode"
      :node="child"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      @open-media="emit('openMedia', $event)"
    />
  </component>
  <ContentRichLink
    v-else-if="node.type === 'link'"
    :node="node"
    :resolve-asset="resolveAsset"
    :resolve-favicon="resolveFavicon"
    @open-media="emit('openMedia', $event)"
  />
  <ContentCodeBlock v-else-if="node.type === 'code'" :node="node" />
  <aside v-else-if="node.type === 'alert'" class="rich-alert" :data-kind="node.kind">
    <p class="rich-alert__label">{{ node.kind }}</p>
    <RichTextNode
      v-for="(child, index) in node.children"
      :key="index"
      :node="child"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      @open-media="emit('openMedia', $event)"
    />
  </aside>
  <ContentMermaidBlock
    v-else-if="node.type === 'mermaid'"
    :source="node.source"
    @open-media="emit('openMedia', $event)"
  />
  <ContentMediaBlock
    v-else-if="node.type === 'media'"
    :node="node"
    :resolve-asset="resolveAsset"
    @open-media="emit('openMedia', $event)"
  />
</template>
