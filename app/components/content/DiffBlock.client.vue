<script setup lang="ts">
import type { FileDiffMetadata } from "@pierre/diffs";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{
  source: string;
  wrapped: boolean;
}>();

interface DiffInstance {
  cleanUp(): void;
  render(options: { fileDiff: FileDiffMetadata; fileContainer: HTMLElement }): boolean;
  rerender(): void;
  setOptions(options: { overflow: "scroll" | "wrap" }): void;
}

const container = ref<HTMLElement | null>(null);
const state = ref<"error" | "loading" | "ready">("loading");
let instance: DiffInstance | null = null;
let disposed = false;

onMounted(async () => {
  const target = container.value;
  if (target === null) {
    return;
  }
  try {
    const { FileDiff, parsePatchFiles } = await import("@pierre/diffs");
    const fileDiff = parsePatchFiles(props.source, undefined, true).flatMap(
      ({ files }) => files,
    )[0];
    if (fileDiff === undefined) {
      throw new Error("The source did not contain a unified file patch.");
    }
    if (disposed) {
      return;
    }
    instance = new FileDiff({
      diffStyle: "unified",
      hunkSeparators: "metadata",
      overflow: props.wrapped ? "wrap" : "scroll",
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType: getComputedStyle(document.documentElement).colorScheme.includes("dark")
        ? "dark"
        : "light",
    });
    instance.render({ fileDiff, fileContainer: target });
    state.value = "ready";
  } catch {
    state.value = "error";
  }
});

watch(
  () => props.wrapped,
  (wrapped) => {
    instance?.setOptions({ overflow: wrapped ? "wrap" : "scroll" });
    instance?.rerender();
  },
);

onBeforeUnmount(() => {
  disposed = true;
  instance?.cleanUp();
  instance = null;
});
</script>

<template>
  <div class="rich-diff" data-diff-renderer="@pierre/diffs" :data-state="state">
    <div ref="container" class="rich-diff__rendered" aria-label="Rendered diff" />
    <p v-if="state === 'error'" class="rich-content-error" role="status">
      Diff preview failed. The original patch remains available.
    </p>
    <pre v-if="state !== 'ready'" class="rich-diff__source"><code>{{ source }}</code></pre>
  </div>
</template>
