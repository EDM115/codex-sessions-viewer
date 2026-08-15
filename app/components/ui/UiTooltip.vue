<script setup lang="ts">
import { onBeforeUnmount, ref, useId } from "vue";

const props = withDefaults(
  defineProps<{
    hoverDelay?: number;
    text: string;
  }>(),
  { hoverDelay: 800 },
);

const tooltipId = useId();
const visible = ref(false);
let hoverTimer: ReturnType<typeof setTimeout> | undefined;

function clearHoverTimer(): void {
  if (hoverTimer !== undefined) {
    clearTimeout(hoverTimer);
    hoverTimer = undefined;
  }
}

function schedulePointerTooltip(): void {
  clearHoverTimer();
  hoverTimer = setTimeout(() => {
    visible.value = true;
  }, props.hoverDelay);
}

function showImmediately(): void {
  clearHoverTimer();
  visible.value = true;
}

function hide(): void {
  clearHoverTimer();
  visible.value = false;
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    hide();
  }
}

onBeforeUnmount(clearHoverTimer);
</script>

<template>
  <span
    class="ui-tooltip"
    @pointerenter="schedulePointerTooltip"
    @pointerleave="hide"
    @focusin="showImmediately"
    @focusout="hide"
    @keydown="handleKeydown"
  >
    <slot :tooltip-id="tooltipId" />
    <span v-if="visible" :id="tooltipId" class="ui-tooltip__bubble" role="tooltip">
      {{ text }}
    </span>
  </span>
</template>
