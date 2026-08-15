<script setup lang="ts">
import { PhArrowClockwise, PhX } from "@phosphor-icons/vue";
import { computed, onMounted, ref } from "vue";

import type { InspectorRecord } from "#shared/types/repository.ts";

import UiButton from "../ui/UiButton.vue";
import UiIconButton from "../ui/UiIconButton.vue";
import { formatDuration, formatTimestamp } from "./format.ts";

const props = defineProps<{
  error: string | null;
  loading: boolean;
  record: InspectorRecord | null;
}>();

const emit = defineEmits<{
  close: [];
  retry: [];
}>();

const rawRecords = computed(() => JSON.stringify(props.record?.rawRecords ?? [], null, 2));
const dialog = ref<HTMLElement | null>(null);

onMounted(() => dialog.value?.focus());
</script>

<template>
  <div
    ref="dialog"
    class="conversation-inspector"
    role="dialog"
    aria-modal="false"
    aria-labelledby="conversation-inspector-title"
    tabindex="-1"
    @keydown.esc.stop="emit('close')"
  >
    <header class="conversation-inspector__header">
      <div>
        <p>Protocol lens</p>
        <h2 id="conversation-inspector-title">Info</h2>
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
        <p class="conversation-inspector__ids">{{ record.activityIds.join(" · ") || "None" }}</p>
      </section>
      <section>
        <h3>Event IDs</h3>
        <p class="conversation-inspector__ids">{{ record.eventIds.join(" · ") || "None" }}</p>
      </section>
      <section>
        <h3>Diagnostics</h3>
        <p class="conversation-inspector__ids">{{ record.diagnosticIds.join(" · ") || "None" }}</p>
      </section>
      <details class="conversation-inspector__raw">
        <summary>Preserved raw protocol records</summary>
        <pre>{{ rawRecords }}</pre>
      </details>
    </div>
  </div>
</template>
