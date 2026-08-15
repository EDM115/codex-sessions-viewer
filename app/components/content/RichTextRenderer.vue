<script setup lang="ts">
import type { ResolvedAsset } from "#shared/types/repository.ts";
import type { RichTextDocument } from "#shared/types/richText.ts";

import type { MediaViewerItem } from "../../composables/useMediaViewer.ts";
import RichTextNode from "./RichTextNode.vue";

withDefaults(
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
</script>

<template>
  <div class="rich-text-document">
    <RichTextNode
      v-for="(node, index) in document.children"
      :key="index"
      :node="node"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      @open-media="emit('openMedia', $event)"
    />
  </div>
</template>
