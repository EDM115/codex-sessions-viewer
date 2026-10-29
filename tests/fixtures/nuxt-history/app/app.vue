<script setup lang="ts">
import type { CatalogSessionMetadata } from "#shared/types/library.ts";
import { LiveApiConversationRepository } from "~/repositories/live.ts";

const repository = new LiveApiConversationRepository();
const metadata = shallowRef<CatalogSessionMetadata | null>(null);
onMounted(async () => {
  metadata.value = await repository.getSessionMetadata("thread-1");
});
</script>

<template>
  <main>
    <ConversationProgressiveConversationView
      v-if="metadata"
      :metadata="metadata"
      :repository="repository"
      :target-turn-id="null"
    />
  </main>
</template>
