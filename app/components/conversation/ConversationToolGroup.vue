<script setup lang="ts">
import { ref } from "vue";

import type { ConversationActivity } from "#shared/types/conversation.ts";
import type { InspectorTarget, ResolvedAsset } from "#shared/types/repository.ts";

import type { MediaViewerItem } from "../../composables/useMediaViewer.ts";
import ConversationWorkEntry from "./ConversationWorkEntry.vue";
import { groupLabel } from "./toolPresentation.ts";
defineProps<{
  activities: ConversationActivity[];
  resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
  resolveFavicon?: (origin: string) => Promise<string | null>;
}>();
const emit = defineEmits<{
  inspect: [target: InspectorTarget];
  openMedia: [item: MediaViewerItem];
  openChild: [id: string];
}>();
const open = ref(false);
</script>
<template>
  <details
    class="conversation-tool-group"
    :data-tool-group="activities[0]?.id"
    @toggle="open = ($event.currentTarget as HTMLDetailsElement).open"
  >
    <summary>
      {{ groupLabel(activities) }} <small>{{ activities.length }}</small>
    </summary>
    <div v-if="open" class="conversation-tool-group__entries">
      <ConversationWorkEntry
        v-for="activity in activities"
        :key="activity.id"
        :activity="activity"
        :resolve-asset="resolveAsset"
        :resolve-favicon="resolveFavicon"
        @inspect="emit('inspect', $event)"
        @open-media="emit('openMedia', $event)"
        @open-child="emit('openChild', $event)"
      />
    </div>
  </details>
</template>
<style scoped>
.conversation-tool-group > summary {
  cursor: pointer;
  padding-block: 0.5rem;
}
.conversation-tool-group > summary small {
  margin-inline-start: 0.5rem;
  opacity: 0.7;
}
.conversation-tool-group__entries {
  display: grid;
  gap: 0.5rem;
  padding-inline-start: 0.75rem;
  border-inline-start: 1px solid currentColor;
}
</style>
