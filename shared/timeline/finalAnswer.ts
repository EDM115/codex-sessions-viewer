import type { ConversationMessage, ConversationTurn } from "#shared/types/conversation.ts";

export function isFinalAnswerPhase(phase: string | null): boolean {
  return phase === "final" || phase === "final_answer";
}

export function isFinalAnswerEligible(
  phase: string | null,
  messageText: string,
  completionText: string | null,
): boolean {
  return (
    isFinalAnswerPhase(phase) ||
    (phase === null &&
      completionText !== null &&
      completionText.trim() !== "" &&
      messageText === completionText)
  );
}

/** Only a final phase or the supplied completion text can qualify an assistant answer */
export function selectFinalAssistantMessageId(
  messages: readonly ConversationMessage[],
  completionText: string | null = null,
): string | null {
  const explicit = messages.findLast((message) => isFinalAnswerPhase(message.phase));
  if (explicit) {
    return explicit.id;
  }
  if (completionText === null || completionText.trim() === "") {
    return null;
  }
  return (
    messages.findLast((message) =>
      isFinalAnswerEligible(message.phase, message.sourceMarkdown, completionText),
    )?.id ?? null
  );
}

export function finalAssistantId(turn: ConversationTurn): string | null {
  return turn.finalAssistantMessageId === undefined
    ? selectFinalAssistantMessageId(turn.assistantMessages)
    : turn.finalAssistantMessageId;
}
