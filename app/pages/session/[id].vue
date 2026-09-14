<script setup lang="ts">
import type { RepositoryMode } from "#shared/types/repository.ts";

import ConversationView from "../../components/conversation/ConversationView.vue";
import LibrarySkeleton from "../../components/library/LibrarySkeleton.vue";
import LibrarySubagentPanel from "../../components/library/LibrarySubagentPanel.vue";
import { recentChunkCursor } from "../../composables/useConversationTimeline.ts";
import { createConversationRepository } from "../../repositories/index.ts";
import type { RepositoryRequester } from "../../repositories/live.ts";

const route = useRoute();
definePageMeta({ key: (route) => ("id" in route.params ? String(route.params.id) : route.path) });
const childPanelOpen = ref(false);
const selectedChildId = ref<string | null>(null);
function openChild(id: string) {
  selectedChildId.value = id;
  childPanelOpen.value = true;
}
const runtimeConfig = useRuntimeConfig();
const requestFetch = useRequestFetch() as unknown as (
  path: string,
  options: { signal?: AbortSignal },
) => Promise<unknown>;
const mode: RepositoryMode = runtimeConfig.public.viewerMode === "static" ? "static" : "live";
const requester: RepositoryRequester = (path, options = {}) =>
  requestFetch(path, { signal: options.signal }) as Promise<unknown>;
const repository = createConversationRepository(mode, requester);
const sessionParameter = "id" in route.params ? route.params.id : undefined;
const sessionId = Array.isArray(sessionParameter) ? sessionParameter[0] : sessionParameter;
const targetTurnId = computed(() =>
  typeof route.query.turn === "string" ? route.query.turn : null,
);

if (typeof sessionId !== "string" || sessionId.trim() === "") {
  throw createError({ statusCode: 404, statusMessage: "Session not found" });
}

async function loadConversation() {
  const [summary, navigator] = await Promise.all([
    repository.getSession(sessionId),
    repository.getTurnNavigator(sessionId),
  ]);
  const initialChunk = await repository.getTurns(
    sessionId,
    targetTurnId.value === null
      ? { cursor: recentChunkCursor(summary.turnCount), limit: 20 }
      : { targetTurnId: targetTurnId.value, limit: 20 },
  );
  return { summary, navigator, initialChunk };
}

const asyncConversation = await useLazyAsyncData(`conversation:${sessionId}`, loadConversation, {
  server: false,
  deep: false,
});
const { data, error, status } = asyncConversation;

useHead(() => ({
  title: `${data.value?.summary.title ?? "Conversation"} · Codex Sessions Viewer`,
}));
</script>

<template>
  <div class="session-page" :class="{ 'has-subagent-panel': childPanelOpen }">
    <div class="session-page__main">
      <ConversationView
        v-if="data !== undefined && data !== null"
        :summary="data.summary"
        :navigator="data.navigator"
        :initial-chunk="data.initialChunk"
        :initial-target-turn-id="targetTurnId"
        :mode="mode"
        @open-child="openChild"
      >
        <template #actions="{ summary }">
          <button
            v-if="summary.childThreadIds.length"
            class="session-page__subagents"
            type="button"
            @click="
              childPanelOpen = true;
              selectedChildId = null;
            "
          >
            Subagents · {{ summary.childThreadIds.length }}
          </button>
        </template>
      </ConversationView>
      <section
        v-else-if="status === 'pending' || status === 'idle'"
        class="conversation-loading"
        role="status"
        aria-live="polite"
      >
        <p class="conversation-heading__kicker">Preparing conversation</p>
        <h1 class="theme-display">Loading the selected conversation…</h1>
        <p>The library remains available while the read-only session payload is prepared.</p>
        <LibrarySkeleton :rows="5" />
      </section>
      <section v-else class="conversation-loading is-error" role="alert">
        <p class="conversation-heading__kicker">Conversation unavailable</p>
        <h1 class="theme-display">The selected conversation could not be loaded.</h1>
        <p>{{ error?.message ?? "Return to the library and try again." }}</p>
      </section>
    </div>
    <LibrarySubagentPanel
      v-if="childPanelOpen"
      :parent-id="sessionId"
      :selected-id="selectedChildId"
      :mode="mode"
      @select="selectedChildId = $event"
      @close="childPanelOpen = false"
    />
  </div>
</template>

<style scoped>
.session-page {
  display: grid;
  min-width: 0;
  height: 100%;
}
.session-page.has-subagent-panel {
  grid-template-columns: minmax(0, 1fr) minmax(360px, 42%);
}
.session-page__main {
  min-width: 0;
  min-height: 0;
  position: relative;
}
.session-page__subagents {
  padding: 0.4rem 0.7rem;
  border: 1px solid currentColor;
  border-radius: 0.5rem;
  background: var(--color-surface-raised);
  color: inherit;
  cursor: pointer;
}
@media (max-width: 1000px) {
  .session-page.has-subagent-panel {
    grid-template-columns: minmax(0, 1fr);
  }
  .session-page.has-subagent-panel > :last-child {
    position: fixed;
    inset: 4rem 0.5rem 0.5rem;
    z-index: 20;
    background: var(--color-surface);
  }
}
</style>
