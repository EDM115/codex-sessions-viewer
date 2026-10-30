import { historyActivity, activityObject } from "#shared/timeline/activityPresentation.ts";
import { expandRecordedCells } from "#shared/timeline/codeMode.ts";
import { isFinalAnswerPhase } from "#shared/timeline/finalAnswer.ts";
import { historyItemIslands } from "#shared/timeline/history.ts";
import { historyItemAttachments } from "#shared/timeline/historyAttachments.ts";
import type {
  ConversationTurn,
  ConversationMessage,
  ConversationActivity,
  ToolActivity,
} from "#shared/types/conversation.ts";
import type { HistoryItem, HistoryTurnWindow, HistoryPresentation } from "#shared/types/history.ts";
import type { InspectorRecord, InspectorTarget } from "#shared/types/repository.ts";

export interface HistoryPresentedTurn extends ConversationTurn {
  messageAliases: Record<string, string[]>;
}

const timestamp = (value: number | null) => (value === null ? null : new Date(value).toISOString());

/** Inspect only the loaded snapshot, absent source IDs and complete-turn metrics remain unknown */
export function historyWindowInspector(
  sessionId: string,
  window: HistoryTurnWindow,
  target: InspectorTarget,
): InspectorRecord | null {
  if (target.type === "turn" && target.id !== window.turnId) {
    return null;
  }
  const renderedActivities =
    target.type === "activity" ? historyWindowPresentation(sessionId, window).activities : [];
  const activity = renderedActivities.find((candidate) => candidate.id === target.id);
  const parentActivityId = activityObject(activity?.presentation?.details)?.["parentActivityId"];
  const selectedId = typeof parentActivityId === "string" ? parentActivityId : target.id;
  const owner = renderedActivities.find((candidate) => candidate.id === selectedId);
  const sourceEventId = activityObject(activity?.presentation?.details)?.["sourceEventId"];
  const selectedDelta =
    typeof sourceEventId === "string"
      ? window.items.find((candidate) => candidate.itemId === sourceEventId)
      : undefined;
  const deltaIds =
    owner?.kind === "tool"
      ? (owner.codeMode?.deltas.map((delta) => delta.sourceEventId) ?? [])
      : [];
  const deltaEvidence = window.items
    .filter((candidate) => deltaIds.includes(candidate.itemId))
    .flatMap((candidate) => (candidate.item?.evidence == null ? [] : [candidate.item.evidence]));
  const entry = window.items.find((candidate) => candidate.itemId === selectedId);
  const opening = window.opening.itemId === selectedId ? window.opening : null;
  const item = entry?.item ?? opening?.item ?? null;
  if (target.type !== "turn" && !item) {
    return null;
  }
  if (
    target.type !== "turn" &&
    item &&
    (target.type === "message") !== (item.type === "userMessage" || item.type === "agentMessage")
  ) {
    return null;
  }
  const rawRecords =
    target.type === "turn"
      ? [
          ...new Map(
            [
              ...(window.opening.item ? [window.opening.item] : []),
              ...window.items.flatMap((candidate) => (candidate.item ? [candidate.item] : [])),
            ].map((candidate) => [candidate.id, candidate]),
          ).values(),
        ]
          .flatMap((candidate) => (candidate.evidence === null ? [] : [candidate.evidence]))
          .concat(window.reviewEvidence ? [{ reviewEvidence: window.reviewEvidence }] : [])
      : item?.evidence === null || item?.evidence === undefined
        ? []
        : [
            item.evidence,
            ...deltaEvidence,
            ...(activity?.presentation ? [activity.presentation.details] : []),
          ];
  const detail =
    target.type === "turn"
      ? window.itemsView === "full" &&
        window.coverage.status === "complete" &&
        !window.items.some((candidate) => candidate.detail !== "full") &&
        window.opening.availability !== "unresolved"
        ? "full"
        : "unresolved"
      : selectedDelta && selectedDelta.detail !== "full"
        ? selectedDelta.detail
        : (entry?.detail ??
          (opening?.availability === "available"
            ? "full"
            : opening?.availability === "unsupported"
              ? "unsupported"
              : opening?.availability === "unresolved"
                ? "unresolved"
                : "notLoaded"));
  return {
    sessionId,
    target,
    models: window.context?.complete && window.context.model ? [window.context.model] : [],
    reasoningEfforts:
      window.context?.complete && window.context.effort ? [window.context.effort] : [],
    phase: item?.type === "agentMessage" ? item.phase : null,
    createdAt: timestamp(target.type === "turn" ? window.startedAt : (item?.startedAtMs ?? null)),
    completedAt: timestamp(
      target.type === "turn" ? window.completedAt : (item?.completedAtMs ?? null),
    ),
    durationMs:
      target.type === "turn"
        ? window.durationMs
        : item && "durationMs" in item
          ? item.durationMs
          : null,
    timeToFirstTokenMs: null,
    tokenDelta: null,
    toolCounts: {},
    activityIds: [],
    eventIds: [],
    diagnosticIds: [],
    rawRecords,
    historySnapshot: {
      threadId: sessionId,
      physicalRolloutId: window.physicalRolloutId,
      turnId: window.turnId,
      sourceTurnId: window.boundary?.sourceTurnId ?? null,
      itemId: target.type === "turn" ? null : selectedId,
      historyEpoch: window.historyEpoch,
      contentRevision: window.contentRevision,
      detail,
      evidenceAvailable: rawRecords.length > 0,
      ordinal: entry?.ordinal ?? null,
      updatedAtOrdinal: entry?.updatedAtOrdinal ?? null,
      decodedByteStart: entry?.decodedByteStart ?? null,
      decodedByteEnd: entry?.decodedByteEnd ?? null,
      updatedAtDecodedByte: entry?.updatedAtDecodedByte ?? null,
    },
  };
}

