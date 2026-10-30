<script setup lang="ts">
import { PhCaretRight } from "@phosphor-icons/vue";

import type {
  ConversationActivity,
  ConversationMessage,
  ConversationTurn,
  TurnEntryReference,
  DisclosureDefault,
} from "#shared/types/conversation.ts";
import type { InspectorTarget, ResolvedAsset } from "#shared/types/repository.ts";
import { formatDuration } from "~/components/conversation/format.ts";
import {
  activityGroupingKey,
  bodyAssetIds,
  finalAssistantId,
  hasReasoning,
  reasoningText,
} from "~/components/conversation/toolPresentation.ts";
import type { MediaViewerItem } from "~/composables/useMediaViewer.ts";

const props = defineProps<{
  unloadedBefore?: readonly string[];
  resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
  resolveFavicon?: (origin: string) => Promise<string | null>;
  turn: ConversationTurn;
  afterFinal?: boolean;
  disclosureKey?: string;
  messageKeys?: Readonly<Record<string, string>>;
  reasoningDefault?: DisclosureDefault;
  toolCallsDefault?: DisclosureDefault;
}>();
const emit = defineEmits<{
  beforeResize: [];
  resized: [];
  inspect: [target: InspectorTarget];
  openMedia: [item: MediaViewerItem];
  openChild: [id: string];
}>();
const lifecycle = computed(() =>
  props.turn.status === "interrupted"
    ? "cancelled"
    : props.turn.status === "failed"
      ? "error"
      : props.turn.status === "inProgress"
        ? "running"
        : finalAssistantId(props.turn) !== null
          ? "completed"
          : props.turn.activities.some(
                (activity) => "status" in activity && activity.status === "cancelled",
              )
            ? "cancelled"
            : "running",
);
const { open, toggle } = useWorkDisclosure(
  () =>
    `${props.disclosureKey ?? `${props.turn.sessionId}:${props.turn.id}`}:work${props.afterFinal ? ":after" : ""}`,
  lifecycle,
);
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
const finalId = computed(() => finalAssistantId(props.turn));

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
  | { kind: "gap"; id: string }
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
  let previousReasoning: string | null = null;
  const references = props.turn.entryOrder ?? fallbackOrder();
  const finalIndex = references.findIndex(
    (reference) => reference.kind === "message" && reference.id === finalId.value,
  );
  const selected = props.afterFinal
    ? finalIndex < 0
      ? []
      : references.slice(finalIndex + 1)
    : finalIndex < 0
      ? references
      : references.slice(0, finalIndex);
  for (const reference of selected) {
    if (reference.kind === "message") {
      previousReasoning = null;
      if (reference.id === props.turn.userMessage?.id || reference.id === finalId.value) {
        continue;
      }
      if (props.unloadedBefore?.includes(reference.id)) {
        result.push({ kind: "gap", id: `gap:${reference.id}` });
      }
      result.push({
        kind: "entry",
        id: reference.id,
        message: messageById.value.get(reference.id),
      });
      continue;
    }
    const activity = activityById.value.get(reference.id);
    if (props.unloadedBefore?.includes(reference.id)) {
      previousReasoning = null;
      result.push({ kind: "gap", id: `gap:${reference.id}` });
    }
    if (activity?.kind === "reasoning") {
      if (!hasReasoning(activity)) {
        continue;
      }
      const identity = [
        ...new Set(
          [activity.summary, reasoningText(activity)]
            .map((text) => text.trim().replace(/\s+/gu, " "))
            .filter(Boolean),
        ),
      ].join("\n");
      if (previousReasoning === identity) {
        continue;
      }
      previousReasoning = identity;
    } else {
      previousReasoning = null;
    }
    if (activity?.kind === "media" && representedAssets.value.has(activity.assetId)) {
      continue;
    }
    const groupingKey = activity === undefined ? null : activityGroupingKey(activity);
    if (activity && groupingKey !== null) {
      const previous = result.at(-1);
      if (
        previous?.kind === "group" &&
        activityGroupingKey(previous.activities[0]!) === groupingKey
      ) {
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
const hasWork = computed(() => nodes.value.some((node) => node.kind !== "gap"));
const label = computed(() =>
  lifecycle.value === "completed"
    ? duration.value === null
      ? "Worked"
      : `Worked for ${duration.value}`
    : lifecycle.value === "cancelled"
      ? "Work cancelled"
      : lifecycle.value === "error"
        ? "Work failed"
        : props.turn.status === "inProgress"
          ? "Working"
          : "Work so far",
);

function beforeDisclosureResize(event: Event): void {
  if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") {
    return;
  }
  if (event.target instanceof Element && event.target.closest("summary") !== null) {
    emit("beforeResize");
  }
}
function toggled(event: Event): void {
  toggle(event);
  emit("resized");
}
</script>

<template>
  <details
    v-if="hasWork"
    class="conversation-activity-disclosure conversation-work-stream"
    data-activity-group="worked"
    :open="open"
    @toggle="toggled"
    @pointerdown.capture="beforeDisclosureResize"
    @keydown.capture="beforeDisclosureResize"
  >
    <summary :aria-expanded="open">
      <PhCaretRight
        class="conversation-activity-disclosure__caret"
        :size="17"
        weight="regular"
        aria-hidden="true"
      />
      {{ afterFinal ? "Work after answer" : label }}
      <span>{{ nodes.filter((node) => node.kind !== "gap").length }}</span>
    </summary>
    <div v-if="open" class="conversation-work-stream__entries">
      <template
        v-for="node in nodes"
        :key="node.kind === 'entry' && node.message ? (messageKeys?.[node.id] ?? node.id) : node.id"
      >
        <p v-if="node.kind === 'gap'" class="history-gap" role="status">
          History between these items is not loaded.
        </p>
        <ConversationToolGroup
          v-else-if="node.kind === 'group'"
          :activities="node.activities"
          :disclosure-key="`${disclosureKey ?? `${turn.sessionId}:${turn.id}`}:${node.id}`"
          :reasoning-default="reasoningDefault"
          :tool-calls-default="toolCallsDefault"
          :resolve-asset="resolveAsset"
          :resolve-favicon="resolveFavicon"
          @inspect="emit('inspect', $event)"
          @open-media="emit('openMedia', $event)"
          @open-child="emit('openChild', $event)"
        />
        <ConversationWorkEntry
          v-else
          :data-anchor-entry="
            node.message ? `message:${messageKeys?.[node.id] ?? node.id}` : `activity:${node.id}`
          "
          :message="node.message"
          :activity="node.activity"
          :disclosure-key="`${disclosureKey ?? `${turn.sessionId}:${turn.id}`}:${node.id}`"
          :reasoning-default="reasoningDefault"
          :tool-calls-default="toolCallsDefault"
          :resolve-asset="resolveAsset"
          :resolve-favicon="resolveFavicon"
          @inspect="emit('inspect', $event)"
          @open-media="emit('openMedia', $event)"
          @open-child="emit('openChild', $event)"
        />
      </template>
    </div>
  </details>
  <template v-else>
    <p v-for="node in nodes" :key="node.id" class="history-gap" role="status">
      History between these items is not loaded.
    </p>
  </template>
</template>
