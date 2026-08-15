<script setup lang="ts">
import { computed } from "vue";

import type { ToolActivity } from "#shared/types/conversation.ts";

import CopyIconButton from "./CopyIconButton.vue";
import { formatDuration, formattedJson } from "./format.ts";

const props = defineProps<{
  activity: ToolActivity;
}>();

const label = computed(
  () =>
    `${props.activity.namespace === null ? "tool" : props.activity.namespace}/${props.activity.name}`,
);
const duration = computed(() => formatDuration(props.activity.durationMs));
const input = computed(() => formattedJson(props.activity.input));
const output = computed(() => formattedJson(props.activity.output));
</script>

<template>
  <article
    class="conversation-tool-row"
    :class="activity.status === 'failed' ? 'is-failed' : null"
    :data-status="activity.status"
  >
    <header class="conversation-tool-row__header">
      <span class="conversation-tool-row__status" aria-hidden="true" />
      <strong>{{ label }}</strong>
      <span>{{ activity.status }}</span>
      <span v-if="duration !== null" class="tabular">{{ duration }}</span>
    </header>
    <div class="conversation-tool-row__payload">
      <div>
        <div class="conversation-tool-row__payload-heading">
          <span>Input</span><CopyIconButton label="Copy tool input" :text="input" />
        </div>
        <pre>{{ input }}</pre>
      </div>
      <div>
        <div class="conversation-tool-row__payload-heading">
          <span>Output</span><CopyIconButton label="Copy tool output" :text="output" />
        </div>
        <pre>{{ output }}</pre>
      </div>
    </div>
    <p v-if="activity.error !== null" class="conversation-tool-row__error">
      {{ activity.error }}
    </p>
  </article>
</template>
