<script setup lang="ts">
import type { ReasoningActivity, DisclosureDefault } from "#shared/types/conversation.ts";
import type { ResolvedAsset } from "#shared/types/repository.ts";
import { hasReasoning, reasoningText } from "~/components/conversation/toolPresentation.ts";
import type { MediaViewerItem } from "~/composables/useMediaViewer.ts";

const props = defineProps<{
  activity: ReasoningActivity;
  disclosureKey?: string;
  reasoningDefault?: DisclosureDefault;
  resolveAsset?: (assetId: string) => Promise<ResolvedAsset>;
  resolveFavicon?: (origin: string) => Promise<string | null>;
}>();
const emit = defineEmits<{ openMedia: [item: MediaViewerItem] }>();
const { open, toggle } = useWorkDisclosure(
  () => `${props.disclosureKey ?? props.activity.id}:reasoning`,
  "unknown",
  () => props.reasoningDefault ?? "collapsed",
);
const body = computed(() => {
  const summary = props.activity.summary.trim();
  const text = reasoningText(props.activity);
  const document = props.activity.body;
  const summaryNode = { type: "text" as const, text: summary };
  if (document === null) {
    return { type: "document" as const, children: [summaryNode] };
  }
  if (
    !summary ||
    props.activity.bodyFromSummary ||
    summary.replace(/\s+/gu, " ") === text.replace(/\s+/gu, " ")
  ) {
    return document;
  }
  return {
    type: "document" as const,
    children: [summaryNode, { type: "text" as const, text: "\n" }, ...document.children],
  };
});
</script>

<template>
  <details
    v-if="hasReasoning(activity)"
    class="conversation-work-entry conversation-reasoning"
    :data-entry-id="activity.id"
    :open="open"
    @toggle="toggle"
  >
    <summary class="conversation-work-entry__label" :aria-expanded="open">Reasoning</summary>
    <ContentRichTextRenderer
      v-if="open"
      :document="body"
      :resolve-asset="resolveAsset"
      :resolve-favicon="resolveFavicon"
      @open-media="emit('openMedia', $event)"
    />
  </details>
</template>
