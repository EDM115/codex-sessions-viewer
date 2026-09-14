<script setup lang="ts">
import type { ReasoningActivity } from "#shared/types/conversation.ts";
import type { ResolvedAsset } from "#shared/types/repository.ts";

import type { MediaViewerItem } from "../../composables/useMediaViewer.ts";
import RichTextRenderer from "../content/RichTextRenderer.vue";

defineProps<{
  activity: ReasoningActivity;
  resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
  resolveFavicon?: (origin: string) => Promise<string | null>;
}>();
const emit = defineEmits<{ openMedia: [item: MediaViewerItem] }>();
</script>

<template>
  <article class="conversation-work-entry conversation-reasoning" :data-entry-id="activity.id">
    <p class="conversation-work-entry__label">Reasoning</p>
    <RichTextRenderer
      v-if="activity.body !== null"
      :document="activity.body"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      @open-media="emit('openMedia', $event)"
    />
    <p v-else class="conversation-work-entry__empty">Reasoning details unavailable</p>
  </article>
</template>
