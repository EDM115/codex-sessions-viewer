<script setup lang="ts">
import { PhCaretRight, PhFolder, PhFolderOpen } from "@phosphor-icons/vue";
import { computed } from "vue";

import type { ConversationProject } from "#shared/types/library.ts";

import { useLibraryWorkspace } from "../../composables/useLibraryWorkspace.ts";
import UiButton from "../ui/UiButton.vue";
import LibraryEmptyState from "./LibraryEmptyState.vue";
import LibrarySessionTree from "./LibrarySessionTree.vue";
import LibrarySkeleton from "./LibrarySkeleton.vue";

const props = defineProps<{ project: ConversationProject }>();
const workspace = useLibraryWorkspace();
const expanded = computed(() => workspace.expandedProjectIds.value.has(props.project.id));
const page = computed(() => workspace.projectPages.get(props.project.id));
const count = computed(() =>
  workspace.scope.value === "active" ? props.project.activeCount : props.project.archivedCount,
);
</script>

<template>
  <section class="library-project-folder">
    <button
      class="library-project-folder__toggle"
      type="button"
      :aria-expanded="expanded"
      :aria-controls="`project-${project.id}`"
      @click="workspace.toggleProject(project.id)"
    >
      <PhCaretRight
        class="library-tree-caret"
        :class="expanded ? 'is-open' : null"
        :size="14"
        weight="bold"
        aria-hidden="true"
      />
      <PhFolderOpen v-if="expanded" :size="17" weight="regular" aria-hidden="true" />
      <PhFolder v-else :size="17" weight="regular" aria-hidden="true" />
      <span class="library-project-folder__label">
        <span>{{ project.name }}</span>
        <small v-if="project.hint">{{ project.hint }}</small>
      </span>
      <span class="tabular">{{ count }}</span>
    </button>
    <div v-if="expanded" :id="`project-${project.id}`" class="library-project-folder__content">
      <LibrarySkeleton v-if="page?.loading && page.items.length === 0" :rows="3" />
      <LibraryEmptyState
        v-else-if="page?.error"
        title="This project could not be loaded"
        :description="page.error"
        recoverable
        @retry="workspace.loadProject(project.id)"
      />
      <template v-else>
        <LibrarySessionTree v-for="item in page?.items ?? []" :key="item.summary.id" :item="item" />
        <UiButton
          v-if="page?.nextCursor"
          class="library-project-folder__more"
          variant="quiet"
          :disabled="page.loading"
          @click="workspace.loadProject(project.id, true)"
        >
          {{ page.loading ? "Loading…" : "Load 20 more" }}
        </UiButton>
      </template>
    </div>
  </section>
</template>
