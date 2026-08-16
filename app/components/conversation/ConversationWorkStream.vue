<script setup lang="ts">
import { PhCaretRight } from "@phosphor-icons/vue";
import { computed, ref } from "vue";

import type {
  ConversationActivity,
  ConversationMessage,
  ConversationTurn,
  FileChangeActivity,
  TurnEntryReference,
} from "#shared/types/conversation.ts";
import type { ResolvedAsset } from "#shared/types/repository.ts";

import ConversationFileChanges from "./ConversationFileChanges.vue";
import ConversationWorkEntry from "./ConversationWorkEntry.vue";
import { formatDuration } from "./format.ts";

const props = defineProps<{
  resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
  resolveFavicon?: (origin: string) => Promise<string | null>;
  turn: ConversationTurn;
}>();
const emit = defineEmits<{ beforeResize: []; resized: [] }>();
const open = ref(false);
const messageById = computed(
  () =>
    new Map(
      [
        props.turn.userMessage,
        ...(props.turn.steeringMessages ?? []),
        ...props.turn.assistantMessages,
      ]
        .filter((message): message is ConversationMessage => message !== null)
        .map((message) => [message.id, message]),
    ),
);
const activityById = computed(
  () => new Map(props.turn.activities.map((activity) => [activity.id, activity])),
);
const finalAssistantId = computed(
  () => props.turn.finalAssistantMessageId ?? props.turn.assistantMessages.at(-1)?.id ?? null,
);

function fallbackOrder(): TurnEntryReference[] {
  return [
    ...(props.turn.userMessage === null
      ? []
      : [{ kind: "message" as const, id: props.turn.userMessage.id }]),
    ...(props.turn.steeringMessages ?? []).map(({ id }) => ({ kind: "message" as const, id })),
    ...props.turn.activities.map(({ id }) => ({ kind: "activity" as const, id })),
    ...props.turn.assistantMessages.map(({ id }) => ({ kind: "message" as const, id })),
  ];
}

type WorkNode =
  | { kind: "entry"; id: string; message?: ConversationMessage; activity?: ConversationActivity }
  | { kind: "files"; id: string; activities: FileChangeActivity[] };

const nodes = computed<WorkNode[]>(() => {
  const result: WorkNode[] = [];
  for (const reference of props.turn.entryOrder ?? fallbackOrder()) {
    if (reference.kind === "message") {
      if (reference.id === props.turn.userMessage?.id || reference.id === finalAssistantId.value) {
        continue;
      }
      result.push({
        kind: "entry",
        id: reference.id,
        message: messageById.value.get(reference.id),
      });
      continue;
    }
    const activity = activityById.value.get(reference.id);
    if (activity?.kind === "unknown") {
      continue;
    }
    if (activity?.kind === "file_change") {
      const previous = result.at(-1);
      if (previous?.kind === "files") {
        previous.activities.push(activity);
      } else {
        result.push({ kind: "files", id: activity.id, activities: [activity] });
      }
    } else {
      result.push({ kind: "entry", id: reference.id, activity });
    }
  }
  return result;
});
const duration = computed(() => formatDuration(props.turn.durationMs));

function toggled(event: Event): void {
  open.value = (event.currentTarget as HTMLDetailsElement).open;
  emit("resized");
}
</script>

<template>
  <details
    v-if="nodes.length > 0"
    class="conversation-activity-disclosure conversation-work-stream"
    data-activity-group="worked"
    :open="open"
    @toggle="toggled"
  >
    <summary @pointerdown="emit('beforeResize')" @keydown.enter="emit('beforeResize')">
      <PhCaretRight
        class="conversation-activity-disclosure__caret"
        :size="17"
        weight="regular"
        aria-hidden="true"
      />
      {{ duration === null ? "Worked" : `Worked for ${duration}` }} <span>{{ nodes.length }}</span>
    </summary>
    <div v-if="open" class="conversation-work-stream__entries">
      <template v-for="node in nodes" :key="node.id">
        <ConversationFileChanges v-if="node.kind === 'files'" :activities="node.activities" />
        <ConversationWorkEntry
          v-else
          :message="node.message"
          :activity="node.activity"
          :resolve-asset="resolveAsset"
          :resolve-favicon="resolveFavicon"
        />
      </template>
    </div>
  </details>
</template>
