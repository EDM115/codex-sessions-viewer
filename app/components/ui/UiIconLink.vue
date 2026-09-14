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
      <NuxtLink
        class="ui-icon-button interactive-control"
        :to="href"
        :prefetch="false"
        :aria-label="label"
        :aria-describedby="tooltipId"
      >
        <slot />
      </NuxtLink>
    </template>
  </UiTooltip>
</template>
