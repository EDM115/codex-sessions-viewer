<script setup lang="ts">
import { PhArrowsClockwise, PhFolderOpen } from "@phosphor-icons/vue";

import UiButton from "../ui/UiButton.vue";

withDefaults(
  defineProps<{
    description: string;
    recoverable?: boolean;
    title: string;
  }>(),
  { recoverable: false },
);

defineEmits<{ retry: [] }>();
</script>

<template>
  <div class="library-empty" role="status">
    <PhFolderOpen :size="28" weight="regular" aria-hidden="true" />
    <h2>{{ title }}</h2>
    <p>{{ description }}</p>
    <UiButton v-if="recoverable" variant="secondary" @click="$emit('retry')">
      <PhArrowsClockwise :size="18" weight="regular" aria-hidden="true" />
      Retry
    </UiButton>
  </div>
</template>
