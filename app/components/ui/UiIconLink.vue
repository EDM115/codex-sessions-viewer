<script setup lang="ts">
import UiTooltip from "./UiTooltip.vue";

defineProps<{
  href: string;
  label: string;
  tooltip?: string;
}>();
</script>

<template>
  <UiTooltip :text="tooltip ?? label">
    <template #default="{ tooltipId }">
      <a
        class="ui-icon-button interactive-control"
        :href="href"
        :aria-label="label"
        :aria-describedby="tooltipId"
      >
        <slot />
      </a>
    </template>
  </UiTooltip>
</template>
