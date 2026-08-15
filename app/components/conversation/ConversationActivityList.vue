<script setup lang="ts">
import { PhCaretRight, PhRobot, PhWarning } from "@phosphor-icons/vue";
import { computed } from "vue";

import type {
  ConversationActivity,
  DisclosureDefault,
  ReasoningActivity,
} from "#shared/types/conversation.ts";

import ConversationToolRow from "./ConversationToolRow.vue";

const props = defineProps<{
  activities: ConversationActivity[];
  reasoningDefault: DisclosureDefault;
  toolCallsDefault: DisclosureDefault;
}>();

const emit = defineEmits<{
  beforeResize: [];
  resized: [];
}>();

const reasoning = computed(() =>
  props.activities.filter(
    (activity): activity is ReasoningActivity => activity.kind === "reasoning",
  ),
);
const work = computed(() =>
  props.activities.filter(
    (activity) => activity.kind !== "reasoning" && activity.kind !== "unknown",
  ),
);

function workLabel(activity: Exclude<ConversationActivity, ReasoningActivity>): string {
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
    return `Agent · ${activity.description}`;
  }
  if (activity.kind === "status") {
    return activity.message;
  }
  if (activity.kind === "compaction") {
    return activity.summary ?? "Conversation compacted";
  }
  if (activity.kind === "media") {
    return `${activity.mediaType} · ${activity.sourcePath ?? activity.assetId}`;
  }
  return "Activity";
}

function activityStatus(activity: ConversationActivity): string | null {
  return "status" in activity ? activity.status : null;
}
</script>

<template>
  <section v-if="reasoning.length > 0" class="conversation-activity-group">
    <details
      class="conversation-activity-disclosure"
      data-activity-group="reasoning"
      :open="reasoningDefault === 'expanded'"
      @toggle="emit('resized')"
    >
      <summary @pointerdown="emit('beforeResize')" @keydown.enter="emit('beforeResize')">
        <PhCaretRight
          class="conversation-activity-disclosure__caret"
          :size="17"
          weight="regular"
          aria-hidden="true"
        />
        Reasoning <span>{{ reasoning.length }}</span>
      </summary>
      <div class="conversation-reasoning-list">
        <article v-for="activity in reasoning" :key="activity.id">
          <p>{{ activity.summary || "Reasoning details unavailable" }}</p>
          <span v-if="activity.encrypted">Encrypted source retained</span>
        </article>
      </div>
    </details>
  </section>
  <section v-if="work.length > 0" class="conversation-activity-group">
    <details
      class="conversation-activity-disclosure"
      data-activity-group="work"
      :open="toolCallsDefault === 'expanded'"
      @toggle="emit('resized')"
    >
      <summary @pointerdown="emit('beforeResize')" @keydown.enter="emit('beforeResize')">
        <PhCaretRight
          class="conversation-activity-disclosure__caret"
          :size="17"
          weight="regular"
          aria-hidden="true"
        />
        Agent work <span>{{ work.length }}</span>
      </summary>
      <div class="conversation-work-list">
        <template v-for="activity in work" :key="activity.id">
          <ConversationToolRow v-if="activity.kind === 'tool'" :activity="activity" />
          <article
            v-else
            class="conversation-work-row"
            :class="activityStatus(activity) === 'failed' ? 'is-failed' : null"
          >
            <PhWarning
              v-if="activityStatus(activity) === 'failed'"
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
            <span>{{ workLabel(activity) }}</span>
            <small v-if="activityStatus(activity) !== null">{{ activityStatus(activity) }}</small>
          </article>
        </template>
      </div>
    </details>
  </section>
</template>
