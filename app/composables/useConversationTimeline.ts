import { CONVERSATION_CHUNK_SIZE, mergeConversationTurns } from "#shared/timeline/conversation.ts";
import {
  mergeHistoryWindows,
  retainHistoryWindows,
  historyItemIslands,
} from "#shared/timeline/history.ts";
import { historyItemMarkdown } from "#shared/timeline/historyPresentation.ts";
import type { ConversationTurn } from "#shared/types/conversation.ts";
import type {
  HistoryPage,
  HistoryTurnWindow,
  HistoryPresentation,
  HistoryPresentationRequest,
} from "#shared/types/history.ts";
import type {
  ConversationRepository,
  TurnChunk,
  HistoryPageQuery,
  HistoryItemQuery,
} from "#shared/types/repository.ts";

export {
  CONVERSATION_CHUNK_SIZE,
  mergeConversationTurns,
  recentChunkCursor,
} from "#shared/timeline/conversation.ts";

export interface ConversationTimelineOptions {
  sessionId: string;
  repository: Pick<ConversationRepository, "getTurns">;
  initialChunk: TurnChunk;
  anchorTurnId?: () => string | null;
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
  const reloadBeforeTurn = shallowRef<string | null>(null);
  const reloadAfterTurn = shallowRef<string | null>(null);
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

  const chunkEdges = new Map<string, { before: string | null; after: string | null }>();
  function rememberChunk(chunk: TurnChunk) {
    for (const turn of chunk.turns) {
      chunkEdges.set(turn.id, { before: chunk.previousCursor, after: chunk.nextCursor });
    }
  }
  rememberChunk(options.initialChunk);
  function boundTurns(direction: "before" | "after") {
    if (turns.value.length <= 60) {
      return;
    }
    const anchor = turns.value.findIndex((turn) => turn.id === options.anchorTurnId?.());
    let start = direction === "before" ? 0 : turns.value.length - 60;
    if (anchor >= 0 && (anchor < start || anchor >= start + 60)) {
      start = Math.max(0, Math.min(turns.value.length - 60, anchor - 20));
    }
    reloadBeforeTurn.value = turns.value[start - 1]?.id ?? reloadBeforeTurn.value;
    reloadAfterTurn.value = turns.value[start + 60]?.id ?? reloadAfterTurn.value;
    turns.value = turns.value.slice(start, start + 60);
    const first = turns.value[0];
    const last = turns.value.at(-1);
    if (first) {
      previousCursor.value = chunkEdges.get(first.id)?.before ?? previousCursor.value;
    }
    if (last) {
      nextCursor.value = chunkEdges.get(last.id)?.after ?? nextCursor.value;
    }
    const retained = new Set(turns.value.map((turn) => turn.id));
    for (const id of turnSequences.keys()) {
      if (!retained.has(id)) {
        turnSequences.delete(id);
      }
    }
    for (const id of chunkEdges.keys()) {
      if (!retained.has(id)) {
        chunkEdges.delete(id);
      }
    }
  }

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
    rememberChunk(chunk);
    mergeSequencedTurns(chunk.turns, sequence);
    applyRevision(chunk, sequence);
    clearError(sequence);
    if (direction === "before") {
      reloadBeforeTurn.value = null;
      previousCursor.value = chunk.previousCursor;
    } else {
      reloadAfterTurn.value = null;
      nextCursor.value = chunk.nextCursor;
    }
    boundTurns(direction);
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
    const reloadTurn = direction === "before" ? reloadBeforeTurn.value : reloadAfterTurn.value;
    if (cursor === null && reloadTurn === null) {
      return Promise.resolve();
    }
    const loading = direction === "before" ? loadingBefore : loadingAfter;
    const generation = windowGeneration;
    const sequence = ++requestSequence;
    loading.value = true;
    clearError(sequence);
    const request = options.repository
      .getTurns(
        options.sessionId,
        reloadTurn
          ? { targetTurnId: reloadTurn, limit: CONVERSATION_CHUNK_SIZE }
          : { cursor: cursor!, direction, limit: CONVERSATION_CHUNK_SIZE },
      )
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
          reloadBeforeTurn.value = null;
          reloadAfterTurn.value = null;
          chunkEdges.clear();
          rememberChunk(chunk);
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
      rememberChunk(chunk);
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
      boundTurns("after");
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
    canLoadBefore: computed(() => previousCursor.value !== null || reloadBeforeTurn.value !== null),
    canLoadAfter: computed(() => nextCursor.value !== null || reloadAfterTurn.value !== null),
    loadBefore: (
      beforeApply?: (chunk: TurnChunk) => void,
      afterApply?: (chunk: TurnChunk) => void,
    ) => loadDirection("before", beforeApply, afterApply),
    loadAfter: (beforeApply?: (chunk: TurnChunk) => void) => loadDirection("after", beforeApply),
    loadTarget,
    cancelTarget,
    refresh,
  } as const;
}

