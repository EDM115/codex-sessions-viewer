<script setup lang="ts">
import type { ApprovalEvidenceResult } from "#shared/types/approvals.ts";
import type { JsonValue } from "#shared/types/conversation.ts";

const props = defineProps<{
  evidence: ApprovalEvidenceResult | null;
  loading: boolean;
  error: string | null;
  disclosureKey: string;
}>();
defineEmits<{ load: [] }>();
const standalone = computed(
  () => props.evidence?.unattached.filter(({ review }) => review.outcome !== "allow") ?? [],
);
</script>

<template>
  <section data-approval-evidence aria-label="Approval evidence">
    <button type="button" :disabled="loading" @click="$emit('load')">
      {{
        loading
          ? "Loading approval evidence…"
          : evidence
            ? "Refresh approval evidence"
            : "Load approval evidence"
      }}
    </button>
    <p v-if="error" role="status">{{ error }}</p>
    <template v-if="evidence">
      <p role="status">
        Approval source: {{ evidence.parentSource?.availability ?? "unresolved" }}.
        {{
          evidence.parentSource?.availability === "complete"
            ? "Loaded source coverage is complete."
            : "Other attempts may not be loaded."
        }}
      </p>
      <article
        v-for="(entry, index) in standalone"
        :key="`${entry.review.reviewId ?? 'review'}:${index}`"
      >
        <p>Unattached approval · {{ entry.reason.replaceAll("-", " ") }}</p>
        <ConversationApprovalAttempt
          :attempt="entry.review"
          :disclosure-key="`${disclosureKey}:${index}`"
        />
      </article>
      <ConversationRaw
        label="Approval inspector · all attempts and source records"
        :value="evidence as unknown as JsonValue"
      />
    </template>
  </section>
</template>
