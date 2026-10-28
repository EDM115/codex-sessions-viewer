<script setup lang="ts">
import { PhCaretRight } from "@phosphor-icons/vue";
import { computed } from "vue";

import type { LibraryEntry } from "#shared/types/library.ts";

import { useLibraryWorkspace } from "../../composables/useLibraryWorkspace.ts";
import UiButton from "../ui/UiButton.vue";
import LibraryEmptyState from "./LibraryEmptyState.vue";
import LibrarySessionItem from "./LibrarySessionItem.vue";
import LibrarySkeleton from "./LibrarySkeleton.vue";

const props = defineProps<{ item: LibraryEntry }>();
const workspace = useLibraryWorkspace();
const expanded = computed(() => workspace.expandedSessionIds.value.has(props.item.id));
const page = computed(() => workspace.childPages.get(props.item.id));
const selected = computed(() => workspace.selectedId.value === props.item.id);
</script>

<template>
  <div class="library-session-tree">
    <div class="library-session-tree__row">
      <button
        v-if="item.childCount > 0"
        class="library-session-tree__toggle"
        type="button"
        :aria-label="`${expanded ? 'Collapse' : 'Expand'} subagents for ${item.title}`"
        :aria-expanded="expanded"
        :aria-controls="`children-${item.id}`"
        @click="workspace.toggleSession(item)"
      >
        <PhCaretRight
          class="library-tree-caret"
          :class="expanded ? 'is-open' : null"
          :size="13"
          weight="bold"
          aria-hidden="true"
        />
      </button>
      <span v-else class="library-session-tree__spacer" aria-hidden="true" />
      <LibrarySessionItem :item="item" :selected="selected" />
    </div>
    <div v-if="expanded" :id="`children-${item.id}`" class="library-session-tree__children">
      <LibrarySkeleton v-if="page?.loading && page.items.length === 0" :rows="2" />
      <LibraryEmptyState
        v-else-if="page?.error"
        title="Subagents could not be loaded"
        :description="page.error"
        recoverable
        @retry="workspace.loadChildren(item)"
      />
      <template v-else>
        <LibrarySessionTree v-for="child in page?.items ?? []" :key="child.id" :item="child" />
        <UiButton
          v-if="page?.nextCursor"
          variant="quiet"
          :disabled="page.loading"
          @click="workspace.loadChildren(item, true)"
        >
          {{ page.loading ? "Loading…" : "Load 20 more subagents" }}
        </UiButton>
      </template>
    </div>
  </div>
</template>
