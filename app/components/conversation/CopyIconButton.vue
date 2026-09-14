<script setup lang="ts">
import { PhCheck, PhCopy, PhWarning } from "@phosphor-icons/vue";
import { onBeforeUnmount, ref } from "vue";

const props = defineProps<{
  label: string;
  text: string | (() => string);
}>();

const state = ref<"default" | "error" | "success">("default");
let resetTimer: ReturnType<typeof setTimeout> | null = null;

async function copy(): Promise<void> {
  if (resetTimer !== null) {
    clearTimeout(resetTimer);
  }
  try {
    await navigator.clipboard.writeText(
      typeof props.text === "function" ? props.text() : props.text,
    );
    state.value = "success";
    resetTimer = setTimeout(() => {
      state.value = "default";
      resetTimer = null;
    }, 2_500);
  } catch {
    state.value = "error";
  }
}

onBeforeUnmount(() => {
  if (resetTimer !== null) {
    clearTimeout(resetTimer);
  }
});
</script>

<template>
  <span class="conversation-copy-action">
    <button
      type="button"
      class="ui-icon-button interactive-control"
      :aria-label="state === 'success' ? `Copied: ${label}` : label"
      :data-state="state === 'default' ? undefined : state"
      @click="copy"
    >
      <PhCheck v-if="state === 'success'" :size="17" weight="regular" aria-hidden="true" />
      <PhWarning v-else-if="state === 'error'" :size="17" weight="regular" aria-hidden="true" />
      <PhCopy v-else :size="17" weight="regular" aria-hidden="true" />
    </button>
    <span v-if="state === 'error'" class="conversation-copy-action__error" role="status">
      Copy failed. Select the text or retry.
    </span>
  </span>
</template>
