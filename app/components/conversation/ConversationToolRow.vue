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

import type { JsonValue, ToolActivity, DisclosureDefault } from "#shared/types/conversation.ts";
import { formatDuration, formattedJson } from "~/components/conversation/format.ts";
import {
  boundedJson,
  objectValue,
  statusLabel,
  textField,
  toolOutput,
  toolPresentation,
  activateChild,
} from "~/components/conversation/toolPresentation.ts";
const props = defineProps<{
  activity: ToolActivity;
  disclosureKey?: string;
  toolCallsDefault?: DisclosureDefault;
}>();
const emit = defineEmits<{ inspect: [id: string]; openChild: [id: string] }>();
const { open, toggle } = useWorkDisclosure(
  () => `${props.disclosureKey ?? props.activity.id}:tool`,
  () =>
    props.activity.status === "failed"
      ? "error"
      : props.activity.status === "cancelled"
        ? "cancelled"
        : props.activity.status === "running"
          ? "running"
          : "unknown",
  () => props.toolCallsDefault ?? "collapsed",
);
const attempts = computed(
  () =>
    props.activity.approvalAttempts ?? (props.activity.approval ? [props.activity.approval] : []),
);
const visibleAttempts = computed(() =>
  attempts.value.filter((attempt) => attempt.outcome !== "allow"),
);
const presentation = computed(() => toolPresentation(props.activity));
const childIds = computed(
  () =>
    props.activity.presentation?.childIds ??
    (presentation.value.childId ? [presentation.value.childId] : []),
);
function observedChildStatus(id: string) {
  return textField(objectValue(props.activity.output)?.[id], "status");
}
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
const isScript = computed(
  () =>
    (props.activity.codeMode !== undefined &&
      props.activity.presentation?.evidenceKind !== "host-attempt") ||
    ["functions.exec", "functions.wait"].includes(
      `${props.activity.namespace}.${props.activity.name}`,
    ) ||
    (props.activity.namespace === "functions" && ["exec", "wait"].includes(props.activity.name)),
);
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
    <details class="conversation-tool-row__details" :open="open" @toggle="toggle">
      <summary class="conversation-tool-row__header" :aria-expanded="open">
        <component :is="icons[presentation.category]" :size="18" aria-hidden="true" />
        <strong>{{ presentation.label }}</strong>
        <span class="conversation-tool-row__subject">{{ presentation.subject }}</span>
        <span>{{ statusLabel(activity.status) }}</span>
        <span v-if="duration !== null" class="tabular">{{ duration }}</span>
      </summary>
      <div v-if="open" class="conversation-tool-row__detail-body">
        <div class="conversation-tool-row__payload-heading">
          <strong>{{ presentation.category === "shell" ? "Shell" : presentation.label }}</strong
          ><UiButton variant="quiet" @click="emit('inspect', activity.id)"> Info </UiButton>
        </div>
        <p v-if="context"><strong>Location:</strong> {{ context }}</p>
        <template v-if="command !== null && !isScript && presentation.category !== 'edit'">
          <div class="conversation-tool-row__payload-heading">
            <span>{{ presentation.category === "shell" ? "Command" : "Recorded input" }}</span
            ><ConversationCopyIconButton
              label="Copy complete tool command"
              :text="() => command ?? ''"
            />
          </div>
          <pre
            class="conversation-tool-row__command"
          ><code :class="presentation.category === 'shell' || presentation.category === 'read' || presentation.category === 'search' ? 'language-shell' : undefined">{{ command.length > 16_000 ? command.slice(0, 16_000) + '\n… Partial command preview; copy includes complete command.' : command }}</code></pre>
        </template>
        <ContentDiffBlock
          v-if="presentation.category === 'edit' && typeof activity.input === 'string'"
          :source="activity.input"
          wrapped
        />
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
          ><ConversationCopyIconButton
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
        <p v-for="childId in childIds" :key="childId">
          <a
            :href="`/session/${encodeURIComponent(childId)}`"
            @click="activateChild($event, childId, (id) => emit('openChild', id))"
            >Open {{ childIds.length === 1 ? presentation.subject : childId }} conversation</a
          >
          <span v-if="observedChildStatus(childId)">
            · Recorded status: {{ observedChildStatus(childId) }}</span
          >
        </p>
        <ConversationRaw
          label="Technical details · identity and reviews"
          :value="
            {
              tool: presentation.rawName,
              callId: activity.callId,
              activityId: activity.id,
              nativeItemId: activity.nativeItemId ?? null,
              attempts,
            } as unknown as JsonValue
          "
        />
        <ConversationRaw label="Technical details · input" :value="activity.input" />
        <ConversationRaw label="Technical details · output" :value="activity.output" />
      </div>
    </details>
    <ConversationApprovalAttempt
      v-for="(attempt, index) in visibleAttempts"
      :key="`${attempt.reviewId ?? 'review'}:${index}`"
      :disclosure-key="`${disclosureKey ?? activity.id}:${attempt.reviewId ?? 'review'}:${index}`"
      :attempt="attempt"
    />
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
</style>
