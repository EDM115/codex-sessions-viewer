<script setup lang="ts">
import { PhCaretRight } from "@phosphor-icons/vue";
import { computed, ref } from "vue";

import type {
  ConversationActivity,
  ConversationMessage,
  ConversationTurn,
  TurnEntryReference,
} from "#shared/types/conversation.ts";
import type { InspectorTarget, ResolvedAsset } from "#shared/types/repository.ts";

import type { MediaViewerItem } from "../../composables/useMediaViewer.ts";
import ConversationToolGroup from "./ConversationToolGroup.vue";
import ConversationWorkEntry from "./ConversationWorkEntry.vue";
import { formatDuration } from "./format.ts";
import { activityCategory, bodyAssetIds } from "./toolPresentation.ts";

const props = defineProps<{
  resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
  resolveFavicon?: (origin: string) => Promise<string | null>;
  turn: ConversationTurn;
}>();
const emit = defineEmits<{
  beforeResize: [];
  resized: [];
  inspect: [target: InspectorTarget];
  openMedia: [item: MediaViewerItem];
  openChild: [id: string];
}>();
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
  | { kind: "group"; id: string; activities: ConversationActivity[] };

const representedAssets = computed(() => {
  const ids = new Set<string>();
  for (const message of messageById.value.values()) {
    for (const id of message.attachmentIds) {
      ids.add(id);
    }
    for (const id of bodyAssetIds(message.body)) {
      ids.add(id);
    }
  }
  return ids;
});
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
    if (activity?.kind === "media" && representedAssets.value.has(activity.assetId)) {
      continue;
    }
    const category = activity === undefined ? null : activityCategory(activity);
    const groupable =
      activity !== undefined &&
      category !== null &&
      category !== "agent" &&
      "status" in activity &&
      activity.status === "succeeded" &&
      !(activity.kind === "tool" && activity.approval);
    if (groupable) {
      const previous = result.at(-1);
      if (previous?.kind === "group") {
        previous.activities.push(activity);
      } else {
        result.push({ kind: "group", id: activity.id, activities: [activity] });
      }
    } else {
      result.push({ kind: "entry", id: reference.id, activity });
    }
  }
  return result;
});
const duration = computed(() => formatDuration(props.turn.durationMs));

function beforeDisclosureResize(event: Event): void {
  if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") {
    return;
  }
  if (event.target instanceof Element && event.target.closest("summary") !== null) {
    emit("beforeResize");
  }
}
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
    @pointerdown.capture="beforeDisclosureResize"
    @keydown.capture="beforeDisclosureResize"
  >
    <summary>
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
        <ConversationToolGroup
          v-if="node.kind === 'group'"
          :activities="node.activities"
          :resolve-asset="resolveAsset"
          :resolve-favicon="resolveFavicon"
          @inspect="emit('inspect', $event)"
          @open-media="emit('openMedia', $event)"
          @open-child="emit('openChild', $event)"
        />
        <ConversationWorkEntry
          v-else
          :message="node.message"
          :activity="node.activity"
          :resolve-asset="resolveAsset"
          :resolve-favicon="resolveFavicon"
          @inspect="emit('inspect', $event)"
          @open-media="emit('openMedia', $event)"
          @open-child="emit('openChild', $event)"
        />
      </template>
    </div>
  </details>
</template>
