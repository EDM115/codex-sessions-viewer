import { describe, expect, it } from "vitest";

import {
  mergeConversationTurns,
  recentChunkCursor,
} from "../../../shared/timeline/conversation.ts";
import type { ConversationTurn } from "../../../shared/types/conversation.ts";

function turn(index: number, revision = "initial"): ConversationTurn {
  return {
    id: `turn-${index}`,
    sourceTurnId: `source-${index}`,
    sessionId: "session-1",
    index,
    userMessage: null,
    assistantMessages: [],
    activities: [],
    startedAt: null,
    completedAt: null,
    durationMs: null,
    timeToFirstTokenMs: null,
    tokenDelta: null,
    models: [revision],
    reasoningEfforts: [],
    toolCounts: {},
    diagnosticIds: [],
  };
}

describe("conversation timeline state", () => {
  it("selects the final chunk for a recent-first view", () => {
    expect(recentChunkCursor(0)).toBe("0");
    expect(recentChunkCursor(20)).toBe("0");
    expect(recentChunkCursor(21)).toBe("1");
    expect(recentChunkCursor(61, 20)).toBe("3");
  });

  it("merges immutable chunks by turn id, replaces revisions, and sorts by index", () => {
    const original = [turn(20), turn(21)];
    const replacement = turn(20, "refreshed");
    const merged = mergeConversationTurns(original, [turn(19), replacement]);

    expect(merged.map(({ index }) => index)).toEqual([19, 20, 21]);
    expect(merged[1]?.models).toEqual(["refreshed"]);
    expect(original[0]?.models).toEqual(["initial"]);
    expect(merged).not.toBe(original);
  });
});
