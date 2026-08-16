<script setup lang="ts">
import { computed } from "vue";

import { useLibraryWorkspace } from "../../composables/useLibraryWorkspace.ts";
import LibraryEmptyState from "./LibraryEmptyState.vue";
import LibraryProjectFolder from "./LibraryProjectFolder.vue";

const workspace = useLibraryWorkspace();
const visibleProjects = computed(() =>
  workspace.projects.value.filter((project) =>
    workspace.scope.value === "active" ? project.activeCount > 0 : project.archivedCount > 0,
  ),
);
</script>

<template>
  <nav class="library-project-tree" aria-label="Projects">
    <LibraryProjectFolder v-for="project in visibleProjects" :key="project.id" :project="project" />
    <LibraryEmptyState
      v-if="visibleProjects.length === 0"
      :title="`No ${workspace.scope.value} conversations`"
      description="The viewer found no root conversations in this scope."
    />
  </nav>
</template>
