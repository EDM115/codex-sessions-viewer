<script setup lang="ts">
import { LiveApiConversationRepository } from "~/repositories/live.ts";

const route = useRoute();
const sessionId = "id" in route.params ? String(route.params.id) : "";
const targetTurnId = computed(() =>
  typeof route.query.turn === "string" ? route.query.turn : null,
);
const repository = new LiveApiConversationRepository();
const { data } = await useLazyAsyncData(
  `legacy-fixture:${sessionId}`,
  async () => {
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
  },
  { server: false, deep: false },
);
</script>

<template>
  <div style="height: 100%; min-height: 0">
    <ConversationView
      v-if="data"
      :summary="data.summary"
      :navigator="data.navigator"
      :initial-chunk="data.initialChunk"
      :initial-target-turn-id="targetTurnId"
      mode="live"
    />
  </div>
</template>
