<script setup lang="ts">
import { PhCaretRight, PhFolder, PhFolderOpen } from "@phosphor-icons/vue";

import type { CatalogProjectGroup } from "#shared/types/library.ts";

const props = defineProps<{ project: CatalogProjectGroup; label?: string | undefined }>();
const workspace = useLibraryWorkspace();
const expanded = computed(() => workspace.expandedProjectIds.value.has(props.project.groupId));
const page = computed(() => workspace.projectPages.get(props.project.groupId));
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
      :aria-controls="`project-${project.groupId}`"
      @click="workspace.toggleProject(project.groupId)"
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
        <span>{{ label ?? project.name }}</span>
      </span>
      <span class="tabular">{{ count }}</span>
    </button>
    <div v-if="expanded" :id="`project-${project.groupId}`" class="library-project-folder__content">
      <LibrarySkeleton v-if="page?.loading && page.items.length === 0" :rows="3" />
      <LibraryEmptyState
        v-else-if="page?.error"
        title="This project could not be loaded"
        :description="page.error"
        recoverable
        @retry="workspace.loadProject(project.groupId)"
      />
      <template v-else>
        <LibrarySessionTree v-for="item in page?.items ?? []" :key="item.id" :item="item" />
        <UiButton
          v-if="page?.nextCursor"
          class="library-project-folder__more"
          variant="quiet"
          :disabled="page.loading"
          @click="workspace.loadProject(project.groupId, true)"
        >
          {{ page.loading ? "Loading…" : "Load 20 more" }}
        </UiButton>
      </template>
    </div>
  </section>
</template>
