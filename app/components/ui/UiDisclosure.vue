<script setup lang="ts">
import { PhCaretRight } from "@phosphor-icons/vue";

withDefaults(
  defineProps<{
    label: string;
    open?: boolean;
  }>(),
  { open: false },
);
</script>

<template>
  <details class="ui-disclosure" :open="open">
    <summary class="ui-disclosure__summary interactive-control">
      <PhCaretRight class="ui-disclosure__caret" :size="18" weight="regular" aria-hidden="true" />
      <span>{{ label }}</span>
    </summary>
    <div class="ui-disclosure__content">
      <slot />
    </div>
  </details>
</template>
