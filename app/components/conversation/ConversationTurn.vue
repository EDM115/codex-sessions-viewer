<script setup lang="ts">
import { computed } from "vue";

import type { ConversationTurn } from "#shared/types/conversation.ts";
import type { InspectorTarget, ResolvedAsset } from "#shared/types/repository.ts";
import type { PresentationSettings } from "#shared/types/settings.ts";

import type { MediaViewerItem } from "../../composables/useMediaViewer.ts";
import ConversationMessage from "./ConversationMessage.vue";
import ConversationWorkStream from "./ConversationWorkStream.vue";
import { agentWorkText } from "./format.ts";

const props = defineProps<{
  anchorPrefix?: string;
  reasoningDefault: PresentationSettings["reasoningDefault"];
  resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
  resolveFavicon?: (origin: string) => Promise<string | null>;
  timestampFormat: PresentationSettings["timestampFormat"];
  toolCallsDefault: PresentationSettings["toolCallsDefault"];
  turn: ConversationTurn;
}>();

const emit = defineEmits<{
  beforeResize: [];
  inspect: [target: InspectorTarget];
  openMedia: [item: MediaViewerItem];
  openChild: [id: string];
  resized: [];
}>();

const workText = () => agentWorkText(props.turn);
const finalAssistant = computed(
  () =>
    props.turn.assistantMessages.find(({ id }) => id === props.turn.finalAssistantMessageId) ??
    props.turn.assistantMessages.at(-1) ??
    null,
);
</script>

<template>
  <section
    class="conversation-turn"
    :id="`${anchorPrefix ?? 'turn-'}${turn.id}`"
    :data-turn-id="turn.id"
  >
    <ConversationMessage
      v-if="turn.userMessage !== null"
      :message="turn.userMessage"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      :timestamp-format="timestampFormat"
      @open-media="emit('openMedia', $event)"
    />
    <ConversationWorkStream
      :turn="turn"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      @before-resize="emit('beforeResize')"
      @resized="emit('resized')"
      @open-media="emit('openMedia', $event)"
      @inspect="emit('inspect', $event)"
      @open-child="emit('openChild', $event)"
    />
    <ConversationMessage
      v-if="finalAssistant !== null"
      :key="finalAssistant.id"
      :message="finalAssistant"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      :timestamp-format="timestampFormat"
      :duration-ms="turn.durationMs"
      :agent-work="workText"
      @inspect="emit('inspect', { type: 'message', id: $event })"
      @open-media="emit('openMedia', $event)"
    />
  </section>
</template>
