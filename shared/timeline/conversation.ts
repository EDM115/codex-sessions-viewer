import type { ConversationTurn } from "../types/conversation.ts";

export const CONVERSATION_CHUNK_SIZE = 20;

export function recentChunkCursor(turnCount: number, chunkSize = CONVERSATION_CHUNK_SIZE): string {
  return String(Math.max(0, Math.ceil(turnCount / chunkSize) - 1));
}

export function mergeConversationTurns(
  current: readonly ConversationTurn[],
  incoming: readonly ConversationTurn[],
): ConversationTurn[] {
  const turns = new Map(current.map((turn) => [turn.id, turn]));
  for (const turn of incoming) {
    turns.set(turn.id, turn);
  }
  return [...turns.values()].toSorted(
    (left, right) => left.index - right.index || left.id.localeCompare(right.id),
  );
}
