<script setup lang="ts">
import { PhDotsThree } from "@phosphor-icons/vue";
import { nextTick, ref, useId } from "vue";

defineProps<{
  label: string;
}>();

const open = ref(false);
const menuId = useId();

async function toggle(): Promise<void> {
  open.value = !open.value;
  if (open.value) {
    await nextTick();
    document.getElementById(menuId)?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    open.value = false;
  }
}
</script>

<template>
  <span class="ui-menu" @keydown="handleKeydown">
    <button
      type="button"
      class="ui-icon-button interactive-control"
      :aria-label="label"
      :aria-controls="menuId"
      :aria-expanded="open"
      @click="toggle"
    >
      <PhDotsThree :size="20" weight="regular" aria-hidden="true" />
    </button>
    <span v-if="open" :id="menuId" class="ui-menu__surface" role="menu">
      <slot />
    </span>
  </span>
</template>
