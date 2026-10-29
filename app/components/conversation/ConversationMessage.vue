<script setup lang="ts">
import { PhCaretDown, PhCheck, PhCopy, PhInfo } from "@phosphor-icons/vue";

import type { ConversationMessage } from "#shared/types/conversation.ts";
import type { ResolvedAsset } from "#shared/types/repository.ts";
import type { PresentationSettings } from "#shared/types/settings.ts";
import { formatDuration, formatTimestamp } from "~/components/conversation/format.ts";
import { bodyAssetIds } from "~/components/conversation/toolPresentation.ts";
import type { MediaViewerItem } from "~/composables/useMediaViewer.ts";

const props = withDefaults(
  defineProps<{
    agentWork?: string | (() => string);
    durationMs?: number | null;
    message: ConversationMessage;
    resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
    resolveFavicon?: (origin: string) => Promise<string | null>;
    timestampFormat: PresentationSettings["timestampFormat"];
  }>(),
  { agentWork: "", durationMs: null, resolveAsset: undefined, resolveFavicon: undefined },
);

const emit = defineEmits<{
  inspect: [messageId: string];
  openMedia: [item: MediaViewerItem];
}>();

const attachmentIds = computed(() =>
  [...new Set(props.message.attachmentIds)].filter(
    (id) => !bodyAssetIds(props.message.body).has(id),
  ),
);
const menuOpen = ref(false);
const copyMenuButton = useTemplateRef<HTMLButtonElement>("copyMenuButton");
const copyMenuItem = useTemplateRef<HTMLButtonElement>("copyMenuItem");
let restoreCopyMenuFocus = true;
watch(menuOpen, async (open, previous) => {
  await nextTick();
  if (open) {
    restoreCopyMenuFocus = true;
    copyMenuItem.value?.focus();
  } else if (previous && restoreCopyMenuFocus) {
    copyMenuButton.value?.focus();
  }
});
function copyMenuFocusOut(event: FocusEvent) {
  if (
    menuOpen.value &&
    event.currentTarget instanceof Node &&
    (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
  ) {
    restoreCopyMenuFocus = false;
    menuOpen.value = false;
  }
}
const workCopyState = ref<"default" | "error" | "success">("default");
let resetTimer: ReturnType<typeof setTimeout> | null = null;
const isAssistant = computed(() => props.message.role === "assistant");
const duration = computed(() => formatDuration(props.durationMs));
const timestamp = computed(() => formatTimestamp(props.message.createdAt, props.timestampFormat));

async function copyAgentWork(): Promise<void> {
  if (resetTimer !== null) {
    clearTimeout(resetTimer);
  }
  try {
    await navigator.clipboard.writeText(
      typeof props.agentWork === "function" ? props.agentWork() : props.agentWork,
    );
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
    <div class="conversation-message__prose">
      <ContentRichTextRenderer
        :document="message.body"
        :resolve-asset="resolveAsset"
        :resolve-favicon="resolveFavicon"
        @open-media="emit('openMedia', $event)"
      />
    </div>
    <ConversationAttachment
      v-for="id in attachmentIds"
      :key="id"
      :asset-id="id"
      :resolve-asset="resolveAsset"
      @open-media="emit('openMedia', $event)"
    />
    <footer class="conversation-message__footer">
      <time :datetime="message.createdAt ?? undefined" data-allow-mismatch="text">{{
        timestamp
      }}</time>
      <span v-if="duration !== null" class="tabular">{{ duration }}</span>
      <span class="conversation-message__actions">
        <ConversationCopyIconButton
          :label="isAssistant ? 'Copy assistant message' : 'Copy prompt'"
          :text="message.sourceMarkdown"
        />
        <span
          v-if="isAssistant"
          class="conversation-copy-menu"
          @keydown.esc.stop.prevent="menuOpen = false"
          @focusout="copyMenuFocusOut"
        >
          <button
            ref="copyMenuButton"
            type="button"
            class="ui-icon-button interactive-control"
            aria-label="Assistant copy options"
            :aria-expanded="menuOpen"
            aria-haspopup="menu"
            @click="menuOpen = !menuOpen"
            @keydown.down.stop.prevent="menuOpen = true"
            @keydown.up.stop.prevent="menuOpen = true"
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
            <button
              ref="copyMenuItem"
              type="button"
              role="menuitem"
              @click="copyAgentWork"
              @keydown.down.stop.prevent
              @keydown.up.stop.prevent
            >
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
