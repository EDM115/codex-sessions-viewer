<script setup lang="ts">
import type { GuardianApprovalEvidence } from "#shared/types/conversation.ts";
import { approvalLabel } from "~/components/conversation/toolPresentation.ts";

const props = defineProps<{ attempt: GuardianApprovalEvidence; disclosureKey: string }>();
const { open, toggle } = useWorkDisclosure(() => `${props.disclosureKey}:approval`, "unknown");
</script>

<template>
  <details
    class="conversation-tool-row__approval"
    :class="attempt.outcome === 'deny' ? 'is-denied' : null"
    :open="open"
    @toggle="toggle"
  >
    <summary :aria-expanded="open">
      {{ approvalLabel(attempt) }} · {{ attempt.riskLevel }} risk
    </summary>
    <p v-if="open">{{ attempt.rationale || "No rationale supplied." }}</p>
  </details>
</template>
