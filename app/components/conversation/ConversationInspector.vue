<script setup lang="ts">
import { PhArrowClockwise, PhX } from "@phosphor-icons/vue";
import { computed, onMounted, ref, useId, watch } from "vue";

import type { ConversationActivity } from "#shared/types/conversation.ts";
import type { ViewerDiagnostic } from "#shared/types/diagnostics.ts";
import type { InspectorTarget, InspectorRecord } from "#shared/types/repository.ts";

import UiButton from "../ui/UiButton.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import ConversationRaw from "./ConversationRaw.vue";
import CopyIconButton from "./CopyIconButton.vue";
import { formatDuration, formattedJson, formatTimestamp } from "./format.ts";
import { shortText, textField, toolPresentation } from "./toolPresentation.ts";

const props = defineProps<{
  activities?: ConversationActivity[];
  diagnostics?: ViewerDiagnostic[];
  error: string | null;
  loading: boolean;
  record: InspectorRecord | null;
}>();

const emit = defineEmits<{
  close: [];
  retry: [];
  inspect: [target: InspectorTarget];
}>();

const headingId = `conversation-inspector-${useId()}`;
const rawOpen = ref(false);
const selectedRecord = ref(0);
const related = computed(
  () => new Map((props.activities ?? []).map((activity) => [activity.id, activity])),
);
const diagnosticsById = computed(
  () =>
    new Map(
      (props.record?.diagnostics ?? props.diagnostics ?? []).map((diagnostic) => [
        diagnostic.id,
        diagnostic,
      ]),
    ),
);
function relatedLabel(id: string): string {
  const activity = related.value.get(id);
  if (activity === undefined) {
    return "Inspect related activity";
  }
  if (activity.kind === "tool") {
    const presentation = toolPresentation(activity);
    return `${presentation.label} · ${presentation.subject}`;
  }
  if (activity.kind === "reasoning") {
    return `Reasoning · ${shortText(activity.summary)}`;
  }
  if (activity.kind === "subagent") {
    return activity.description;
  }
  if (activity.kind === "status") {
    return activity.message;
  }
  return activity.kind.replaceAll("_", " ");
}
function rawLabel(index: number): string {
  const record = props.record?.rawRecords[index];
  return `${index + 1} · ${textField(record, "type", "event_type", "id") ?? "Protocol record"}`;
}
watch(
  () => props.record,
  () => {
    selectedRecord.value = 0;
    rawOpen.value = false;
  },
);
const dialog = ref<HTMLElement | null>(null);

onMounted(() => dialog.value?.focus());
</script>