export function historyGapBeforeItemIds(window: HistoryTurnWindow): string[] {
  const ids: string[] = [];
  const islands = historyItemIslands(window);
  let previous = window.items[0];
  if (
    window.opening.itemId &&
    previous &&
    previous.itemId !== window.opening.itemId &&
    !islands.some(
      (island) => island.includes(window.opening.itemId!) && island.includes(previous!.itemId),
    )
  ) {
    ids.push(previous.itemId);
  }
  for (const item of window.items.slice(1)) {
    if (!previous) {
      break;
    }
    const connected = islands.some(
      (island) => island.includes(previous!.itemId) && island.includes(item.itemId),
    );
    if (!connected) {
      ids.push(item.itemId);
    }
    previous = item;
  }
  return ids;
}

/** Only message and explicitly expanded reasoning text is eligible for rich presentation */
export function historyItemMarkdown(item: HistoryItem): string | null {
  if (item.type === "imageGeneration") {
    return "";
  }
  if (item.type === "userMessage" || item.type === "agentMessage") {
    return item.text;
  }
  if (item.type === "reasoning") {
    return [
      ...new Set([...item.summary, ...item.content].map((text) => text.trim()).filter(Boolean)),
    ].join("\n");
  }
  return null;
}

/** Adapt only the loaded slice to the established message/work renderers, retain the full history evidence separately */
export function historyWindowPresentation(
  sessionId: string,
  window: HistoryTurnWindow,
  presentations: readonly HistoryPresentation[] = [],
): HistoryPresentedTurn {
  const messages: ConversationMessage[] = [];
  const activities: ConversationActivity[] = [];
  const order: NonNullable<ConversationTurn["entryOrder"]> = [];
  const items = new Map<string, HistoryItem>();
  if (window.opening.item) {
    items.set(window.opening.item.id, window.opening.item);
  }
  for (const entry of window.items) {
    if (entry.item) {
      items.set(entry.itemId, entry.item);
    }
  }
  for (const [id, item] of items) {
    const base = {
      id,
      turnId: window.turnId,
      createdAt: timestamp(item.startedAtMs),
      rawEventIds: [],
    };
    if (item.type === "userMessage" || item.type === "agentMessage") {
      const observed = window.items.find((entry) => entry.itemId === id);
      const qualified = observed
        ? observed.detail === "full"
        : window.opening.itemId === id && window.opening.availability === "available";
      const prepared = qualified
        ? presentations.find(
            (entry) =>
              entry.threadId === sessionId &&
              entry.historyEpoch === window.historyEpoch &&
              entry.contentRevision === window.contentRevision &&
              entry.physicalRolloutId === window.physicalRolloutId &&
              entry.turnId === window.turnId &&
              entry.itemId === id &&
              entry.markdown === item.text &&
              JSON.stringify(entry.attachments ?? []) ===
                JSON.stringify(historyItemAttachments(item)),
          )
        : undefined;
      messages.push({
        ...base,
        role: item.type === "userMessage" ? "user" : "assistant",
        phase: item.type === "agentMessage" ? item.phase : null,
        sourceMarkdown: item.text,
        body: prepared?.body ?? { type: "document", children: [{ type: "text", text: item.text }] },
        attachmentIds: [],
      });
      order.push({ kind: "message", id });
      continue;
    }
    if (item.type === "imageGeneration") {
      const prepared = presentations.find(
        (entry) =>
          entry.threadId === sessionId &&
          entry.historyEpoch === window.historyEpoch &&
          entry.contentRevision === window.contentRevision &&
          entry.physicalRolloutId === window.physicalRolloutId &&
          entry.turnId === window.turnId &&
          entry.itemId === id &&
          JSON.stringify(entry.attachments ?? []) === JSON.stringify(historyItemAttachments(item)),
      );
      const media = prepared?.body.children.find((node) => node.type === "media");
      activities.push({
        ...base,
        kind: "media",
        assetId: media?.type === "media" && media.assetId ? media.assetId : "",
        mediaType: "image",
        reference: {
          kind: "invalid",
          reason: "missing",
          preview:
            media?.type === "media" ? media.originalSource : "Recorded image has not been prepared",
          sourceHash: null,
        },
      });
      order.push({ kind: "activity", id });
      continue;
    }
    const semantic = historyActivity(item, { turnId: window.turnId, sessionId, rawEventIds: [] });
    if (item.type === "reasoning") {
      activities.push({
        ...base,
        kind: "reasoning",
        summary: [
          ...new Set([...item.summary, ...item.content].map((text) => text.trim()).filter(Boolean)),
        ].join("\n"),
        body:
          window.items.find((entry) => entry.itemId === id)?.detail === "full"
            ? (presentations.find(
                (entry) =>
                  entry.threadId === sessionId &&
                  entry.historyEpoch === window.historyEpoch &&
                  entry.contentRevision === window.contentRevision &&
                  entry.physicalRolloutId === window.physicalRolloutId &&
                  entry.turnId === window.turnId &&
                  entry.itemId === id &&
                  entry.markdown === historyItemMarkdown(item),
              )?.body ?? null)
            : null,
        bodyFromSummary: true,
        encrypted: false,
      });
    } else if (item.type === "contextCompaction") {
      activities.push({ ...base, kind: "compaction", summary: null });
    } else if (semantic) {
      activities.push(semantic);
    } else {
      activities.push({
        ...base,
        kind: "unknown",
        eventType: item.type,
        payload: item.evidence ?? item,
      });
    }
    order.push({ kind: "activity", id });
  }
  const duplicateMessageIds = new Set<string>();
  const messageAliases: Record<string, string[]> = {};
  const islands = historyItemIslands(window);
  let previousMessage: ConversationMessage | null = null;
  const sourceEnvelope = (id: string) =>
    activityObject(activityObject(items.get(id)?.evidence)?.["source"]);
  function provedMessagePair(first: ConversationMessage, second: ConversationMessage): boolean {
    if (first.role !== second.role || first.sourceMarkdown !== second.sourceMarkdown) {
      return false;
    }
    if (
      !(
        first.phase === second.phase ||
        first.phase === null ||
        second.phase === null ||
        (isFinalAnswerPhase(first.phase) && isFinalAnswerPhase(second.phase))
      )
    ) {
      return false;
    }
    if (
      ![first, second].every(
        (message) =>
          window.items.some((entry) => entry.itemId === message.id && entry.detail === "full") ||
          (window.opening.itemId === message.id && window.opening.availability === "available"),
      )
    ) {
      return false;
    }
    if (!islands.some((island) => island.includes(first.id) && island.includes(second.id))) {
      return false;
    }
    const firstSource = sourceEnvelope(first.id);
    const secondSource = sourceEnvelope(second.id);
    if (firstSource?.["type"] === secondSource?.["type"]) {
      return false;
    }
    const canonical =
      firstSource?.["type"] === "response_item"
        ? first
        : secondSource?.["type"] === "response_item"
          ? second
          : null;
    const notification =
      firstSource?.["type"] === "event_msg"
        ? first
        : secondSource?.["type"] === "event_msg"
          ? second
          : null;
    if (!canonical || !notification) {
      return false;
    }
    const payload = activityObject(sourceEnvelope(canonical.id)?.["payload"]);
    const echo = activityObject(sourceEnvelope(notification.id)?.["payload"]);
    if (
      payload?.["type"] !== "message" ||
      payload["role"] !== canonical.role ||
      echo?.["type"] !== (canonical.role === "assistant" ? "agent_message" : "user_message")
    ) {
      return false;
    }
    const identity = (value: ReturnType<typeof activityObject>, ...keys: string[]) =>
      keys
        .map((key) => value?.[key])
        .find(
          (candidate): candidate is string => typeof candidate === "string" && candidate !== "",
        ) ?? null;
    const canonicalId = identity(payload, "id", "item_id", "message_id");
    const notificationId = identity(echo, "id", "item_id", "message_id");
    const canonicalTurn =
      identity(payload, "turn_id", "turnId") ??
      identity(
        activityObject(payload["internal_chat_message_metadata_passthrough"]),
        "turn_id",
        "turnId",
      );
    const notificationTurn = identity(echo, "turn_id", "turnId");
    if (canonicalTurn && notificationTurn && canonicalTurn !== notificationTurn) {
      return false;
    }
    if (notificationId !== null) {
      return canonicalId !== null && notificationId === canonicalId;
    }
    // An idless final echo needs a selected member of its proved pair, equal ordinary prose stays separate
    return (
      canonicalId !== null &&
      (canonical.id === window.finalAnswerItemId || notification.id === window.finalAnswerItemId) &&
      isFinalAnswerPhase(canonical.phase) &&
      isFinalAnswerPhase(notification.phase)
    );
  }
  for (const reference of order) {
    const message =
      reference.kind === "message"
        ? messages.find((entry) => entry.id === reference.id)
        : undefined;
    if (!message) {
      previousMessage = null;
      continue;
    }
    if (previousMessage && provedMessagePair(previousMessage, message)) {
      const chosen = message.id === window.finalAnswerItemId ? message : previousMessage;
      messageAliases[chosen.id] = [
        ...new Set([...(messageAliases[previousMessage.id] ?? [previousMessage.id]), message.id]),
      ];
      if (message.id === window.finalAnswerItemId) {
        duplicateMessageIds.add(previousMessage.id);
        previousMessage = message;
      } else {
        duplicateMessageIds.add(message.id);
      }
    } else {
      previousMessage = message;
    }
  }
  const visibleMessages = messages.filter((message) => !duplicateMessageIds.has(message.id));
  const outputIds = new Set<string>();
  for (const activity of activities) {
    if (
      activity.kind !== "tool" ||
      activity.presentation?.evidenceKind !== "direct" ||
      activity.callId === null ||
      activityObject(activity.presentation.details)?.["outputRecord"] !== false
    ) {
      continue;
    }
    const candidates = activities.filter(
      (candidate): candidate is ToolActivity =>
        candidate.kind === "tool" &&
        candidate.callId === activity.callId &&
        candidate.presentation?.evidenceKind === "direct",
    );
    if (
      candidates.filter(
        (candidate) => activityObject(candidate.presentation?.details)?.["outputRecord"] === false,
      ).length !== 1
    ) {
      continue;
    }
    const outputs = candidates.filter(
      (candidate) =>
        activityObject(candidate.presentation?.details)?.["outputRecord"] === true &&
        window.items.find((entry) => entry.itemId === candidate.id)?.detail === "full",
    );
    if (
      window.items.find((entry) => entry.itemId === activity.id)?.detail !== "full" ||
      outputs.length === 0
    ) {
      continue;
    }
    const latest = outputs.at(-1)!;
    activity.status = latest.status;
    activity.output = latest.output;
    activity.completedAt = latest.completedAt;
    activity.error = latest.error;
    activity.presentation.status = latest.status;
    activity.presentation.details = {
      call: activity.presentation.details,
      outputs: outputs.map((output) => output.presentation?.details ?? null),
    };
    const inventories = outputs.flatMap((output) => (output.codeMode ? [output.codeMode] : []));
    if (
      inventories.length &&
      new Set(inventories.map((inventory) => inventory.cellId)).size === 1
    ) {
      activity.codeMode = {
        ...inventories[0]!,
        deltas: inventories.flatMap((inventory) => inventory.deltas),
      };
    }
    for (const output of outputs) {
      outputIds.add(output.id);
    }
  }
  const expanded = expandRecordedCells(
    activities.filter((activity) => !outputIds.has(activity.id)),
  );
  for (const activity of expanded) {
    if (
      activity.kind === "tool" &&
      activity.codeMode &&
      (window.coverage.status !== "complete" ||
        window.itemsView !== "full" ||
        window.items.some((entry) => entry.detail !== "full"))
    ) {
      activity.codeMode.loadedCoverage = "partial";
    }
  }
  const expandedOrder: NonNullable<ConversationTurn["entryOrder"]> = [];
  for (const entry of order) {
    if (!outputIds.has(entry.id) && !duplicateMessageIds.has(entry.id)) {
      expandedOrder.push(entry);
    }
    for (const activity of expanded) {
      if (
        activity.presentation?.evidenceKind === "host-attempt" &&
        activityObject(activity.presentation.details)?.["sourceEventId"] === entry.id
      ) {
        expandedOrder.push({ kind: "activity", id: activity.id });
      }
    }
  }
  const user = visibleMessages.find((message) => message.role === "user") ?? null;
  return {
    messageAliases: Object.fromEntries(
      visibleMessages.map((message) => [message.id, messageAliases[message.id] ?? [message.id]]),
    ),
    id: window.turnId,
    sourceTurnId: window.boundary?.sourceTurnId ?? null,
    sessionId,
    index: window.order,
    userMessage: user,
    steeringMessages: visibleMessages.filter(
      (message) => message.role === "user" && message.id !== user?.id,
    ),
    assistantMessages: visibleMessages.filter((message) => message.role === "assistant"),
    activities: expanded,
    entryOrder: expandedOrder,
    finalAssistantMessageId: window.finalAnswerItemId,
    status: window.status,
    startedAt: timestamp(window.startedAt),
    completedAt: timestamp(window.completedAt),
    durationMs: window.durationMs,
    timeToFirstTokenMs: null,
    tokenDelta: null,
    models: window.context?.model ? [window.context.model] : [],
    reasoningEfforts: window.context?.effort ? [window.context.effort] : [],
    toolCounts: {},
    diagnosticIds: [],
  };
}
