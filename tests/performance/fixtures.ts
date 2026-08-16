import type { NormalizedSession } from "../../server/normalization/normalizeSession.ts";
import type {
  ConversationActivity,
  ConversationMessage,
  ConversationTurn,
} from "../../shared/types/conversation.ts";

function scaledMessage(
  message: ConversationMessage,
  turnId: string,
  role: "user" | "assistant",
  turnIndex: number,
  messageIndex: number,
): ConversationMessage {
  return {
    ...message,
    id: `scale-${role}-${turnIndex}-${messageIndex}`,
    turnId,
    rawEventIds: [],
  };
}

function scaledActivity(
  activity: ConversationActivity,
  turnId: string,
  turnIndex: number,
  activityIndex: number,
): ConversationActivity {
  return {
    ...activity,
    id: `scale-activity-${turnIndex}-${activityIndex}`,
    turnId,
    rawEventIds: [],
  };
}

function scaledTurn(source: ConversationTurn, sessionId: string, index: number): ConversationTurn {
  const id = `scale-turn-${index}`;
  const userMessage =
    source.userMessage === null ? null : scaledMessage(source.userMessage, id, "user", index, 0);
  const assistantMessages = source.assistantMessages.map((message, messageIndex) =>
    scaledMessage(message, id, "assistant", index, messageIndex),
  );
  const activities = source.activities.map((activity, activityIndex) =>
    scaledActivity(activity, id, index, activityIndex),
  );
  const ids = new Map<string, string>();
  if (source.userMessage !== null && userMessage !== null) {
    ids.set(source.userMessage.id, userMessage.id);
  }
  source.assistantMessages.forEach((message, messageIndex) =>
    ids.set(message.id, assistantMessages[messageIndex]!.id),
  );
  source.activities.forEach((activity, activityIndex) =>
    ids.set(activity.id, activities[activityIndex]!.id),
  );
  return {
    ...source,
    id,
    sourceTurnId: `source-scale-turn-${index}`,
    sessionId,
    index,
    userMessage,
    assistantMessages,
    activities,
    entryOrder: source.entryOrder?.map((entry) => ({ ...entry, id: ids.get(entry.id)! })),
    finalAssistantMessageId:
      source.finalAssistantMessageId === null || source.finalAssistantMessageId === undefined
        ? source.finalAssistantMessageId
        : ids.get(source.finalAssistantMessageId),
    diagnosticIds: [],
  };
}

export function representativeLargeSession(
  source: NormalizedSession,
  turnCount = 500,
): NormalizedSession {
  if (source.turns.length === 0) {
    throw new Error("The representative scale fixture requires at least one source turn.");
  }
  const turns = Array.from({ length: turnCount }, (_, index) =>
    scaledTurn(source.turns[index % source.turns.length]!, source.summary.id, index),
  );
  return {
    summary: {
      ...source.summary,
      title: `Representative ${turnCount}-turn conversation`,
      turnCount,
      assistantMessageCount: turns.reduce(
        (count, turn) => count + turn.assistantMessages.length,
        0,
      ),
      toolCallCount: turns.reduce(
        (count, turn) => count + turn.activities.filter(({ kind }) => kind === "tool").length,
        0,
      ),
      diagnosticCount: 0,
      revision: `sha256:representative-${turnCount}`,
    },
    turns,
    rawEvents: [],
  };
}