<template>
  <div
    ref="dialog"
    class="conversation-inspector"
    role="dialog"
    aria-modal="false"
    :aria-labelledby="headingId"
    tabindex="-1"
    @keydown.esc.stop="emit('close')"
  >
    <header class="conversation-inspector__header">
      <div>
        <p>Protocol lens</p>
        <h2 :id="headingId">Info</h2>
      </div>
      <UiIconButton label="Close message info" @click="emit('close')">
        <PhX :size="19" weight="regular" aria-hidden="true" />
      </UiIconButton>
    </header>
    <p v-if="loading" class="conversation-inspector__state" aria-live="polite">
      Loading preserved metadata…
    </p>
    <div v-else-if="error !== null" class="conversation-inspector__state is-error">
      <p>{{ error }}</p>
      <UiButton variant="secondary" @click="emit('retry')">
        <PhArrowClockwise :size="17" weight="regular" aria-hidden="true" /> Retry
      </UiButton>
    </div>
    <div v-else-if="record !== null" class="conversation-inspector__body">
      <dl class="conversation-inspector__facts">
        <div>
          <dt>Target</dt>
          <dd>{{ record.target.type }} · {{ record.target.id }}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{{ record.models.join(", ") || "Unavailable" }}</dd>
        </div>
        <div>
          <dt>Reasoning effort</dt>
          <dd>{{ record.reasoningEfforts.join(", ") || "Unavailable" }}</dd>
        </div>
        <div>
          <dt>Phase</dt>
          <dd>{{ record.phase ?? "Unavailable" }}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{{ formatTimestamp(record.createdAt, "absolute") }}</dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>{{ formatTimestamp(record.completedAt, "absolute") }}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{{ formatDuration(record.durationMs) ?? "Unavailable" }}</dd>
        </div>
        <div>
          <dt>TTFT</dt>
          <dd>{{ formatDuration(record.timeToFirstTokenMs) ?? "Unavailable" }}</dd>
        </div>
      </dl>
      <section>
        <h3>Token delta</h3>
        <dl v-if="record.tokenDelta !== null" class="conversation-inspector__metrics tabular">
          <div>
            <dt>Input</dt>
            <dd>{{ record.tokenDelta.inputTokens }}</dd>
          </div>
          <div>
            <dt>Cached</dt>
            <dd>{{ record.tokenDelta.cachedInputTokens }}</dd>
          </div>
          <div>
            <dt>Output</dt>
            <dd>{{ record.tokenDelta.outputTokens }}</dd>
          </div>
          <div>
            <dt>Reasoning</dt>
            <dd>{{ record.tokenDelta.reasoningOutputTokens }}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd>{{ record.tokenDelta.totalTokens }}</dd>
          </div>
        </dl>
        <p v-else>Unavailable</p>
      </section>
      <section>
        <h3>Tools</h3>
        <dl
          v-if="Object.keys(record.toolCounts).length > 0"
          class="conversation-inspector__metrics tabular"
        >
          <div v-for="(count, tool) in record.toolCounts" :key="tool">
            <dt>{{ tool }}</dt>
            <dd>{{ count }}</dd>
          </div>
        </dl>
        <p v-else>No tool calls.</p>
      </section>
      <section>
        <h3>Related reasoning and work events</h3>
        <p v-if="record.activityIds.length === 0">None</p>
        <ul v-else>
          <li v-for="id in record.activityIds" :key="id">
            <button type="button" @click="emit('inspect', { type: 'activity', id })">
              {{ relatedLabel(id) }}</button
            ><small class="conversation-inspector__ids">{{ id }}</small>
          </li>
        </ul>
      </section>
      <section>
        <h3>Event IDs</h3>
        <p class="conversation-inspector__ids">{{ record.eventIds.join(" · ") || "None" }}</p>
      </section>
      <section>
        <h3>Diagnostics</h3>
        <p v-if="record.diagnosticIds.length === 0">None</p>
        <div v-for="id in record.diagnosticIds" :key="id">
          <p>
            {{
              diagnosticsById.get(id)?.message ?? "Diagnostic details unavailable in this record."
            }}
          </p>
          <small class="conversation-inspector__ids">{{ id }}</small>
          <ConversationRaw
            v-if="diagnosticsById.has(id)"
            :label="`Diagnostic details · ${diagnosticsById.get(id)!.severity}`"
            :value="diagnosticsById.get(id)!.details"
          />
        </div>
      </section>
      <details
        class="conversation-inspector__raw"
        :open="rawOpen"
        @toggle="rawOpen = ($event.currentTarget as HTMLDetailsElement).open"
      >
        <summary>Preserved raw protocol records · {{ record.rawRecords.length }}</summary>
        <div v-if="rawOpen">
          <CopyIconButton
            label="Copy complete raw protocol records"
            :text="() => formattedJson(record!.rawRecords)"
          />
          <label v-if="record.rawRecords.length"
            >Record
            <select v-model="selectedRecord">
              <option v-for="(_, index) in record.rawRecords" :key="index" :value="index">
                {{ rawLabel(index) }}
              </option>
            </select></label
          >
          <ConversationRaw
            v-if="record.rawRecords[selectedRecord] !== undefined"
            :key="`${record.target.id}:${selectedRecord}`"
            :label="rawLabel(selectedRecord)"
            :value="record.rawRecords[selectedRecord]!"
          />
          <p v-else>No raw records.</p>
        </div>
      </details>
    </div>
  </div>
</template>
