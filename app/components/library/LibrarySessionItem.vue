<script setup lang="ts">
import { PhArchive, PhImage, PhRobot, PhWarningCircle } from "@phosphor-icons/vue";
import { onBeforeUnmount, onMounted, ref } from "vue";

import type { ConversationListItem } from "#shared/types/library.ts";

import { useOptionalLibraryWorkspace } from "../../composables/useLibraryWorkspace.ts";

const props = defineProps<{
  groupLabel?: string;
  selected: boolean;
  item: ConversationListItem;
}>();
const workspace = useOptionalLibraryWorkspace();
const row = ref<HTMLElement | null>(null);
let stopObserving: () => void = () => undefined;

onMounted(() => {
  if (row.value !== null) {
    stopObserving = workspace?.observeSession(row.value, props.item) ?? (() => undefined);
  }
});

onBeforeUnmount(() => stopObserving());

function destination(id: string): string {
  return `/session/${encodeURIComponent(id)}`;
}
</script>

<template>
  <div ref="row" class="library-session-row">
    <p v-if="groupLabel" class="library-session-group">{{ groupLabel }}</p>
    <a
      class="library-session-item"
      :class="selected ? 'is-selected' : null"
      :href="destination(item.summary.id)"
      :aria-current="selected ? 'page' : undefined"
    >
      <span class="library-session-item__heading">
        <span class="library-session-item__title">{{ item.summary.title }}</span>
        <PhRobot
          v-if="item.kind === 'subagent'"
          :size="14"
          weight="regular"
          aria-label="Subagent"
        />
        <PhArchive
          v-if="item.summary.scope === 'archived'"
          :size="14"
          weight="regular"
          aria-label="Archived"
        />
        <PhImage v-if="item.summary.hasMedia" :size="14" weight="regular" aria-label="Has media" />
        <PhWarningCircle
          v-if="item.summary.diagnosticCount > 0"
          class="library-session-item__warning"
          :size="14"
          weight="regular"
          :aria-label="`${item.summary.diagnosticCount} diagnostics`"
        />
      </span>
      <span class="library-session-item__preview">{{
        item.summary.preview || "No transcript preview"
      }}</span>
      <span class="library-session-item__metadata tabular">
        <span>{{ item.summary.updatedAt.slice(0, 10) }}</span>
        <span v-if="item.materialization !== 'ready'">{{ item.materialization }}</span>
        <span v-else>{{ item.summary.turnCount }} turns</span>
        <span>{{ item.summary.models[0] ?? "model pending" }}</span>
      </span>
    </a>
    <button
      v-if="item.materialization === 'failed'"
      class="library-session-item__retry"
      type="button"
      @click="workspace?.retryPreparation(item.summary.id)"
    >
      Retry preparation
    </button>
  </div>
</template>
