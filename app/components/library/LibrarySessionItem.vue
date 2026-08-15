<script setup lang="ts">
import { PhArchive, PhImage, PhWarningCircle } from "@phosphor-icons/vue";

import type { ConversationSummary } from "#shared/types/conversation.ts";

defineProps<{
  groupLabel?: string;
  selected: boolean;
  session: ConversationSummary;
}>();

function destination(id: string): string {
  return `/session/${encodeURIComponent(id)}`;
}
</script>

<template>
  <div class="library-session-row">
    <p v-if="groupLabel" class="library-session-group">{{ groupLabel }}</p>
    <a
      class="library-session-item"
      :class="selected ? 'is-selected' : null"
      :href="destination(session.id)"
      :aria-current="selected ? 'page' : undefined"
    >
      <span class="library-session-item__heading">
        <span class="library-session-item__title">{{ session.title }}</span>
        <PhArchive
          v-if="session.scope === 'archived'"
          :size="14"
          weight="regular"
          aria-label="Archived"
        />
        <PhImage v-if="session.hasMedia" :size="14" weight="regular" aria-label="Has media" />
        <PhWarningCircle
          v-if="session.diagnosticCount > 0"
          class="library-session-item__warning"
          :size="14"
          weight="regular"
          :aria-label="`${session.diagnosticCount} diagnostics`"
        />
      </span>
      <span class="library-session-item__preview">{{
        session.preview || "No transcript preview"
      }}</span>
      <span class="library-session-item__metadata tabular">
        <span>{{ session.updatedAt.slice(0, 10) }}</span>
        <span>{{ session.turnCount }} turns</span>
        <span>{{ session.models[0] ?? "unknown model" }}</span>
      </span>
    </a>
  </div>
</template>
