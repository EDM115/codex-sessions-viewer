<script setup lang="ts">
import type { FileDiffMetadata } from "@pierre/diffs";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import { useContentTheme } from "./useContentTheme.ts";

const props = defineProps<{ source: string; wrapped: boolean }>();
interface DiffInstance {
  cleanUp(): void;
  render(options: { fileDiff: FileDiffMetadata; fileContainer: HTMLElement }): boolean;
  rerender(): void;
  setOptions(options: { overflow: "scroll" | "wrap" }): void;
}
const container = ref<HTMLElement | null>(null);
const state = ref<"error" | "loading" | "ready">("loading");
const theme = useContentTheme();
let instances: DiffInstance[] = [];
let generation = 0;
let library: Promise<typeof import("@pierre/diffs")> | undefined;

function clear(): void {
  for (const instance of instances) {
    instance.cleanUp();
  }
  instances = [];
  container.value?.replaceChildren();
}

async function renderSource(): Promise<void> {
  const current = ++generation;
  const source = props.source;
  clear();
  state.value = "loading";
  try {
    const { FileDiff, parsePatchFiles } = await (library ??= import("@pierre/diffs"));
    if (current !== generation || container.value === null) {
      return;
    }
    const files = parsePatchFiles(source, undefined, true).flatMap((patch) => patch.files);
    if (files.length === 0) {
      throw new Error("The source did not contain a unified file patch.");
    }
    const renderedFiles = new Set<number>();
    const markRendered = (index: number) => {
      if (current !== generation) {
        return;
      }
      renderedFiles.add(index);
      if (renderedFiles.size === files.length) {
        state.value = "ready";
      }
    };
    for (const [index, fileDiff] of files.entries()) {
      const target = document.createElement("div");
      target.dataset["diffFile"] = String(index);
      container.value.append(target);
      const instance = new FileDiff({
        diffStyle: "unified",
        hunkSeparators: "metadata",
        overflow: props.wrapped ? "wrap" : "scroll",
        theme: { dark: "pierre-dark", light: "pierre-light" },
        themeType: theme.value,
        onPostRender: (_, __, phase) => {
          if (phase !== "unmount") {
            markRendered(index);
          }
        },
      });
      instances.push(instance);
      if (instance.render({ fileDiff, fileContainer: target })) {
        markRendered(index);
      }
    }
  } catch {
    if (current !== generation) {
      return;
    }
    clear();
    state.value = "error";
  }
}

onMounted(() => {
  watch(
    [() => props.source, theme],
    () => {
      void renderSource();
    },
    { immediate: true },
  );
});
watch(
  () => props.wrapped,
  (wrapped) => {
    for (const instance of instances) {
      instance.setOptions({ overflow: wrapped ? "wrap" : "scroll" });
      instance.rerender();
    }
  },
);
onBeforeUnmount(() => {
  ++generation;
  clear();
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
