<script setup lang="ts">
import {
  PhTerminal,
  PhFileText,
  PhMagnifyingGlass,
  PhPencilSimple,
  PhGlobe,
  PhPlugsConnected,
  PhRobot,
  PhWrench,
} from "@phosphor-icons/vue";
import { computed, ref } from "vue";

import type { ToolActivity } from "#shared/types/conversation.ts";

import ConversationRaw from "./ConversationRaw.vue";
import CopyIconButton from "./CopyIconButton.vue";
import { formatDuration, formattedJson } from "./format.ts";
import {
  boundedJson,
  objectValue,
  statusLabel,
  textField,
  toolOutput,
  toolPresentation,
} from "./toolPresentation.ts";
const props = defineProps<{ activity: ToolActivity }>();
const emit = defineEmits<{ inspect: [id: string]; openChild: [id: string] }>();
const open = ref(false);
const presentation = computed(() => toolPresentation(props.activity));
const icons = {
  shell: PhTerminal,
  read: PhFileText,
  search: PhMagnifyingGlass,
  edit: PhPencilSimple,
  web: PhGlobe,
  app: PhPlugsConnected,
  agent: PhRobot,
  other: PhWrench,
};
const duration = computed(() => formatDuration(props.activity.durationMs));
const command = computed(
  () =>
    textField(props.activity.input, "cmd", "command") ??
    (typeof props.activity.input === "string" ? props.activity.input : null),
);
const output = computed(() => boundedJson(toolOutput(props.activity)));
const context = computed(() =>
  textField(props.activity.input, "workdir", "cwd", "path", "file_path", "url"),
);
const objective = computed(() => textField(props.activity.input, "message", "prompt", "objective"));
const model = computed(() => textField(props.activity.input, "model"));
const exitCode = computed(() => objectValue(props.activity.output)?.["exit_code"]);
</script>
<template>
  <article
    class="conversation-tool-row"
    :class="activity.status === 'failed' ? 'is-failed' : null"
    :data-status="activity.status"
    :data-entry-id="activity.id"
  >
    <details
      class="conversation-tool-row__details"
      @toggle="open = ($event.currentTarget as HTMLDetailsElement).open"
    >
      <summary class="conversation-tool-row__header">
        <component :is="icons[presentation.category]" :size="18" aria-hidden="true" />
        <strong>{{ presentation.label }}</strong>
        <span class="conversation-tool-row__subject">{{ presentation.subject }}</span>
        <span>{{ statusLabel(activity.status) }}</span>
        <span v-if="duration !== null" class="tabular">{{ duration }}</span>
      </summary>
      <div v-if="open" class="conversation-tool-row__detail-body">
        <div class="conversation-tool-row__payload-heading">
          <strong>{{ presentation.category === "shell" ? "Shell" : presentation.label }}</strong
          ><button type="button" class="ui-button" @click="emit('inspect', activity.id)">
            Info
          </button>
        </div>
        <p v-if="context"><strong>Location:</strong> {{ context }}</p>
        <template v-if="command !== null">
          <div class="conversation-tool-row__payload-heading">
            <span>{{ presentation.category === "shell" ? "Command" : "Recorded input" }}</span
            ><CopyIconButton label="Copy complete tool command" :text="() => command ?? ''" />
          </div>
          <pre
            class="conversation-tool-row__command"
          ><code>{{ command.length > 16_000 ? command.slice(0, 16_000) + '\n… Partial command preview; copy includes complete command.' : command }}</code></pre>
        </template>
        <p v-if="model"><strong>Model:</strong> {{ model }}</p>
        <p v-if="objective">
          <strong>Objective/message:</strong>
          {{
            objective.length > 2_000
              ? objective.slice(0, 2_000) + "… (partial; full input below)"
              : objective
          }}
        </p>
        <div class="conversation-tool-row__payload-heading">
          <span>Result</span
          ><CopyIconButton
            label="Copy complete tool output"
            :text="() => formattedJson(activity.output)"
          />
        </div>
        <p v-if="output.partial">
          Partial output preview. Complete original output is available in Technical details or
          Copy.
        </p>
        <pre class="conversation-tool-row__output">{{ output.text || "No output recorded." }}</pre>
        <p>
          {{ statusLabel(activity.status)
          }}<span v-if="typeof exitCode === 'number'"> · Exit code {{ exitCode }}</span>
        </p>
        <p v-if="presentation.childId !== null">
          <a
            :href="`/session/${encodeURIComponent(presentation.childId)}`"
            @click.prevent="emit('openChild', presentation.childId)"
            >Open {{ presentation.subject }} conversation</a
          >
        </p>
        <dl class="conversation-tool-row__identity">
          <dt>Protocol tool</dt>
          <dd>{{ presentation.rawName }}</dd>
          <dt>Call ID</dt>
          <dd>{{ activity.callId ?? "Unavailable" }}</dd>
          <dt>Activity ID</dt>
          <dd>{{ activity.id }}</dd>
        </dl>
        <ConversationRaw label="Technical details · input" :value="activity.input" />
        <ConversationRaw label="Technical details · output" :value="activity.output" />
      </div>
    </details>
    <p
      v-if="activity.approval"
      class="conversation-tool-row__approval"
      :class="activity.approval.outcome === 'deny' ? 'is-denied' : null"
    >
      <strong
        >{{ activity.approval.outcome === "allow" ? "Approved" : "Denied" }} ·
        {{ activity.approval.riskLevel }} risk</strong
      ><span>{{ activity.approval.rationale }}</span>
    </p>
    <p v-if="activity.error !== null" class="conversation-tool-row__error">{{ activity.error }}</p>
  </article>
</template>
<style scoped>
.conversation-tool-row__details {
  min-width: 0;
}
.conversation-tool-row__header {
  cursor: pointer;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.conversation-tool-row__header > svg {
  flex-shrink: 0;
}
.conversation-tool-row__subject {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 4rem;
}
.conversation-tool-row__detail-body {
  padding: 0.75rem;
  min-width: 0;
}
.conversation-tool-row__command,
.conversation-tool-row__output {
  max-height: 26rem;
  overflow: auto;
  white-space: pre;
}
.conversation-tool-row__identity {
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}
.conversation-tool-row__identity dd {
  margin: 0 0 0.3rem;
}
</style>
