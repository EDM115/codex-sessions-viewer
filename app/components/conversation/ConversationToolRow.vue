<script setup lang="ts">
import { computed } from "vue";

import type { ToolActivity } from "#shared/types/conversation.ts";

import CopyIconButton from "./CopyIconButton.vue";
import { formatDuration, formattedJson } from "./format.ts";

const props = defineProps<{
  activity: ToolActivity;
}>();

const label = computed(() => {
  if (props.activity.name === "exec_command") {
    return "Ran command";
  }
  if (props.activity.name === "spawn_agent") {
    return "Started subagent";
  }
  if (props.activity.name === "followup_task") {
    return "Continued subagent";
  }
  if (props.activity.name === "send_message") {
    return "Updated subagent";
  }
  return `${props.activity.namespace === null ? "tool" : props.activity.namespace}/${props.activity.name}`;
});
const duration = computed(() => formatDuration(props.activity.durationMs));
const input = computed(() => formattedJson(props.activity.input));
const output = computed(() => formattedJson(props.activity.output));
const command = computed(() => {
  const value = props.activity.input;
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value["cmd"] === "string"
    ? value["cmd"]
    : null;
});
const childThreadId = computed(() => {
  const value = props.activity.output;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  for (const key of ["thread_id", "threadId", "agent_id", "agentId"] as const) {
    if (typeof value[key] === "string" && value[key] !== "") {
      return value[key];
    }
  }
  return null;
});
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
    <pre
      v-if="command !== null"
      class="conversation-tool-row__command"
    ><code>{{ command }}</code></pre>
    <a
      v-if="childThreadId !== null"
      class="conversation-tool-row__agent-link"
      :href="`/session/${encodeURIComponent(childThreadId)}`"
      >Open subagent conversation</a
    >
    <p
      v-if="activity.approval"
      class="conversation-tool-row__approval"
      :class="activity.approval.outcome === 'deny' ? 'is-denied' : null"
    >
      <strong
        >{{ activity.approval.outcome === "allow" ? "Approved" : "Denied" }} ·
        {{ activity.approval.riskLevel }} risk</strong
      >
      <span>{{ activity.approval.rationale }}</span>
    </p>
    <details class="conversation-tool-row__technical">
      <summary>Technical details</summary>
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
    </details>
    <p v-if="activity.error !== null" class="conversation-tool-row__error">
      {{ activity.error }}
    </p>
  </article>
</template>
