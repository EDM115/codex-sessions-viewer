<script setup lang="ts">
import { PhCheckCircle, PhSpinnerGap, PhWarningCircle } from "@phosphor-icons/vue";
import { computed } from "vue";

export type UiControlState = "default" | "loading" | "error" | "success";
export type UiPreviewState = "hover" | "focus" | "active" | null;

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
    previewState?: UiPreviewState;
    state?: UiControlState;
    type?: "button" | "reset" | "submit";
    variant?: "primary" | "secondary" | "quiet";
  }>(),
  {
    disabled: false,
    previewState: null,
    state: "default",
    type: "button",
    variant: "secondary",
  },
);

const unavailable = computed(() => props.disabled || props.state === "loading");
</script>

<template>
  <button
    :type="type"
    class="ui-button interactive-control"
    :class="[`ui-button--${variant}`, previewState === null ? null : `is-${previewState}`]"
    :data-state="state === 'default' ? undefined : state"
    :disabled="unavailable"
    :aria-busy="state === 'loading' ? 'true' : undefined"
  >
    <PhSpinnerGap
      v-if="state === 'loading'"
      class="ui-control__state-icon ui-control__state-icon--spinning"
      :size="18"
      weight="regular"
      aria-hidden="true"
    />
    <PhWarningCircle
      v-else-if="state === 'error'"
      class="ui-control__state-icon"
      :size="18"
      weight="regular"
      aria-hidden="true"
    />
    <PhCheckCircle
      v-else-if="state === 'success'"
      class="ui-control__state-icon"
      :size="18"
      weight="regular"
      aria-hidden="true"
    />
    <slot />
  </button>
</template>
