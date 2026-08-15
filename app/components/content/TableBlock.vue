<script setup lang="ts">
import { PhCaretDown, PhCheck, PhCopy, PhWarning } from "@phosphor-icons/vue";
import { computed, ref } from "vue";

import type { ResolvedAsset } from "#shared/types/repository.ts";
import type { RichTextElementNode, RichTextNode } from "#shared/types/richText.ts";

import { useClipboard } from "../../composables/useClipboard.ts";
import type { MediaViewerItem } from "../../composables/useMediaViewer.ts";
import UiIconButton from "../ui/UiIconButton.vue";
import RichTextNodeComponent from "./RichTextNode.vue";

const props = withDefaults(
  defineProps<{
    node: RichTextElementNode;
    resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
    resolveFavicon?: (origin: string) => Promise<string | null>;
  }>(),
  { resolveAsset: undefined, resolveFavicon: undefined },
);
const emit = defineEmits<{ openMedia: [item: MediaViewerItem] }>();

function textContent(node: RichTextNode): string {
  if (node.type === "text") {
    return node.text;
  }
  if ("children" in node) {
    return node.children.map(textContent).join("");
  }
  return node.type === "code" || node.type === "mermaid" ? node.source : node.alt;
}

function rows(node: RichTextElementNode): string[][] {
  const output: string[][] = [];
  function visit(candidate: RichTextNode): void {
    if (candidate.type !== "element") {
      return;
    }
    if (candidate.tagName === "tr") {
      output.push(
        candidate.children
          .filter(
            (child): child is RichTextElementNode =>
              child.type === "element" && (child.tagName === "th" || child.tagName === "td"),
          )
          .map((cell) => cell.children.map(textContent).join("").trim()),
      );
      return;
    }
    candidate.children.forEach(visit);
  }
  node.children.forEach(visit);
  return output;
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\s*\n\s*/gu, " ");
}

function csvCell(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

const menuOpen = ref(false);
const tableRows = computed(() => rows(props.node));
const markdown = computed(() => {
  const [head = [], ...body] = tableRows.value;
  if (head.length === 0) {
    return "";
  }
  const row = (cells: string[]) => `| ${cells.map(markdownCell).join(" | ")} |`;
  return [row(head), row(head.map(() => "---")), ...body.map(row)].join("\n");
});
const csv = computed(() => tableRows.value.map((row) => row.map(csvCell).join(",")).join("\n"));
const { copyText, state } = useClipboard();

async function copy(value: string): Promise<void> {
  await copyText(value);
  menuOpen.value = false;
}
</script>

<template>
  <figure class="rich-table" @keydown.esc="menuOpen = false">
    <figcaption class="rich-table__header">
      <span>Table</span>
      <span class="rich-table__menu">
        <UiIconButton
          label="Copy table options"
          :expanded="menuOpen"
          :state="state"
          @click="menuOpen = !menuOpen"
        >
          <PhCheck v-if="state === 'success'" :size="16" weight="regular" aria-hidden="true" />
          <PhWarning v-else-if="state === 'error'" :size="16" weight="regular" aria-hidden="true" />
          <PhCaretDown v-else :size="16" weight="regular" aria-hidden="true" />
        </UiIconButton>
        <span v-if="menuOpen" class="ui-menu__surface" role="menu">
          <button type="button" role="menuitem" @click="copy(markdown)">
            <PhCopy :size="16" weight="regular" aria-hidden="true" />
            Copy Markdown
          </button>
          <button type="button" role="menuitem" @click="copy(csv)">
            <PhCopy :size="16" weight="regular" aria-hidden="true" />
            Copy CSV
          </button>
        </span>
      </span>
    </figcaption>
    <div class="rich-table__scroller" tabindex="0">
      <table>
        <RichTextNodeComponent
          v-for="(child, index) in node.children"
          :key="index"
          :node="child"
          :resolve-asset="resolveAsset"
          :resolve-favicon="resolveFavicon"
          @open-media="emit('openMedia', $event)"
        />
      </table>
    </div>
    <p v-if="state === 'error'" class="rich-content-error" role="status">
      Table copy failed. Select the cells or retry.
    </p>
  </figure>
</template>
