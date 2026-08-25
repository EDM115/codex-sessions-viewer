<script setup lang="ts">
import { PhRobot, PhWarning } from "@phosphor-icons/vue";
import { computed } from "vue";

import type { ConversationActivity, ConversationMessage } from "#shared/types/conversation.ts";
import type { ResolvedAsset } from "#shared/types/repository.ts";

import RichTextRenderer from "../content/RichTextRenderer.vue";
import ConversationReasoning from "./ConversationReasoning.vue";
import ConversationToolRow from "./ConversationToolRow.vue";
import { mediaReferenceText } from "./format.ts";

const props = defineProps<{
  activity?: ConversationActivity | undefined;
  message?: ConversationMessage | undefined;
  resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
  resolveFavicon?: (origin: string) => Promise<string | null>;
}>();
const entryId = computed(() => props.message?.id ?? props.activity?.id ?? "missing-entry");

function activityLabel(activity: ConversationActivity): string {
  if (activity.kind === "web_search") {
    return `Web search · ${activity.query}`;
  }
  if (activity.kind === "patch") {
    return `Patch · ${activity.affectedPaths.join(", ") || "no paths"}`;
  }
  if (activity.kind === "plan") {
    return activity.title ?? "Plan update";
  }
  if (activity.kind === "subagent") {
    return activity.description;
  }
  if (activity.kind === "status") {
    return activity.message;
  }
  if (activity.kind === "compaction") {
    return activity.summary ?? "Conversation compacted";
  }
  if (activity.kind === "media") {
    return `${activity.mediaType} · ${mediaReferenceText(activity)}`;
  }
  if (activity.kind === "unknown") {
    return `Unknown protocol event · ${activity.eventType}`;
  }
  return "Activity";
}
</script>

<template>
  <article
    v-if="message !== undefined"
    class="conversation-work-entry"
    :data-entry-id="entryId"
    data-work-entry
  >
    <p class="conversation-work-entry__label">
      {{ message.role === "user" ? "You · steering" : "Assistant · progress" }}
    </p>
    <RichTextRenderer
      :document="message.body"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
    />
  </article>
  <ConversationReasoning
    v-else-if="activity?.kind === 'reasoning'"
    :activity="activity"
    :resolve-asset="resolveAsset"
    :resolve-favicon="resolveFavicon"
  />
  <ConversationToolRow
    v-else-if="activity?.kind === 'tool'"
    :activity="activity"
    :data-entry-id="entryId"
  />
  <article
    v-else-if="activity !== undefined"
    class="conversation-work-row"
    :class="'status' in activity && activity.status === 'failed' ? 'is-failed' : null"
    :data-entry-id="entryId"
  >
    <PhWarning
      v-if="'status' in activity && activity.status === 'failed'"
      :size="18"
      weight="regular"
      aria-hidden="true"
    />
    <PhRobot
      v-else-if="activity.kind === 'subagent'"
      :size="18"
      weight="regular"
      aria-hidden="true"
    />
    <a
      v-if="activity.kind === 'subagent' && activity.childThreadId !== null"
      :href="`/session/${encodeURIComponent(activity.childThreadId)}`"
      >{{ activityLabel(activity) }}</a
    >
    <span v-else>{{ activityLabel(activity) }}</span>
    <small v-if="'status' in activity">{{ activity.status }}</small>
  </article>
  <article v-else class="conversation-work-row is-failed" :data-entry-id="entryId">
    <PhWarning :size="18" weight="regular" aria-hidden="true" /> Missing work entry
  </article>
</template>