export function useProgressiveHistoryTimeline(options: {
  sessionId: string;
  repository: Pick<ConversationRepository, "getHistoryPage" | "getTurnItems"> &
    Partial<Pick<ConversationRepository, "prepareHistoryPresentation">>;
  initialPage?: HistoryPage;
  beforeApply?: () => void;
  afterApply?: () => void;
}) {
  const windows = shallowRef<HistoryTurnWindow[]>(
    mergeHistoryWindows([], options.initialPage?.turns ?? []),
  );
  const page = shallowRef<HistoryPage | null>(options.initialPage ?? null);
  const error = shallowRef<string | null>(null);
  const loading = shallowRef(false);
  const stale = shallowRef(false);
  const presentations = shallowRef<HistoryPresentation[]>([]);
  const pending = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const consumed = new Map<
    string,
    {
      revision: string;
      epoch: string;
      ranges: Array<{ physical: string; turn: string; items: string[] | null }>;
    }
  >();
  const pageEdges = new Map<
    string,
    { before: string | null; after: string | null; query: HistoryPageQuery }
  >();
  let reloadBefore: HistoryPageQuery | null = null;
  let reloadAfter: HistoryPageQuery | null = null;
  let visibleKeys: Set<string> | null = null;
  let richActive = 0;
  let expandedItems = new Set<string>();
  const failedRich = new Set<string>();
  const windowKey = (window: HistoryTurnWindow) =>
    JSON.stringify([window.physicalRolloutId, window.turnId]);
  for (const window of options.initialPage?.turns ?? []) {
    pageEdges.set(windowKey(window), {
      before: options.initialPage?.beforeCursor ?? null,
      after: options.initialPage?.afterCursor ?? null,
      query: { anchor: { kind: "turn", turnId: window.turnId }, limit: 20 },
    });
  }
  function boundWindow(
    result: HistoryPage | HistoryTurnWindow,
    direction: string,
    query: HistoryPageQuery | HistoryItemQuery,
  ) {
    if ("turns" in result && !("turnId" in query)) {
      for (const window of result.turns) {
        pageEdges.set(windowKey(window), {
          before: result.beforeCursor,
          after: result.afterCursor,
          query,
        });
      }
    }
    const evicted = windows.value.length > 60;
    if (evicted) {
      let start = direction === "before" ? 0 : windows.value.length - 60;
      const focused = windows.value.findIndex((window) => visibleKeys?.has(windowKey(window)));
      if (focused >= 0 && (focused < start || focused >= start + 60)) {
        start = Math.max(0, Math.min(windows.value.length - 60, focused - 20));
      }
      const before = windows.value[start - 1];
      const after = windows.value[start + 60];
      if (before) {
        reloadBefore = pageEdges.get(windowKey(before))?.query ?? reloadBefore;
      }
      if (after) {
        reloadAfter = pageEdges.get(windowKey(after))?.query ?? reloadAfter;
      }
      windows.value = windows.value.slice(start, start + 60);
    }
    if (!("turns" in result)) {
      windows.value = windows.value.map((window) => {
        if (
          window.items.length <= 300 ||
          window.physicalRolloutId !== result.physicalRolloutId ||
          !(
            window.turnId === result.turnId ||
            window.boundary?.identityAliases.includes(result.turnId)
          )
        ) {
          return window;
        }
        // A bounded reread keeps the source's actual cursors and islands, never a guessed ordinal
        return {
          ...result,
          turnId: window.turnId,
          boundary: window.boundary,
          opening: window.opening,
          itemsView: "summary" as const,
          itemIslands: [
            ...(window.opening.itemId &&
            !result.items.some((item) => item.itemId === window.opening.itemId)
              ? [[window.opening.itemId]]
              : []),
            ...historyItemIslands(result),
          ],
          coverage: {
            ...result.coverage,
            status: "partial" as const,
            gaps: [
              ...result.coverage.gaps,
              {
                physicalRolloutId: result.physicalRolloutId,
                turnId: window.turnId,
                reason: "Earlier loaded details were evicted, use the item page controls to reload",
                beforeOrdinal: null,
                afterOrdinal: null,
              },
            ],
          },
        };
      });
    }
    windows.value = windows.value.map((window) =>
      window.reviewEvidence && window.reviewEvidence.records.length > 300
        ? {
            ...window,
            reviewEvidence: {
              ...window.reviewEvidence,
              availability:
                window.reviewEvidence.availability === "unresolved" ? "unresolved" : "partial",
              records: window.reviewEvidence.records.slice(-300),
            },
          }
        : window,
    );
    const retained = new Set(windows.value.map(windowKey));
    for (const key of pageEdges.keys()) {
      if (!retained.has(key)) {
        pageEdges.delete(key);
      }
    }
    presentations.value = presentations.value.filter((entry) =>
      windows.value.some(
        (window) =>
          window.physicalRolloutId === entry.physicalRolloutId &&
          window.turnId === entry.turnId &&
          window.historyEpoch === entry.historyEpoch &&
          window.contentRevision === entry.contentRevision &&
          (window.opening.itemId === entry.itemId ||
            window.items.some((item) => item.itemId === entry.itemId)),
      ),
    );
    if (page.value) {
      const first = windows.value[0];
      const last = windows.value.at(-1);
      page.value = {
        ...page.value,
        beforeCursor: first ? (pageEdges.get(windowKey(first))?.before ?? null) : null,
        afterCursor: last ? (pageEdges.get(windowKey(last))?.after ?? null) : null,
        coverage: {
          ...page.value.coverage,
          status: evicted ? "partial" : page.value.coverage.status,
        },
      };
    }
    // Page metadata must not keep a second, potentially evicted raw turn payload alive
    if (page.value) {
      page.value = { ...page.value, turns: [] };
    }
    for (const [key, record] of consumed) {
      const rangeRetained = record.ranges.every((range) => {
        const window = windows.value.find(
          (entry) =>
            entry.physicalRolloutId === range.physical &&
            entry.historyEpoch === record.epoch &&
            (entry.turnId === range.turn || entry.boundary?.identityAliases.includes(range.turn)),
        );
        return (
          window &&
          (range.items === null ||
            range.items.every((id) => window.items.some((item) => item.itemId === id)))
        );
      });
      if (!rangeRetained) {
        consumed.delete(key);
      }
    }
    while (consumed.size > 512) {
      consumed.delete(consumed.keys().next().value!);
    }
    while (failedRich.size > 128) {
      failedRich.delete(failedRich.values().next().value!);
    }
  }
  const cursorOwners = new Map<
    string,
    { turnId: string; historyEpoch: string; physicalRolloutId: string }
  >();
  function registerCursors(turns: readonly HistoryTurnWindow[]) {
    for (const turn of turns) {
      for (const cursor of [turn.beforeCursor, turn.afterCursor, turn.preparation?.cursor]) {
        if (cursor) {
          cursorOwners.set(cursor, {
            turnId: turn.turnId,
            historyEpoch: turn.historyEpoch,
            physicalRolloutId: turn.physicalRolloutId,
          });
        }
      }
    }
    const retainedCursors = new Set(
      windows.value.flatMap((window) => [
        window.beforeCursor,
        window.afterCursor,
        window.preparation?.cursor,
      ]),
    );
    for (const cursor of cursorOwners.keys()) {
      if (cursorOwners.size <= 512) {
        break;
      }
      if (!retainedCursors.has(cursor)) {
        cursorOwners.delete(cursor);
      }
    }
  }
  registerCursors(options.initialPage?.turns ?? []);
  function cursorTurn(turnId: string, anchor: HistoryItemQuery["anchor"]): string {
    const window = windows.value.find(
      (entry) => entry.turnId === turnId || entry.boundary?.identityAliases.includes(turnId),
    );
    const owner = "cursor" in anchor ? cursorOwners.get(anchor.cursor) : undefined;
    return owner &&
      window?.historyEpoch === owner.historyEpoch &&
      window.physicalRolloutId === owner.physicalRolloutId
      ? owner.turnId
      : turnId;
  }
  let sequence = 0;
  let revisionSequence = 0;
  let selection = 0;
  let disposed = false;

  function prepareVisible(): void {
    const prepare = options.repository.prepareHistoryPresentation;
    if (!prepare) {
      return;
    }
    let requested = 0;
    for (const window of windows.value) {
      if (visibleKeys && !visibleKeys.has(windowKey(window))) {
        continue;
      }
      const final = window.items.find((entry) => entry.itemId === window.finalAnswerItemId);
      const openingEntry = window.items.find((entry) => entry.itemId === window.opening.itemId);
      const visible = [
        window.opening.availability === "available" &&
        (!openingEntry || openingEntry.detail === "full")
          ? window.opening.item
          : null,
        final?.detail === "full" ? final.item : null,
        ...window.items
          .filter(
            (entry) =>
              entry.detail === "full" && expandedItems.has(`${windowKey(window)}:${entry.itemId}`),
          )
          .map((entry) => entry.item),
      ];
      for (const item of visible) {
        if (!item) {
          continue;
        }
        const markdown = historyItemMarkdown(item);
        if (markdown === null) {
          continue;
        }
        if (++requested > 128) {
          return;
        }
        const query: HistoryPresentationRequest = {
          threadId: options.sessionId,
          historyEpoch: window.historyEpoch,
          contentRevision: window.contentRevision,
          physicalRolloutId: window.physicalRolloutId,
          turnId: window.turnId,
          itemId: item.id,
          markdown,
        };
        const key = `rich:${JSON.stringify(query)}`;
        if (
          pending.has(key) ||
          failedRich.has(key) ||
          presentations.value.some(
            (entry) => JSON.stringify({ ...entry, body: undefined }) === JSON.stringify(query),
          )
        ) {
          continue;
        }
        if (richActive >= 2) {
          return;
        }
        richActive += 1;
        const controller = new AbortController();
        const currentSelection = selection;
        const promise = prepare(query, { signal: controller.signal })
          .then((result) => {
            if (controller.signal.aborted || disposed || selection !== currentSelection) {
              return undefined;
            }
            const current = windows.value.find(
              (entry) =>
                entry.turnId === query.turnId &&
                entry.physicalRolloutId === query.physicalRolloutId &&
                entry.historyEpoch === query.historyEpoch &&
                entry.contentRevision === query.contentRevision,
            );
            const currentItem =
              current?.opening.availability === "available" &&
              current.opening.item?.id === query.itemId &&
              !current.items.some(
                (entry) => entry.itemId === query.itemId && entry.detail !== "full",
              )
                ? current.opening.item
                : current?.items.find(
                    (entry) => entry.itemId === query.itemId && entry.detail === "full",
                  )?.item;
            if (
              !currentItem ||
              historyItemMarkdown(currentItem) !== query.markdown ||
              JSON.stringify({ ...result, body: undefined }) !== JSON.stringify(query)
            ) {
              return undefined;
            }
            presentations.value = [
              ...presentations.value.filter(
                (entry) =>
                  !(
                    entry.physicalRolloutId === query.physicalRolloutId &&
                    entry.turnId === query.turnId &&
                    entry.itemId === query.itemId
                  ),
              ),
              result,
            ].slice(-128);
            return undefined;
          })
          .catch(() => {
            if (!controller.signal.aborted) {
              failedRich.add(key);
            }
          })
          .finally(() => {
            richActive -= 1;
            if (pending.get(key)?.controller === controller) {
              pending.delete(key);
            }
            if (!disposed) {
              prepareVisible();
            }
          });
        pending.set(key, { controller, promise });
      }
    }
  }

  function cancel(key?: string) {
    for (const [name, pendingRequest] of pending) {
      if (key === undefined || name === key) {
        pendingRequest.controller.abort();
        pending.delete(name);
      }
    }
    loading.value = [...pending.keys()].some((name) => !name.startsWith("rich:"));
  }
  function request(
    key: string,
    query: HistoryPageQuery | HistoryItemQuery,
    replaceEpoch = false,
  ): Promise<void> {
    if (disposed) {
      return Promise.resolve();
    }
    const existing = pending.get(key);
    if (existing) {
      return existing.promise;
    }
    const controller = new AbortController();
    const currentSelection = selection;
    const currentSequence = ++sequence;
    const cursor = "cursor" in query.anchor ? query.anchor.cursor : null;
    const cursorKey = JSON.stringify([
      "turnId" in query ? query.turnId : null,
      query.anchor.kind,
      cursor,
    ]);
    loading.value = true;
    const promise = (
      "turnId" in query
        ? options.repository.getTurnItems(options.sessionId, query, { signal: controller.signal })
        : options.repository.getHistoryPage(options.sessionId, query, { signal: controller.signal })
    )
      .then((result) => {
        if (disposed || controller.signal.aborted || currentSelection !== selection) {
          return undefined;
        }
        if ("threadId" in result && result.threadId !== options.sessionId) {
          throw new Error("History belongs to a different conversation");
        }
        if (
          "turnId" in query &&
          "turnId" in result &&
          result.turnId !== query.turnId &&
          !result.boundary?.identityAliases.includes(query.turnId)
        ) {
          throw new Error("History belongs to a different turn");
        }
        if (
          cursor &&
          ((consumed.get(cursorKey)?.revision === result.contentRevision &&
            consumed.get(cursorKey)?.epoch === result.historyEpoch) ||
            (query.anchor.kind === "before" ? result.beforeCursor : result.afterCursor) === cursor)
        ) {
          throw new Error("History cursor did not advance, reload the selected window");
        }
        if (
          currentSequence < revisionSequence &&
          result.contentRevision !== page.value?.contentRevision
        ) {
          return undefined;
        }
        if (page.value && result.historyEpoch !== page.value.historyEpoch && !replaceEpoch) {
          stale.value = true;
          throw new Error("History changed, reload the selected window");
        }
        if ("turns" in result && (result.stale || result.preparation === "unavailable")) {
          stale.value = windows.value.length > 0;
          error.value =
            result.coverage.gaps.map((gap) => gap.reason).join(", ") ||
            "History is temporarily unavailable";
          if (!page.value) {
            page.value = result;
          }
          return undefined;
        }
        if (cursor) {
          consumed.set(cursorKey, {
            revision: result.contentRevision,
            epoch: result.historyEpoch,
            ranges: ("turns" in result ? result.turns : [result]).map((entry) => ({
              physical: entry.physicalRolloutId,
              turn: entry.turnId,
              items: "turns" in result ? null : entry.items.map((item) => item.itemId),
            })),
          });
        }
        options.beforeApply?.();
        if (key === "before") {
          reloadBefore = null;
        }
        if (key === "after") {
          reloadAfter = null;
        }
        if (page.value?.historyEpoch !== result.historyEpoch) {
          pageEdges.clear();
          reloadBefore = null;
          reloadAfter = null;
          windows.value = [];
          consumed.clear();
          cursorOwners.clear();
        }
        registerCursors("turns" in result ? result.turns : [result]);
        windows.value = mergeHistoryWindows(
          retainHistoryWindows(windows.value, result.contentRevision),
          "turns" in result ? result.turns : [result],
          "turnId" in query && "cursor" in query.anchor
            ? { turnId: query.turnId, cursor: query.anchor.cursor, direction: query.anchor.kind }
            : undefined,
          query.anchor.kind,
        );
        for (const pendingKey of pending.keys()) {
          if (pendingKey.startsWith("rich:")) {
            cancel(pendingKey);
          }
        }
        if ("turns" in result) {
          const previous = page.value;
          page.value = {
            ...result,
            beforeCursor:
              query.anchor.kind === "before" || !previous || replaceEpoch
                ? result.beforeCursor
                : previous.beforeCursor,
            afterCursor:
              query.anchor.kind === "after" || !previous || replaceEpoch
                ? result.afterCursor
                : previous.afterCursor,
          };
        } else if (page.value) {
          page.value = { ...page.value, contentRevision: result.contentRevision };
        }
        boundWindow(result, key, query);
        options.afterApply?.();
        revisionSequence = Math.max(revisionSequence, currentSequence);
        stale.value =
          (key !== "latest" && pending.has("latest")) ||
          windows.value.some(
            (window) =>
              window.opening.availability === "unresolved" ||
              window.items.some((item) => item.detail === "unresolved"),
          );
        error.value = null;
        prepareVisible();
        return undefined;
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && !disposed && currentSelection === selection) {
          error.value = messageFrom(reason);
        }
      })
      .finally(() => {
        if (pending.get(key)?.controller === controller) {
          pending.delete(key);
        }
        loading.value = [...pending.keys()].some((name) => !name.startsWith("rich:"));
      });
    pending.set(key, { controller, promise });
    return promise;
  }
  return {
    setExpanded(keys: readonly string[]) {
      expandedItems = new Set(keys.slice(0, 128));
      prepareVisible();
    },
    setVisible(keys: readonly string[]) {
      visibleKeys = new Set(keys);
      prepareVisible();
    },
    windows: shallowReadonly(windows),
    presentations: shallowReadonly(presentations),
    page: readonly(page),
    error: readonly(error),
    loading: readonly(loading),
    stale: readonly(stale),
    canLoadBefore: computed(() => reloadBefore !== null || page.value?.beforeCursor != null),
    canLoadAfter: computed(() => reloadAfter !== null || page.value?.afterCursor != null),
    loadBefore: () =>
      reloadBefore
        ? request("before", reloadBefore)
        : page.value?.beforeCursor
          ? request("before", {
              anchor: { kind: "before", cursor: page.value.beforeCursor },
              limit: 20,
            })
          : Promise.resolve(),
    loadAfter: () =>
      reloadAfter
        ? request("after", reloadAfter)
        : page.value?.afterCursor
          ? request("after", {
              anchor: { kind: "after", cursor: page.value.afterCursor },
              limit: 20,
            })
          : Promise.resolve(),
    cancelTarget() {
      cancel("target");
    },
    loadTarget(turnId: string) {
      cancel("before");
      cancel("target");
      cancel("latest");
      return request("target", { anchor: { kind: "turn", turnId }, limit: 5 }, page.value === null);
    },
    refresh() {
      cancel("latest");
      stale.value = windows.value.length > 0;
      return request("latest", { anchor: { kind: "latest" }, limit: 5 }, true);
    },
    loadItems(turnId: string, anchor: HistoryItemQuery["anchor"] = { kind: "latest" }) {
      return request(`items:${turnId}:${JSON.stringify(anchor)}`, {
        turnId: cursorTurn(turnId, anchor),
        anchor,
        limit: anchor.kind === "opening" ? 2 : 100,
      });
    },
    prepare(turnId: string) {
      const cursor = windows.value.find((entry) => entry.turnId === turnId)?.preparation?.cursor;
      const anchor = { kind: "after" as const, cursor: cursor ?? "" };
      return cursor
        ? request(`prepare:${turnId}`, { turnId: cursorTurn(turnId, anchor), anchor, limit: 100 })
        : Promise.resolve();
    },
    dispose() {
      disposed = true;
      selection += 1;
      cancel();
    },
  };
}
