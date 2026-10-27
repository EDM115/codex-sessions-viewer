<script setup lang="ts">
import { useLibraryWorkspace } from "../../composables/useLibraryWorkspace.ts";
import LibraryEmptyState from "./LibraryEmptyState.vue";
import LibraryProjectFolder from "./LibraryProjectFolder.vue";

const workspace = useLibraryWorkspace();
</script>

<template>
  <nav class="library-project-tree" aria-label="Projects">
    <section
      v-for="group in workspace.sidebarGroups.value"
      :key="group.id"
      :aria-label="group.name ?? undefined"
    >
      <h3 v-if="group.name">{{ group.name }}</h3>
      <LibraryProjectFolder
        v-for="project in group.projects"
        :key="project.id"
        :project="project"
        :label="project.sidebar?.kind === 'section' ? 'Chats' : undefined"
      />
    </section>
    <LibraryEmptyState
      v-if="workspace.sidebarGroups.value.length === 0"
      :title="`No ${workspace.scope.value} conversations`"
      description="The viewer found no root conversations in this scope."
    />
  </nav>
</template>
