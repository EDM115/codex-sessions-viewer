<script setup lang="ts">
import { PhCheck, PhCopy, PhFile, PhGlobe, PhWarning } from "@phosphor-icons/vue";
import { computed, onMounted, ref, watch } from "vue";

import type { ResolvedAsset } from "#shared/types/repository.ts";
import type { RichTextLinkNode, RichTextNode as RichNode } from "#shared/types/richText.ts";

import { useClipboard } from "../../composables/useClipboard.ts";
import type { MediaViewerItem } from "../../composables/useMediaViewer.ts";
import UiIconButton from "../ui/UiIconButton.vue";
import { faviconRevision } from "./faviconAvailability.ts";
import RichTextNode from "./RichTextNode.vue";

const props = withDefaults(
  defineProps<{
    node: RichTextLinkNode;
    resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
    resolveFavicon?: (origin: string) => Promise<string | null>;
  }>(),
  { resolveAsset: undefined, resolveFavicon: undefined },
);
const emit = defineEmits<{ openMedia: [item: MediaViewerItem] }>();

interface FileReference {
  column: number | null;
  line: number | null;
  path: string;
}

function coordinates(value: string): { column: number | null; line: number | null } {
  const match = /(?:#L|:)(\d+)(?:C|:)(\d+)$/iu.exec(value) ?? /(?:#L|:)(\d+)$/iu.exec(value);
  return {
    line: match?.[1] === undefined ? null : Number.parseInt(match[1], 10),
    column: match?.[2] === undefined ? null : Number.parseInt(match[2], 10),
  };
}

function fileReference(value: string): FileReference | null {
  const isFileUrl = value.toLowerCase().startsWith("file://");
  const isLocalPath = /^(?:[a-z]:[\\/]|\\\\|\.\.?[\\/]|\/)/iu.test(value);
  if (!isFileUrl && !isLocalPath) {
    return null;
  }
  const position = coordinates(value);
  let path = value.replace(/#L\d+(?:C\d+)?$/iu, "").replace(/:\d+(?::\d+)?$/u, "");
  if (isFileUrl) {
    try {
      const url = new URL(path);
      path = `${url.hostname ? `//${url.hostname}` : ""}${url.pathname}`;
      if (/^\/[a-z]:\//iu.test(path)) {
        path = path.slice(1);
      }
    } catch {
      path = path.slice("file://".length);
    }
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    /* Preserve malformed literal percent encodings. */
  }
  if (/^(?:[a-z]:\/|\/\/)/iu.test(path)) {
    path = path.replaceAll("/", "\\");
  }
  return { path, ...position };
}

const file = computed(() => (props.node.origin === null ? fileReference(props.node.url) : null));
function containsMedia(node: RichNode): boolean {
  return (
    node.type === "media" ||
    node.type === "mermaid" ||
    ("children" in node && node.children.some(containsMedia))
  );
}
const hasMedia = computed(() => props.node.children.some(containsMedia));
const linkAttributes = computed(() =>
  Object.fromEntries(
    Object.entries(props.node.attributes ?? {})
      .filter(
        ([name]) =>
          name === "id" ||
          name === "ariaDescribedBy" ||
          name === "ariaLabelledBy" ||
          name === "ariaLabel",
      )
      .map(([name, value]) => [name.replace(/^aria/u, "aria-").toLowerCase(), value]),
  ),
);
const faviconUrl = ref<string | null>(null);
const faviconFailed = ref(false);
const { copyText, state } = useClipboard();
const copyLabel = computed(() =>
  state.value === "success" ? "Copied: Copy file path" : "Copy file path",
);
const external = computed(() => props.node.origin !== null);

onMounted(() => {
  watch(
    () =>
      [
        props.node.origin,
        props.resolveFavicon,
        props.node.origin === null ? undefined : faviconRevision(props.node.origin),
      ] as const,
    async ([origin, resolveFavicon, revision], _, onCleanup) => {
      let current = true;
      onCleanup(() => {
        current = false;
      });
      faviconUrl.value = null;
      faviconFailed.value = false;
      if (origin === null || resolveFavicon === undefined) {
        return;
      }
      try {
        const url = await resolveFavicon(origin);
        if (current && url !== null) {
          faviconUrl.value =
            revision === undefined
              ? url
              : `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(revision)}`;
        }
      } catch {
        if (current) {
          faviconUrl.value = null;
        }
      }
    },
    { immediate: true },
  );
});
</script>

<template>
  <span v-if="file !== null" class="rich-file-reference">
    <PhFile :size="16" weight="regular" aria-hidden="true" />
    <span class="rich-file-reference__label">
      <RichTextNode
        v-for="(child, index) in node.children"
        :key="index"
        :node="child"
        :resolve-asset="resolveAsset"
        :resolve-favicon="resolveFavicon"
        @open-media="emit('openMedia', $event)"
      />
    </span>
    <span class="rich-file-reference__path">{{ file.path }}</span>
    <span v-if="file.line !== null" class="rich-file-reference__position">
      L{{ file.line }}<template v-if="file.column !== null">:C{{ file.column }}</template>
    </span>
    <UiIconButton :label="copyLabel" :state="state" @click="copyText(file.path)">
      <PhCheck v-if="state === 'success'" :size="16" weight="regular" aria-hidden="true" />
      <PhWarning v-else-if="state === 'error'" :size="16" weight="regular" aria-hidden="true" />
      <PhCopy v-else :size="16" weight="regular" aria-hidden="true" />
    </UiIconButton>
  </span>
  <span v-else-if="hasMedia" class="rich-linked-media">
    <RichTextNode
      v-for="(child, index) in node.children"
      :key="index"
      :node="child"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      @open-media="emit('openMedia', $event)"
    />
    <a
      class="rich-link"
      v-bind="linkAttributes"
      :href="node.url"
      :title="node.title ?? undefined"
      :target="external ? '_blank' : undefined"
      :rel="external ? 'noreferrer noopener' : undefined"
      >Open linked destination</a
    >
  </span>
  <a
    v-else
    class="rich-link"
    v-bind="linkAttributes"
    :href="node.url"
    :title="node.title ?? undefined"
    :target="external ? '_blank' : undefined"
    :rel="external ? 'noreferrer noopener' : undefined"
  >
    <span v-if="external" class="rich-link__icon" aria-hidden="true">
      <img
        v-if="faviconUrl !== null && !faviconFailed"
        :src="faviconUrl"
        alt=""
        width="16"
        height="16"
        @error="faviconFailed = true"
      />
      <PhGlobe v-else :size="16" weight="regular" />
    </span>
    <RichTextNode
      v-for="(child, index) in node.children"
      :key="index"
      :node="child"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      @open-media="emit('openMedia', $event)"
    />
  </a>
</template>
