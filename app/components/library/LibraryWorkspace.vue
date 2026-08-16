<script setup lang="ts">
import { PhSidebarSimple } from "@phosphor-icons/vue";
import { onBeforeUnmount, onMounted, watch } from "vue";

import {
  createLibraryWorkspace,
  provideLibraryWorkspace,
} from "../../composables/useLibraryWorkspace.ts";
import UiIconButton from "../ui/UiIconButton.vue";
import LibrarySidebar from "./LibrarySidebar.vue";

const workspace = createLibraryWorkspace();
provideLibraryWorkspace(workspace);
const initial = await useAsyncData("library-workspace-initial", () => workspace.loadPayload(), {
  immediate: workspace.mode === "static",
  server: workspace.mode === "static",
});

watch(
  initial.data,
  (payload) => {
    if (payload !== undefined && payload !== null) {
      workspace.hydrate(payload);
    }
  },
  { immediate: true },
);
watch(
  initial.error,
  (error) => {
    if (error !== undefined && error !== null) {
      workspace.error.value = error.message;
      workspace.loading.value = false;
    }
  },
  { immediate: true },
);

onMounted(workspace.start);
onBeforeUnmount(workspace.stop);
</script>

<template>
  <div class="library-workbench" @keydown.esc="workspace.closeSidebar">
    <UiIconButton
      class="library-workbench__opener"
      label="Open session library"
      controls="session-library-panel"
      :expanded="workspace.sidebarOpen.value"
      @click="workspace.sidebarOpen.value = true"
    >
      <PhSidebarSimple :size="21" weight="regular" aria-hidden="true" />
    </UiIconButton>
    <button
      v-if="workspace.sidebarOpen.value"
      class="library-workbench__scrim"
      type="button"
      aria-label="Close session library"
      @click="workspace.closeSidebar"
    />
    <div
      id="session-library-panel"
      class="library-workbench__rail"
      :class="workspace.sidebarOpen.value ? 'is-open' : null"
    >
      <LibrarySidebar
        :scope="workspace.scope.value"
        :counts="workspace.counts"
        :query="workspace.query.value"
        :model="workspace.model.value"
        :cwd="workspace.cwd.value"
        :tool="workspace.tool.value"
        :has-media="workspace.hasMedia.value"
        :items="workspace.items.value"
        :hits="workspace.hits.value"
        :loading="workspace.loading.value"
        :error="workspace.error.value"
        :settled-total="workspace.settledTotal.value"
        :next-cursor="workspace.nextCursor.value"
        :mode="workspace.mode"
        :search-exact-turns="workspace.searchExactTurns"
        :selected-id="workspace.selectedId.value"
        @close="workspace.closeSidebar"
        @load-more="workspace.refresh(true)"
        @retry="workspace.refresh()"
        @update:scope="workspace.updateQuery('scope', $event)"
        @update:query="workspace.updateQuery('q', $event)"
        @update:model="workspace.updateQuery('model', $event)"
        @update:cwd="workspace.updateQuery('cwd', $event)"
        @update:tool="workspace.updateQuery('tool', $event)"
        @update:has-media="workspace.updateQuery('media', $event)"
      />
    </div>
    <div class="library-workbench__canvas">
      <slot />
    </div>
  </div>
</template>
