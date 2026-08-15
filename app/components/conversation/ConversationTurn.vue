<script setup lang="ts">
import { computed } from "vue";

import type { ConversationTurn } from "#shared/types/conversation.ts";
import type { InspectorTarget } from "#shared/types/repository.ts";
import type { PresentationSettings } from "#shared/types/settings.ts";

import ConversationActivityList from "./ConversationActivityList.vue";
import ConversationMessage from "./ConversationMessage.vue";
import { agentWorkText } from "./format.ts";

const props = defineProps<{
  reasoningDefault: PresentationSettings["reasoningDefault"];
  timestampFormat: PresentationSettings["timestampFormat"];
  toolCallsDefault: PresentationSettings["toolCallsDefault"];
  turn: ConversationTurn;
}>();

const emit = defineEmits<{
  beforeResize: [];
  inspect: [target: InspectorTarget];
  resized: [];
}>();

const workText = computed(() => agentWorkText(props.turn));
</script>

<template>
  <section class="conversation-turn" :id="`turn-${turn.id}`" :data-turn-id="turn.id">
    <ConversationMessage
      v-if="turn.userMessage !== null"
      :message="turn.userMessage"
      :timestamp-format="timestampFormat"
    />
    <ConversationActivityList
      :activities="turn.activities"
      :reasoning-default="reasoningDefault"
      :tool-calls-default="toolCallsDefault"
      @before-resize="emit('beforeResize')"
      @resized="emit('resized')"
    />
    <ConversationMessage
      v-for="(message, index) in turn.assistantMessages"
      :key="message.id"
      :message="message"
      :timestamp-format="timestampFormat"
      :duration-ms="index === turn.assistantMessages.length - 1 ? turn.durationMs : null"
      :agent-work="workText"
      @inspect="emit('inspect', { type: 'message', id: $event })"
    />
  </section>
</template>
