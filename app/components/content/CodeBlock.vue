<script setup lang="ts">
import { PhCheck, PhCopy, PhFileCode, PhTextAlignLeft, PhWarning } from "@phosphor-icons/vue";
import { computed, ref } from "vue";

import type { RichTextCodeNode } from "#shared/types/richText.ts";

import { useClipboard } from "../../composables/useClipboard.ts";
import UiIconButton from "../ui/UiIconButton.vue";
import DiffBlock from "./DiffBlock.client.vue";
import RichTextNode from "./RichTextNode.vue";

const props = defineProps<{ node: RichTextCodeNode }>();

const languageNames: Readonly<Record<string, string>> = {
  bash: "Bash",
  css: "CSS",
  diff: "Diff",
  html: "HTML",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  markdown: "Markdown",
  md: "Markdown",
  patch: "Patch",
  powershell: "PowerShell",
  python: "Python",
  sh: "Shell",
  shell: "Shell",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  vue: "Vue",
  yaml: "YAML",
  yml: "YAML",
};

const wrapped = ref(false);
const { copyText, state } = useClipboard();
const isDiff = computed(() => ["diff", "patch"].includes(props.node.language?.toLowerCase() ?? ""));
const language = computed(() => {
  const value = props.node.language?.trim().toLowerCase();
  return value === undefined || value === "" ? "Plain text" : (languageNames[value] ?? value);
});
const copyLabel = computed(() => (state.value === "success" ? "Copied: Copy code" : "Copy code"));
</script>

<template>
  <figure class="rich-code-block" :class="wrapped ? 'is-wrapped' : null">
    <figcaption class="rich-code-block__header">
      <span class="rich-code-block__identity">
        <PhFileCode :size="17" weight="regular" aria-hidden="true" />
        <span class="rich-code-block__language">{{ language }}</span>
        <span v-if="node.title !== null" class="rich-code-block__title">{{ node.title }}</span>
      </span>
      <span class="rich-code-block__actions">
        <UiIconButton :label="copyLabel" :state="state" @click="copyText(node.source)">
          <PhCheck v-if="state === 'success'" :size="16" weight="regular" aria-hidden="true" />
          <PhWarning v-else-if="state === 'error'" :size="16" weight="regular" aria-hidden="true" />
          <PhCopy v-else :size="16" weight="regular" aria-hidden="true" />
        </UiIconButton>
        <UiIconButton
          :label="wrapped ? 'Disable code wrapping' : 'Wrap code'"
          :state="wrapped ? 'success' : 'default'"
          @click="wrapped = !wrapped"
        >
          <PhTextAlignLeft :size="16" weight="regular" aria-hidden="true" />
        </UiIconButton>
      </span>
    </figcaption>
    <div class="rich-code-block__scroller" tabindex="0">
      <DiffBlock v-if="isDiff" :source="node.source" :wrapped="wrapped" />
      <template v-else-if="node.highlighted !== null">
        <RichTextNode
          v-for="(child, index) in node.highlighted.children"
          :key="index"
          mode="highlighted"
          :node="child"
        />
      </template>
      <pre v-else><code>{{ node.source }}</code></pre>
    </div>
    <p v-if="state === 'error'" class="rich-content-error" role="status">
      Code copy failed. Select the source or retry.
    </p>
  </figure>
</template>
