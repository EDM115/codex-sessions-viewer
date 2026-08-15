<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ excerpt: string }>();

interface ExcerptSegment {
  highlighted: boolean;
  text: string;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

const segments = computed<ExcerptSegment[]>(() => {
  let highlighted = false;
  return props.excerpt.split(/(<\/?mark>)/giu).flatMap((part) => {
    if (part.toLocaleLowerCase() === "<mark>") {
      highlighted = true;
      return [];
    }
    if (part.toLocaleLowerCase() === "</mark>") {
      highlighted = false;
      return [];
    }
    return part === "" ? [] : [{ highlighted, text: decodeEntities(part) }];
  });
});
</script>

<template>
  <span class="search-excerpt">
    <template v-for="(segment, index) in segments" :key="`${index}-${segment.text}`">
      <mark v-if="segment.highlighted">{{ segment.text }}</mark>
      <span v-else>{{ segment.text }}</span>
    </template>
  </span>
</template>
