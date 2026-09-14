<script setup lang="ts">
import { PhArrowUpRight } from "@phosphor-icons/vue";

import type { SearchHit } from "#shared/types/repository.ts";

import { useOptionalLibraryWorkspace } from "../../composables/useLibraryWorkspace.ts";
import SearchExcerpt from "./SearchExcerpt.vue";
const workspace = useOptionalLibraryWorkspace();

defineProps<{
  hits: SearchHit[];
  query: string;
}>();

function destination(hit: SearchHit) {
  const sessionId = encodeURIComponent(hit.sessionId);
  const turnId = encodeURIComponent(hit.turnId);
  return (
    workspace?.sessionDestination(hit.sessionId, hit.turnId) ??
    `/session/${sessionId}?turn=${turnId}#turn-${turnId}`
  );
}

function parentDestination(parentThreadId: string) {
  return (
    workspace?.sessionDestination(parentThreadId) ??
    `/session/${encodeURIComponent(parentThreadId)}`
  );
}
</script>

<template>
  <div class="library-search-results" aria-label="Search results">
    <div v-for="hit in hits" :key="`${hit.sessionId}:${hit.turnId}`">
      <NuxtLink class="library-search-hit" :to="destination(hit)" :prefetch="false">
        <span class="library-search-hit__heading">
          <span><span v-if="hit.parentThreadId">Subagent · </span>{{ hit.title }}</span>
          <PhArrowUpRight :size="16" weight="regular" aria-hidden="true" />
        </span>
        <SearchExcerpt :excerpt="hit.excerpt" />
        <span class="library-search-hit__destination tabular">Exact turn · {{ hit.turnId }}</span>
      </NuxtLink>
      <NuxtLink
        v-if="hit.parentThreadId"
        class="library-search-hit__destination"
        :to="parentDestination(hit.parentThreadId)"
        :prefetch="false"
        >Open parent conversation</NuxtLink
      >
    </div>
  </div>
</template>
