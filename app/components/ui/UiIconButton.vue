<script setup lang="ts">
import type { UiControlState, UiPreviewState } from "./UiButton.vue";
import UiTooltip from "./UiTooltip.vue";

withDefaults(
  defineProps<{
    controls?: string;
    disabled?: boolean;
    expanded?: boolean;
    label: string;
    previewState?: UiPreviewState;
    state?: UiControlState;
    tooltip?: string;
    type?: "button" | "reset" | "submit";
  }>(),
  {
    controls: undefined,
    disabled: false,
    expanded: undefined,
    previewState: null,
    state: "default",
    tooltip: undefined,
    type: "button",
  },
);
</script>

<template>
  <UiTooltip :text="tooltip ?? label">
    <template #default="{ tooltipId }">
      <button
        :type="type"
        class="ui-icon-button interactive-control"
        :class="previewState === null ? null : `is-${previewState}`"
        :aria-label="label"
        :aria-controls="controls"
        :aria-expanded="expanded"
        :aria-describedby="tooltipId"
        :aria-busy="state === 'loading' ? 'true' : undefined"
        :data-state="state === 'default' ? undefined : state"
        :disabled="disabled || state === 'loading'"
      >
        <slot />
      </button>
    </template>
  </UiTooltip>
</template>
