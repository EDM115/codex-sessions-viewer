<script setup lang="ts">
import { computed, ref } from "vue";

import type { JsonValue } from "#shared/types/conversation.ts";

import CopyIconButton from "./CopyIconButton.vue";
import { formattedJson } from "./format.ts";
import { boundedJson } from "./toolPresentation.ts";
const props = defineProps<{ value: JsonValue; label: string }>();
const open = ref(false);
const complete = ref(false);
const query = ref("");
const preview = computed(() => boundedJson(props.value));
const text = computed(() => (complete.value ? formattedJson(props.value) : preview.value.text));
const matchingText = computed(() =>
  query.value === ""
    ? text.value
    : text.value
        .split("\n")
        .filter((line) => line.toLocaleLowerCase().includes(query.value.toLocaleLowerCase()))
        .join("\n"),
);
</script>
<template>
  <details
    class="conversation-raw"
    @toggle="open = ($event.currentTarget as HTMLDetailsElement).open"
  >
    <summary>{{ label }}</summary>
    <div v-if="open" class="conversation-raw__body">
      <div class="conversation-raw__controls">
        <label>Find in displayed record <input v-model="query" type="search" /></label>
        <CopyIconButton :label="`Copy complete ${label}`" :text="() => formattedJson(value)" />
      </div>
      <p v-if="!complete && preview.partial">
        Partial preview. Copy includes the complete original value.
        <button type="button" @click="complete = true">Show complete value</button>
      </p>
      <p v-if="query && !matchingText">No matching lines in the displayed record.</p>
      <pre>{{ matchingText }}</pre>
    </div>
  </details>
</template>
<style scoped>
.conversation-raw {
  margin-block: 0.5rem;
  min-width: 0;
}
.conversation-raw summary {
  cursor: pointer;
}
.conversation-raw__controls {
  display: flex;
  gap: 0.5rem;
  justify-content: space-between;
  align-items: center;
}
.conversation-raw input {
  max-width: 100%;
  color: inherit;
  background: transparent;
  border: 1px solid currentColor;
  border-radius: 4px;
}
.conversation-raw pre {
  max-height: 28rem;
  overflow: auto;
  white-space: pre;
  font-size: 0.78rem;
}
</style>
