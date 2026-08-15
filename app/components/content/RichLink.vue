<script setup lang="ts">
import { PhCheck, PhCopy, PhFile, PhGlobe, PhWarning } from "@phosphor-icons/vue";
import { computed, onMounted, ref } from "vue";

import type { RichTextLinkNode } from "#shared/types/richText.ts";

import { useClipboard } from "../../composables/useClipboard.ts";
import UiIconButton from "../ui/UiIconButton.vue";
import RichTextNode from "./RichTextNode.vue";

const props = withDefaults(
  defineProps<{
    node: RichTextLinkNode;
    resolveFavicon?: (origin: string) => Promise<string | null>;
  }>(),
  { resolveFavicon: undefined },
);

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
      path = decodeURIComponent(new URL(path).pathname);
      if (/^\/[a-z]:\//iu.test(path)) {
        path = path.slice(1);
      }
    } catch {
      path = path.slice("file://".length);
    }
  }
  if (/^[a-z]:\//iu.test(path)) {
    path = path.replaceAll("/", "\\");
  }
  return { path, ...position };
}

const file = computed(() => fileReference(props.node.url));
const faviconUrl = ref<string | null>(null);
const faviconFailed = ref(false);
const { copyText, state } = useClipboard();
const copyLabel = computed(() =>
  state.value === "success" ? "Copied: Copy file path" : "Copy file path",
);
const external = computed(() => props.node.origin !== null);

onMounted(async () => {
  if (props.node.origin === null || props.resolveFavicon === undefined) {
    return;
  }
  try {
    faviconUrl.value = await props.resolveFavicon(props.node.origin);
  } catch {
    faviconUrl.value = null;
  }
});
</script>

<template>
  <span v-if="file !== null" class="rich-file-reference">
    <PhFile :size="16" weight="regular" aria-hidden="true" />
    <span class="rich-file-reference__label">
      <RichTextNode v-for="(child, index) in node.children" :key="index" :node="child" />
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
  <a
    v-else
    class="rich-link"
    :href="node.url"
    :title="node.title ?? undefined"
    :target="external ? '_blank' : undefined"
    :rel="external ? 'noreferrer noopener' : undefined"
  >
    <span class="rich-link__icon" aria-hidden="true">
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
    <RichTextNode v-for="(child, index) in node.children" :key="index" :node="child" />
  </a>
</template>
