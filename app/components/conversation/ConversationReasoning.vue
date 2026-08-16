<script setup lang="ts">
import type { ReasoningActivity } from "#shared/types/conversation.ts";
import type { ResolvedAsset } from "#shared/types/repository.ts";

import RichTextRenderer from "../content/RichTextRenderer.vue";

defineProps<{
  activity: ReasoningActivity;
  resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
  resolveFavicon?: (origin: string) => Promise<string | null>;
}>();
</script>

<template>
  <article class="conversation-work-entry conversation-reasoning" :data-entry-id="activity.id">
    <p class="conversation-work-entry__label">Reasoning</p>
    <RichTextRenderer
      v-if="activity.body !== null"
      :document="activity.body"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
    />
    <p v-else class="conversation-work-entry__empty">Reasoning details unavailable</p>
  </article>
</template>
