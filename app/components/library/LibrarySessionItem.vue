<script setup lang="ts">
import type { LibraryEntry } from "#shared/types/library.ts";

defineProps<{ selected: boolean; item: LibraryEntry }>();
const workspace = useOptionalLibraryWorkspace();

function destination(id: string) {
  return workspace?.sessionDestination(id) ?? `/session/${encodeURIComponent(id)}`;
}
</script>

<template>
  <div class="library-session-row">
    <NuxtLink
      class="library-session-item"
      :class="selected ? 'is-selected' : null"
      :to="destination(item.id)"
      :prefetch="false"
      :aria-current="selected ? 'page' : undefined"
      :aria-label="item.title"
      :title="item.title"
    >
      <span class="library-session-item__title">{{ item.title }}</span>
    </NuxtLink>
  </div>
</template>
