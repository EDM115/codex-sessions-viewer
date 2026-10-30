<script setup lang="ts">
import type { RepositoryMode } from "#shared/types/repository.ts";
import { createConversationRepository } from "~/repositories/index.ts";
import type { RepositoryRequester } from "~/repositories/live.ts";

const route = useRoute();
definePageMeta({
  key: (destination) =>
    "id" in destination.params ? String(destination.params.id) : destination.path,
});
const childPanelOpen = ref(false);
const selectedChildId = ref<string | null>(null);
let childPanelOpener: HTMLElement | null = null;
function openChild(id: string) {
  childPanelOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  selectedChildId.value = id;
  childPanelOpen.value = true;
}
function openChildren() {
  childPanelOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  selectedChildId.value = null;
  childPanelOpen.value = true;
}
async function closeChildren() {
  childPanelOpen.value = false;
  await nextTick();
  if (childPanelOpener?.isConnected) {
    childPanelOpener.focus();
  }
}
const runtimeConfig = useRuntimeConfig();
const requestFetch = useRequestFetch();
const mode: RepositoryMode = runtimeConfig.public.viewerMode === "static" ? "static" : "live";
const requester: RepositoryRequester = (path, options = {}) =>
  requestFetch<unknown, string, "get" | "post" | "delete">(path, {
    method: options.method === "POST" ? "post" : options.method === "DELETE" ? "delete" : "get",
    signal: options.signal,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
  });
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
  if (
    repository.capabilities().progressiveHistory ||
    (await repository.supportsHistory?.(sessionId, { signal: selectionController.signal }))
  ) {
    const metadata = await repository.getSessionMetadata(sessionId, {
      signal: selectionController.signal,
    });
    return { kind: "progressive" as const, metadata };
  }
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
  return { kind: "legacy" as const, summary, navigator, initialChunk };
}

const selectionController = new AbortController();
onBeforeUnmount(() => selectionController.abort());

const asyncConversation = await useLazyAsyncData(`conversation:${sessionId}`, loadConversation, {
  server: false,
  deep: false,
});
const { data, error, status } = asyncConversation;

useHead(() => ({
  title: `${data.value?.kind === "progressive" ? data.value.metadata.title : (data.value?.summary.title ?? "Conversation")} · Codex Sessions Viewer`,
}));
</script>

<template>
  <div class="session-page" :class="{ 'has-subagent-panel': childPanelOpen }">
    <div class="session-page__main">
      <ConversationProgressiveConversationView
        v-if="data?.kind === 'progressive'"
        :metadata="data.metadata"
        :repository="repository"
        :target-turn-id="targetTurnId"
        @open-child="openChild"
      >
        <template #actions="{ summary }">
          <button
            v-if="summary.childThreadIds.length"
            class="session-page__subagents"
            type="button"
            @click="openChildren"
          >
            Subagents · {{ summary.childThreadIds.length }}
          </button>
        </template>
      </ConversationProgressiveConversationView>
      <ConversationView
        v-else-if="data?.kind === 'legacy'"
        :summary="data.summary"
        :navigator="data.navigator"
        :initial-chunk="data.initialChunk"
        :initial-target-turn-id="targetTurnId"
        :mode="mode"
        :legacy-evidence="mode === 'static'"
        @open-child="openChild"
      >
        <template #actions="{ summary }">
          <button
            v-if="summary.childThreadIds.length"
            class="session-page__subagents"
            type="button"
            @click="openChildren"
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
      @close="closeChildren"
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
