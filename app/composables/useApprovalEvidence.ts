import type { MaybeRefOrGetter } from "vue";

import type { ApprovalEvidenceResult } from "#shared/types/approvals.ts";
import type { ConversationTurn } from "#shared/types/conversation.ts";
import type { ConversationRepository } from "#shared/types/repository.ts";

/** Approval source proof is independent of native item coverage, publication belongs to this selection snapshot */
export function useApprovalEvidence(
  repository: MaybeRefOrGetter<ConversationRepository>,
  sessionId: MaybeRefOrGetter<string>,
  owner: MaybeRefOrGetter<string>,
) {
  const evidence = shallowRef<ApprovalEvidenceResult | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let controller: AbortController | null = null;
  let generation = 0;
  function reset() {
    generation++;
    controller?.abort();
    controller = null;
    evidence.value = null;
    loading.value = false;
    error.value = null;
  }
  watch(() => [toValue(repository), toValue(sessionId), toValue(owner)], reset, { flush: "sync" });
  onBeforeUnmount(reset);
  async function load() {
    const source = toValue(repository);
    if (!source.getApprovalEvidence || loading.value) {
      return;
    }
    const selected = toValue(sessionId);
    const snapshot = toValue(owner);
    const request = ++generation;
    controller?.abort();
    controller = new AbortController();
    loading.value = true;
    error.value = null;
    try {
      const result = await source.getApprovalEvidence(selected, { signal: controller.signal });
      if (
        request === generation &&
        selected === toValue(sessionId) &&
        snapshot === toValue(owner) &&
        result.sessionId === selected
      ) {
        evidence.value = result;
      }
    } catch (cause) {
      if (request === generation) {
        error.value = cause instanceof Error ? cause.message : "Approval evidence unavailable";
      }
    } finally {
      if (request === generation) {
        loading.value = false;
      }
    }
  }
  function present(turn: ConversationTurn): ConversationTurn {
    if (!evidence.value) {
      return turn;
    }
    return {
      ...turn,
      activities: turn.activities.map((activity) => {
        if (activity.kind !== "tool") {
          return activity;
        }
        const matched = evidence.value!.matched.find(
          (match) => match.activityId === activity.id || match.activityId === activity.nativeItemId,
        );
        if (!matched) {
          return activity;
        }
        const attempts = matched.attempts.filter(
          (attempt) =>
            !attempt.sourceRecords ||
            attempt.sourceRecords.every((record) => record.logicalVisibility === "visible"),
        );
        return {
          ...activity,
          approvalAttempts: attempts,
          approval: attempts.findLast((attempt) => attempt.outcome !== null) ?? null,
        };
      }),
    };
  }
  return { evidence, loading, error, load, present };
}
