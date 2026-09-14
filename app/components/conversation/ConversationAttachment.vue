<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";

import type { ResolvedAsset } from "#shared/types/repository.ts";
import type { RichTextMediaNode } from "#shared/types/richText.ts";

import type { MediaViewerItem } from "../../composables/useMediaViewer.ts";
import MediaBlock from "../content/MediaBlock.vue";
const props = defineProps<{
  assetId: string;
  resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
}>();
const emit = defineEmits<{ openMedia: [item: MediaViewerItem] }>();
const asset = shallowRef<ResolvedAsset | null>(null);
const state = shallowRef("Loading cached attachment…");
watch(
  () => [props.assetId, props.resolveAsset] as const,
  async ([id, resolver], _, onCleanup) => {
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    asset.value = null;
    state.value = "Loading cached attachment…";
    if (resolver === undefined) {
      state.value = "Cached attachment is unavailable.";
      return;
    }
    try {
      const resolved = await resolver(id);
      if (!cancelled) {
        asset.value = resolved;
      }
    } catch {
      if (!cancelled) {
        state.value = "Cached attachment could not be read.";
      }
    }
  },
  { immediate: true },
);
const node = computed<RichTextMediaNode>(() => ({
  type: "media",
  mediaType: asset.value?.mimeType?.startsWith("image/")
    ? "image"
    : asset.value?.mimeType?.startsWith("audio/")
      ? "audio"
      : asset.value?.mimeType?.startsWith("video/")
        ? "video"
        : "file",
  source: "asset",
  assetId: props.assetId,
  originalSource: asset.value?.originalPath ?? "attachment",
  alt: asset.value?.originalPath?.split(/[\\/]/u).at(-1) ?? "Attachment",
  title: null,
}));
async function resolveCached(): Promise<ResolvedAsset> {
  return asset.value!;
}
</script>
<template>
  <div class="conversation-attachment" :data-asset-id="assetId">
    <MediaBlock
      v-if="asset !== null"
      :node="node"
      :resolve-asset="resolveCached"
      @open-media="emit('openMedia', $event)"
    />
    <p v-else role="status">{{ state }}</p>
  </div>
</template>
