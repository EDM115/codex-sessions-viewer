<script setup lang="ts">
withDefaults(defineProps<{ rows?: number }>(), { rows: 5 });
</script>

<template>
  <div class="library-skeleton" aria-label="Loading sessions" role="status">
    <div v-for="row in rows" :key="row" class="library-skeleton__row">
      <span class="library-skeleton__line library-skeleton__line--title" />
      <span class="library-skeleton__line library-skeleton__line--body" />
      <span class="library-skeleton__line library-skeleton__line--meta" />
    </div>
  </div>
</template>
