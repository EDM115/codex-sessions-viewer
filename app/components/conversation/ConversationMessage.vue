<script setup lang="ts">
import { PhCaretDown, PhCheck, PhCopy, PhInfo } from "@phosphor-icons/vue";
import { computed, onBeforeUnmount, ref } from "vue";

import type { ConversationMessage } from "#shared/types/conversation.ts";
import type { PresentationSettings } from "#shared/types/settings.ts";

import CopyIconButton from "./CopyIconButton.vue";
import { formatDuration, formatTimestamp } from "./format.ts";

const props = withDefaults(
  defineProps<{
    agentWork?: string;
    durationMs?: number | null;
    message: ConversationMessage;
    timestampFormat: PresentationSettings["timestampFormat"];
  }>(),
  { agentWork: "", durationMs: null },
);

const emit = defineEmits<{
  inspect: [messageId: string];
}>();

const menuOpen = ref(false);
const workCopyState = ref<"default" | "error" | "success">("default");
let resetTimer: ReturnType<typeof setTimeout> | null = null;
const isAssistant = computed(() => props.message.role === "assistant");
const duration = computed(() => formatDuration(props.durationMs));
const timestamp = computed(() => formatTimestamp(props.message.createdAt, props.timestampFormat));

async function copyAgentWork(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.agentWork);
    workCopyState.value = "success";
    menuOpen.value = false;
    resetTimer = setTimeout(() => {
      workCopyState.value = "default";
      resetTimer = null;
    }, 2_500);
  } catch {
    workCopyState.value = "error";
  }
}

onBeforeUnmount(() => {
  if (resetTimer !== null) {
    clearTimeout(resetTimer);
  }
});
</script>

<template>
  <article
    class="conversation-message"
    :class="`conversation-message--${message.role}`"
    :data-message-id="message.id"
  >
    <p class="conversation-message__role">{{ isAssistant ? "Assistant" : "You" }}</p>
    <div class="conversation-message__prose">{{ message.sourceMarkdown }}</div>
    <footer class="conversation-message__footer">
      <time :datetime="message.createdAt" data-allow-mismatch="text">{{ timestamp }}</time>
      <span v-if="duration !== null" class="tabular">{{ duration }}</span>
      <span class="conversation-message__actions">
        <CopyIconButton
          :label="isAssistant ? 'Copy assistant message' : 'Copy prompt'"
          :text="message.sourceMarkdown"
        />
        <span v-if="isAssistant" class="conversation-copy-menu" @keydown.esc="menuOpen = false">
          <button
            type="button"
            class="ui-icon-button interactive-control"
            aria-label="Assistant copy options"
            :aria-expanded="menuOpen"
            @click="menuOpen = !menuOpen"
          >
            <PhCheck
              v-if="workCopyState === 'success'"
              :size="17"
              weight="regular"
              aria-hidden="true"
            />
            <PhCaretDown v-else :size="17" weight="regular" aria-hidden="true" />
          </button>
          <span v-if="menuOpen" class="ui-menu__surface" role="menu">
            <button type="button" role="menuitem" @click="copyAgentWork">
              <PhCopy :size="17" weight="regular" aria-hidden="true" />
              Copy agent work since prompt
            </button>
          </span>
        </span>
        <button
          v-if="isAssistant"
          type="button"
          class="ui-icon-button interactive-control"
          aria-label="Open message info"
          @click="emit('inspect', message.id)"
        >
          <PhInfo :size="18" weight="regular" aria-hidden="true" />
        </button>
      </span>
      <span v-if="workCopyState === 'error'" class="conversation-copy-action__error" role="status">
        Copy failed. Select the text or retry.
      </span>
    </footer>
  </article>
</template>
