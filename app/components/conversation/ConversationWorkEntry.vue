<script setup lang="ts">
import { PhRobot, PhWarning, PhGlobe, PhListChecks, PhInfo } from "@phosphor-icons/vue";
import { computed, ref } from "vue";

import type { ConversationActivity, ConversationMessage } from "#shared/types/conversation.ts";
import type { InspectorTarget, ResolvedAsset } from "#shared/types/repository.ts";

import type { MediaViewerItem } from "../../composables/useMediaViewer.ts";
import DiffBlock from "../content/DiffBlock.client.vue";
import RichTextRenderer from "../content/RichTextRenderer.vue";
import ConversationAttachment from "./ConversationAttachment.vue";
import ConversationFileChanges from "./ConversationFileChanges.vue";
import ConversationRaw from "./ConversationRaw.vue";
import ConversationReasoning from "./ConversationReasoning.vue";
import ConversationToolRow from "./ConversationToolRow.vue";
import { bodyAssetIds, statusLabel, subagentLabel } from "./toolPresentation.ts";
const props = defineProps<{
  activity?: ConversationActivity | undefined;
  message?: ConversationMessage | undefined;
  resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
  resolveFavicon?: (origin: string) => Promise<string | null>;
}>();
const emit = defineEmits<{
  inspect: [target: InspectorTarget];
  openMedia: [item: MediaViewerItem];
  openChild: [id: string];
}>();
const open = ref(false);
const entryId = computed(() => props.message?.id ?? props.activity?.id ?? "missing-entry");
const attachments = computed(() => {
  if (props.message === undefined) {
    return [];
  }
  const embedded = bodyAssetIds(props.message.body);
  return [...new Set(props.message.attachmentIds)].filter((id) => !embedded.has(id));
});
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
    return subagentLabel(activity);
  }
  if (activity.kind === "status") {
    return activity.message;
  }
  if (activity.kind === "compaction") {
    return activity.summary ?? "Conversation compacted";
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
      @open-media="emit('openMedia', $event)"
    />
    <ConversationAttachment
      v-for="id in attachments"
      :key="id"
      :asset-id="id"
      :resolve-asset="resolveAsset"
      @open-media="emit('openMedia', $event)"
    />
  </article>
  <ConversationReasoning
    v-else-if="activity?.kind === 'reasoning'"
    :activity="activity"
    :resolve-asset="resolveAsset"
    :resolve-favicon="resolveFavicon"
    @open-media="emit('openMedia', $event)"
  />
  <ConversationToolRow
    v-else-if="activity?.kind === 'tool'"
    :activity="activity"
    @inspect="emit('inspect', { type: 'activity', id: $event })"
    @open-child="emit('openChild', $event)"
  />
  <ConversationFileChanges v-else-if="activity?.kind === 'file_change'" :activities="[activity]" />
  <ConversationAttachment
    v-else-if="activity?.kind === 'media'"
    :asset-id="activity.assetId"
    :resolve-asset="resolveAsset"
    @open-media="emit('openMedia', $event)"
  />
  <article
    v-else-if="activity !== undefined"
    class="conversation-work-row conversation-work-row--typed"
    :class="'status' in activity && activity.status === 'failed' ? 'is-failed' : null"
    :data-entry-id="entryId"
  >
    <details @toggle="open = ($event.currentTarget as HTMLDetailsElement).open">
      <summary>
        <PhWarning
          v-if="'status' in activity && activity.status === 'failed'"
          :size="18"
          aria-hidden="true"
        />
        <PhRobot v-else-if="activity.kind === 'subagent'" :size="18" aria-hidden="true" />
        <PhGlobe v-else-if="activity.kind === 'web_search'" :size="18" aria-hidden="true" />
        <PhListChecks v-else-if="activity.kind === 'plan'" :size="18" aria-hidden="true" />
        <PhInfo v-else :size="18" aria-hidden="true" />
        <span>{{ activityLabel(activity) }}</span
        ><small v-if="'status' in activity">{{ statusLabel(activity.status) }}</small>
      </summary>
      <div v-if="open">
        <p v-if="activity.kind === 'subagent'">{{ activity.description }}</p>
        <p v-if="activity.kind === 'subagent' && activity.childThreadId !== null">
          <a
            :href="`/session/${encodeURIComponent(activity.childThreadId)}`"
            @click.prevent="emit('openChild', activity.childThreadId)"
            >Open {{ activity.description }} conversation</a
          >
        </p>
        <ol v-if="activity.kind === 'plan'">
          <li v-for="(item, index) in activity.items" :key="index">
            {{ item.step }} · {{ item.status.replaceAll("_", " ") }}
          </li>
        </ol>
        <p v-if="activity.kind === 'web_search'">
          Query: {{ activity.query }} ·
          {{
            activity.resultCount === null
              ? "Result count unavailable"
              : `${activity.resultCount} results`
          }}
        </p>
        <DiffBlock v-if="activity.kind === 'patch'" :source="activity.patch" wrapped />
        <button type="button" @click="emit('inspect', { type: 'activity', id: activity.id })">
          Inspect preserved record
        </button>
        <ConversationRaw
          v-if="activity.kind === 'unknown'"
          label="Raw event"
          :value="activity.payload"
        />
      </div>
    </details>
  </article>
  <article v-else class="conversation-work-row is-failed" :data-entry-id="entryId">
    <PhWarning :size="18" aria-hidden="true" /> Missing work entry
  </article>
</template>
<style scoped>
.conversation-work-row--typed {
  display: block;
}
.conversation-work-row--typed summary {
  display: flex;
  gap: 0.5rem;
  cursor: pointer;
  align-items: center;
}
.conversation-work-row--typed summary > span {
  flex: 1;
}
.conversation-work-row--typed summary > svg {
  flex-shrink: 0;
}
</style>
