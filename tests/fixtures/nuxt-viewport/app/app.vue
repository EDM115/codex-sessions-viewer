<script setup lang="ts">
import type { ConversationSummary, TurnNavigatorItem } from "#shared/types/conversation.ts";
import type { CatalogSessionMetadata } from "#shared/types/library.ts";
import type { TurnChunk } from "#shared/types/repository.ts";
import { LiveApiConversationRepository } from "~/repositories/live.ts";
const { settings, setTheme } = usePresentationSettings();
const repository = new LiveApiConversationRepository();
const payload = shallowRef<{
  summary: ConversationSummary;
  navigator: TurnNavigatorItem[];
  chunk: TurnChunk;
} | null>(null);
const metadata = shallowRef<CatalogSessionMetadata | null>(null);
const progressive = ref(false);
const target = ref<string | null>(null);
const visible = ref(true);
const narrow = ref(false);
const sessionId = ref("");
onMounted(async () => {
  const url = new URL(window.location.href);
  sessionId.value = url.searchParams.get("id") ?? url.pathname.split("/").at(-1)!;
  target.value = url.searchParams.get("turn");
  progressive.value = url.searchParams.has("progressive");
  if (progressive.value) {
    metadata.value = await repository.getSessionMetadata(sessionId.value);
  } else {
    const [summary, navigator, chunk] = await Promise.all([
      repository.getSession(sessionId.value),
      repository.getTurnNavigator(sessionId.value),
      repository.getTurns(sessionId.value, { targetTurnId: target.value ?? undefined, limit: 20 }),
    ]);
    payload.value = { summary, navigator, chunk };
  }
});
</script>
<template>
  <div class="app-root" :data-theme="settings.theme">
    <div class="fixture-controls">
      <button data-theme-choice="quiet-precision" @click="setTheme('quiet-precision')">
        Light theme</button
      ><button @click="target = null">Clear navigation target</button
      ><button @click="visible = !visible">Toggle chat</button
      ><button @click="narrow = !narrow">Resize child panel</button
      ><button @click="target = 'geometry-0'">Distant target</button>
    </div>
    <main class="fixture-surface" :style="{ width: narrow ? '65%' : '100%' }">
      <ConversationProgressiveConversationView
        v-if="visible && metadata"
        :metadata="metadata"
        :repository="repository"
        :target-turn-id="target"
      />
      <ConversationView
        v-else-if="visible && payload"
        :summary="payload.summary"
        :navigator="payload.navigator"
        :initial-chunk="payload.chunk"
        :initial-target-turn-id="target"
        mode="live"
      />
    </main>
  </div>
</template>
<style>
.fixture-controls {
  height: 35px;
}
.fixture-surface {
  height: calc(100vh - 35px);
  min-width: 0;
}
</style>
