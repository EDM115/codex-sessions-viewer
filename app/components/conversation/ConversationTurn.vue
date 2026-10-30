<script setup lang="ts">
import type { ConversationTurn } from "#shared/types/conversation.ts";
import type { InspectorTarget, ResolvedAsset } from "#shared/types/repository.ts";
import type { PresentationSettings } from "#shared/types/settings.ts";
import { agentWorkText } from "~/components/conversation/format.ts";
import { finalAssistantId } from "~/components/conversation/toolPresentation.ts";
import type { MediaViewerItem } from "~/composables/useMediaViewer.ts";

const props = defineProps<{
  unloadedBefore?: readonly string[];
  anchorPrefix?: string;
  disclosureKey?: string;
  messageKeys?: Readonly<Record<string, string>>;
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
  () => props.turn.assistantMessages.find(({ id }) => id === finalAssistantId(props.turn)) ?? null,
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
      :data-anchor-entry="`message:${messageKeys?.[turn.userMessage.id] ?? turn.userMessage.id}`"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      :timestamp-format="timestampFormat"
      @open-media="emit('openMedia', $event)"
    />
    <ConversationWorkStream
      :disclosure-key="disclosureKey"
      :message-keys="messageKeys"
      :unloaded-before="unloadedBefore"
      :turn="turn"
      :reasoning-default="reasoningDefault"
      :tool-calls-default="toolCallsDefault"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      @before-resize="emit('beforeResize')"
      @resized="emit('resized')"
      @open-media="emit('openMedia', $event)"
      @inspect="emit('inspect', $event)"
      @open-child="emit('openChild', $event)"
    />
    <p
      v-if="finalAssistant && unloadedBefore?.includes(finalAssistant.id)"
      class="history-gap"
      role="status"
    >
      History between these items is not loaded.
    </p>
    <ConversationMessage
      v-if="finalAssistant !== null"
      :key="messageKeys?.[finalAssistant.id] ?? finalAssistant.id"
      :message="finalAssistant"
      :data-anchor-entry="`message:${messageKeys?.[finalAssistant.id] ?? finalAssistant.id}`"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      :timestamp-format="timestampFormat"
      :duration-ms="turn.durationMs"
      :agent-work="workText"
      @inspect="emit('inspect', { type: 'message', id: $event })"
      @open-media="emit('openMedia', $event)"
    />
    <ConversationWorkStream
      v-if="finalAssistant !== null"
      after-final
      :disclosure-key="disclosureKey"
      :message-keys="messageKeys"
      :unloaded-before="unloadedBefore"
      :turn="turn"
      :reasoning-default="reasoningDefault"
      :tool-calls-default="toolCallsDefault"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      @before-resize="emit('beforeResize')"
      @resized="emit('resized')"
      @open-media="emit('openMedia', $event)"
      @inspect="emit('inspect', $event)"
      @open-child="emit('openChild', $event)"
    />
  </section>
</template>
