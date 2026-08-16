<script setup lang="ts">
import type { RepositoryMode } from "#shared/types/repository.ts";

import ConversationView from "../../components/conversation/ConversationView.vue";
import LibrarySkeleton from "../../components/library/LibrarySkeleton.vue";
import { recentChunkCursor } from "../../composables/useConversationTimeline.ts";
import { createConversationRepository } from "../../repositories/index.ts";
import type { RepositoryRequester } from "../../repositories/live.ts";

const route = useRoute();
const runtimeConfig = useRuntimeConfig();
const requestFetch = useRequestFetch() as unknown as (
  path: string,
  options: { signal?: AbortSignal },
) => Promise<unknown>;
const mode: RepositoryMode = runtimeConfig.public.viewerMode === "static" ? "static" : "live";
const requester: RepositoryRequester = (path, options = {}) =>
  requestFetch(path, { signal: options.signal }) as Promise<unknown>;
const repository = createConversationRepository(mode, requester);
const sessionId = Array.isArray(route.params.id) ? route.params.id[0] : route.params.id;
const targetTurnId = typeof route.query.turn === "string" ? route.query.turn : null;

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
    targetTurnId === null
      ? { cursor: recentChunkCursor(summary.turnCount), limit: 20 }
      : { targetTurnId, limit: 20 },
  );
  return { summary, navigator, initialChunk };
}

const asyncConversation = await useLazyAsyncData(
  `conversation:${sessionId}:${targetTurnId ?? "recent"}`,
  loadConversation,
);
const { data, error, status } = asyncConversation;

useHead(() => ({
  title: `${data.value?.summary.title ?? "Conversation"} · Codex Sessions Viewer`,
}));
</script>

<template>
  <ConversationView
    v-if="data !== undefined && data !== null"
    :summary="data.summary"
    :navigator="data.navigator"
    :initial-chunk="data.initialChunk"
    :initial-target-turn-id="targetTurnId"
    :mode="mode"
  />
  <section
    v-else-if="status === 'pending'"
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
</template>
