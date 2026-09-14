import { computed, readonly, shallowRef } from "vue";

import { CONVERSATION_CHUNK_SIZE, mergeConversationTurns } from "#shared/timeline/conversation.ts";
import type { ConversationTurn } from "#shared/types/conversation.ts";
import type { ConversationRepository, TurnChunk } from "#shared/types/repository.ts";

export {
  CONVERSATION_CHUNK_SIZE,
  mergeConversationTurns,
  recentChunkCursor,
} from "#shared/timeline/conversation.ts";

export interface ConversationTimelineOptions {
  sessionId: string;
  repository: Pick<ConversationRepository, "getTurns">;
  initialChunk: TurnChunk;
}

export interface TargetWindowOptions {
  limit?: number;
  beforeApply?: (chunk: TurnChunk) => void;
  afterApply?: (chunk: TurnChunk) => void;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "The conversation chunk could not be loaded.";
}

export function useConversationTimeline(options: ConversationTimelineOptions) {
  const turns = shallowRef<ConversationTurn[]>([...options.initialChunk.turns]);
  const previousCursor = shallowRef(options.initialChunk.previousCursor);
  const nextCursor = shallowRef(options.initialChunk.nextCursor);
  const revision = shallowRef(options.initialChunk.revision);
  const error = shallowRef<string | null>(null);
  const loadingBefore = shallowRef(false);
  const loadingAfter = shallowRef(false);
  const loadingTarget = shallowRef(false);
  const pendingTurnId = shallowRef<string | null>(null);
  const targetErrorTurnId = shallowRef<string | null>(null);
  let beforeRequest: Promise<void> | null = null;
  let afterRequest: Promise<void> | null = null;
  let targetRequest: Promise<void> | null = null;
  let windowGeneration = 0;
  let refreshGeneration = 0;
  let requestSequence = 0;
  let appliedRevisionSequence = 0;
  let appliedErrorSequence = 0;
  const turnSequences = new Map(turns.value.map(({ id }) => [id, 0]));

  function applyError(reason: unknown, sequence: number): void {
    if (sequence >= appliedErrorSequence) {
      error.value = messageFrom(reason);
      appliedErrorSequence = sequence;
    }
  }

  function clearError(sequence: number): void {
    if (sequence >= appliedErrorSequence) {
      error.value = null;
      appliedErrorSequence = sequence;
    }
  }

  function mergeSequencedTurns(incoming: readonly ConversationTurn[], sequence: number): void {
    const accepted = incoming.filter(({ id }) => sequence >= (turnSequences.get(id) ?? -1));
    for (const { id } of accepted) {
      turnSequences.set(id, sequence);
    }
    turns.value = mergeConversationTurns(turns.value, accepted);
  }

  function applyRevision(chunk: TurnChunk, sequence: number): void {
    if (sequence >= appliedRevisionSequence) {
      revision.value = chunk.revision;
      appliedRevisionSequence = sequence;
    }
  }

  function mergeChunk(
    chunk: TurnChunk,
    direction: "before" | "after",
    sequence: number,
    beforeApply?: (chunk: TurnChunk) => void,
    afterApply?: (chunk: TurnChunk) => void,
  ): void {
    beforeApply?.(chunk);
    mergeSequencedTurns(chunk.turns, sequence);
    applyRevision(chunk, sequence);
    clearError(sequence);
    if (direction === "before") {
      previousCursor.value = chunk.previousCursor;
    } else {
      nextCursor.value = chunk.nextCursor;
    }
    afterApply?.(chunk);
  }

  function loadDirection(
    direction: "before" | "after",
    beforeApply?: (chunk: TurnChunk) => void,
    afterApply?: (chunk: TurnChunk) => void,
  ): Promise<void> {
    if (targetRequest !== null) {
      return Promise.resolve();
    }
    const pending = direction === "before" ? beforeRequest : afterRequest;
    if (pending !== null) {
      return pending;
    }
    const cursor = direction === "before" ? previousCursor.value : nextCursor.value;
    if (cursor === null) {
      return Promise.resolve();
    }
    const loading = direction === "before" ? loadingBefore : loadingAfter;
    const generation = windowGeneration;
    const sequence = ++requestSequence;
    loading.value = true;
    clearError(sequence);
    const request = options.repository
      .getTurns(options.sessionId, { cursor, direction, limit: CONVERSATION_CHUNK_SIZE })
      .then((chunk) =>
        generation === windowGeneration
          ? mergeChunk(chunk, direction, sequence, beforeApply, afterApply)
          : undefined,
      )
      .catch((reason: unknown) => {
        if (generation === windowGeneration) {
          applyError(reason, sequence);
        }
      })
      .finally(() => {
        const activeRequest = direction === "before" ? beforeRequest : afterRequest;
        if (activeRequest === request) {
          loading.value = false;
          if (direction === "before") {
            beforeRequest = null;
          } else {
            afterRequest = null;
          }
        }
      });
    if (direction === "before") {
      beforeRequest = request;
    } else {
      afterRequest = request;
    }
    return request;
  }

  function loadTarget(turnId: string, targetOptions: TargetWindowOptions = {}): Promise<void> {
    const generation = ++windowGeneration;
    const sequence = ++requestSequence;
    beforeRequest = null;
    afterRequest = null;
    loadingBefore.value = false;
    loadingAfter.value = false;
    clearError(sequence);
    targetErrorTurnId.value = null;
    if (turns.value.some(({ id }) => id === turnId)) {
      targetRequest = null;
      loadingTarget.value = false;
      pendingTurnId.value = null;
      return Promise.resolve();
    }
    loadingTarget.value = true;
    pendingTurnId.value = turnId;
    const request = options.repository
      .getTurns(options.sessionId, {
        targetTurnId: turnId,
        limit: targetOptions.limit ?? CONVERSATION_CHUNK_SIZE,
      })
      .then((chunk) => {
        if (generation === windowGeneration) {
          targetOptions.beforeApply?.(chunk);
          turns.value = [...chunk.turns];
          turnSequences.clear();
          for (const { id } of chunk.turns) {
            turnSequences.set(id, sequence);
          }
          previousCursor.value = chunk.previousCursor;
          nextCursor.value = chunk.nextCursor;
          applyRevision(chunk, sequence);
          clearError(sequence);
          targetOptions.afterApply?.(chunk);
        }
        return undefined;
      })
      .catch((reason: unknown) => {
        if (generation === windowGeneration) {
          applyError(reason, sequence);
          targetErrorTurnId.value = turnId;
        }
      })
      .finally(() => {
        if (targetRequest === request) {
          targetRequest = null;
          loadingTarget.value = false;
          pendingTurnId.value = null;
        }
      });
    targetRequest = request;
    return request;
  }

  function cancelTarget(): void {
    if (targetRequest === null) {
      return;
    }
    windowGeneration += 1;
    targetRequest = null;
    loadingTarget.value = false;
    pendingTurnId.value = null;
  }

  async function refresh(
    anchorTurnId = turns.value.at(-1)?.id,
    beforeApply?: () => void,
  ): Promise<void> {
    const currentRefresh = ++refreshGeneration;
    if (anchorTurnId === undefined) {
      return;
    }
    if (targetRequest !== null) {
      return;
    }
    const generation = windowGeneration;
    const sequence = ++requestSequence;
    const firstIndex = turns.value[0]?.index;
    const lastIndex = turns.value.at(-1)?.index;
    const previousAtStart = previousCursor.value;
    const nextAtStart = nextCursor.value;
    try {
      const chunk = await options.repository.getTurns(options.sessionId, {
        targetTurnId: anchorTurnId,
        limit: CONVERSATION_CHUNK_SIZE,
      });
      if (generation !== windowGeneration || currentRefresh !== refreshGeneration) {
        return;
      }
      beforeApply?.();
      mergeSequencedTurns(chunk.turns, sequence);
      const chunkFirstIndex = chunk.turns[0]?.index;
      const chunkLastIndex = chunk.turns.at(-1)?.index;
      if (
        (firstIndex === undefined ||
          (chunkFirstIndex !== undefined && chunkFirstIndex <= firstIndex)) &&
        previousCursor.value === previousAtStart
      ) {
        previousCursor.value = chunk.previousCursor;
      }
      if (
        (lastIndex === undefined ||
          (chunkLastIndex !== undefined && chunkLastIndex >= lastIndex)) &&
        nextCursor.value === nextAtStart
      ) {
        nextCursor.value = chunk.nextCursor;
      }
      applyRevision(chunk, sequence);
      clearError(sequence);
    } catch (reason) {
      if (generation === windowGeneration && currentRefresh === refreshGeneration) {
        applyError(reason, sequence);
      }
    }
  }

  return {
    turns,
    revision: readonly(revision),
    error: readonly(error),
    loadingBefore: readonly(loadingBefore),
    loadingAfter: readonly(loadingAfter),
    loadingTarget: readonly(loadingTarget),
    pendingTurnId: readonly(pendingTurnId),
    targetErrorTurnId: readonly(targetErrorTurnId),
    canLoadBefore: computed(() => previousCursor.value !== null),
    canLoadAfter: computed(() => nextCursor.value !== null),
    loadBefore: (
      beforeApply?: (chunk: TurnChunk) => void,
      afterApply?: (chunk: TurnChunk) => void,
    ) => loadDirection("before", beforeApply, afterApply),
    loadAfter: () => loadDirection("after"),
    loadTarget,
    cancelTarget,
    refresh,
  } as const;
}
