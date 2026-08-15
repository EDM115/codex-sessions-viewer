<script setup lang="ts">
import { PhArrowUpRight } from "@phosphor-icons/vue";

import type { SearchHit } from "#shared/types/repository.ts";

import SearchExcerpt from "./SearchExcerpt.vue";

defineProps<{
  hits: SearchHit[];
  query: string;
}>();

function destination(hit: SearchHit): string {
  const sessionId = encodeURIComponent(hit.sessionId);
  const turnId = encodeURIComponent(hit.turnId);
  return `/session/${sessionId}?turn=${turnId}#turn-${turnId}`;
}
</script>

<template>
  <div class="library-search-results" aria-label="Search results">
    <a
      v-for="hit in hits"
      :key="`${hit.sessionId}:${hit.turnId}`"
      class="library-search-hit"
      :href="destination(hit)"
    >
      <span class="library-search-hit__heading">
        <span>{{ hit.title }}</span>
        <PhArrowUpRight :size="16" weight="regular" aria-hidden="true" />
      </span>
      <SearchExcerpt :excerpt="hit.excerpt" />
      <span class="library-search-hit__destination tabular">Exact turn · {{ hit.turnId }}</span>
    </a>
  </div>
</template>
