import { describe, expect, it } from "vitest";

import { useConversationTimeline } from "../../../app/composables/useConversationTimeline.ts";
import type { ConversationTurn } from "../../../shared/types/conversation.ts";
import type { ConversationRepository, TurnChunk } from "../../../shared/types/repository.ts";

function turn(index: number): ConversationTurn {
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
    models: [],
    reasoningEfforts: [],
    toolCounts: {},
    diagnosticIds: [],
  };
}

describe("conversation timeline repository integration", () => {
  it("loads adjacent chunks once and replaces the window for a distant target", async () => {
    const initial: TurnChunk = {
      sessionId: "session-1",
      turns: [turn(20), turn(21)],
      previousCursor: "0",
      nextCursor: "2",
      revision: "revision-1",
    };
    const calls: Array<{ cursor?: string; direction?: "before" | "after"; targetTurnId?: string }> =
      [];
    const chunks: TurnChunk[] = [
      {
        sessionId: "session-1",
        turns: [turn(0), turn(1)],
        previousCursor: null,
        nextCursor: "1",
        revision: "revision-1",
      },
      {
        sessionId: "session-1",
        turns: [turn(40), turn(41)],
        previousCursor: "1",
        nextCursor: null,
        revision: "revision-1",
      },
      {
        sessionId: "session-1",
        turns: [turn(5), turn(6)],
        previousCursor: null,
        nextCursor: "1",
        revision: "revision-1",
      },
    ];
    const repository = {
      getTurns: async (_id: string, query: (typeof calls)[number]) => {
        calls.push(query);
        const chunk = chunks.shift();
        if (chunk === undefined) {
          throw new Error("Unexpected chunk request");
        }
        return chunk;
      },
    } as Pick<ConversationRepository, "getTurns">;
    const timeline = useConversationTimeline({
      sessionId: "session-1",
      repository,
      initialChunk: initial,
    });

    await Promise.all([timeline.loadBefore(), timeline.loadBefore()]);
    await timeline.loadAfter();
    expect(timeline.turns.value.map(({ index }) => index)).toEqual([0, 1, 20, 21, 40, 41]);
    expect(calls).toEqual([
      { cursor: "0", direction: "before", limit: 20 },
      { cursor: "2", direction: "after", limit: 20 },
    ]);

    await timeline.loadTarget("turn-5");
    expect(timeline.turns.value.map(({ index }) => index)).toEqual([5, 6]);
    expect(calls[2]).toEqual({ targetTurnId: "turn-5", limit: 20 });
  });

  it("ignores a stale target response that resolves after a newer selection", async () => {
    const resolvers = new Map<string, (chunk: TurnChunk) => void>();
    const repository = {
      getTurns: async (_id: string, query: { targetTurnId?: string }) =>
        new Promise<TurnChunk>((resolve) => {
          if (query.targetTurnId !== undefined) {
            resolvers.set(query.targetTurnId, resolve);
          }
        }),
    } as Pick<ConversationRepository, "getTurns">;
    const timeline = useConversationTimeline({
      sessionId: "session-1",
      repository,
      initialChunk: {
        sessionId: "session-1",
        turns: [turn(20)],
        previousCursor: "0",
        nextCursor: "2",
        revision: "revision-1",
      },
    });

    const first = timeline.loadTarget("turn-5");
    const second = timeline.loadTarget("turn-40");
    resolvers.get("turn-40")?.({
      sessionId: "session-1",
      turns: [turn(40)],
      previousCursor: "1",
      nextCursor: null,
      revision: "revision-2",
    });
    await second;
    resolvers.get("turn-5")?.({
      sessionId: "session-1",
      turns: [turn(5)],
      previousCursor: null,
      nextCursor: "1",
      revision: "revision-1",
    });
    await first;

    expect(timeline.turns.value.map(({ id }) => id)).toEqual(["turn-40"]);
    expect(timeline.revision.value).toBe("revision-2");
  });

  it("captures a prepend anchor once, immediately before applying a deferred response", async () => {
    let resolveChunk!: (chunk: TurnChunk) => void;
    const repository = {
      getTurns: async () =>
        new Promise<TurnChunk>((resolve) => {
          resolveChunk = resolve;
        }),
    } as Pick<ConversationRepository, "getTurns">;
    const timeline = useConversationTimeline({
      sessionId: "session-1",
      repository,
      initialChunk: {
        sessionId: "session-1",
        turns: [turn(20)],
        previousCursor: "0",
        nextCursor: null,
        revision: "revision-1",
      },
    });
    let simulatedScrollTop = 10;
    const captured: number[] = [];
    const applied: string[] = [];
    const capture = (): void => {
      captured.push(simulatedScrollTop);
    };

    const first = timeline.loadBefore(capture, (chunk) => applied.push(chunk.revision));
    const second = timeline.loadBefore(capture, (chunk) => applied.push(chunk.revision));
    simulatedScrollTop = 35;
    resolveChunk({
      sessionId: "session-1",
      turns: [turn(0)],
      previousCursor: null,
      nextCursor: "1",
      revision: "revision-2",
    });
    await Promise.all([first, second]);

    expect(captured).toEqual([35]);
    expect(applied).toEqual(["revision-2"]);
  });

  it("does not merge a directional response into a superseding target window", async () => {
    let resolveBefore!: (chunk: TurnChunk) => void;
    let resolveTarget!: (chunk: TurnChunk) => void;
    const repository = {
      getTurns: async (_id: string, query: { direction?: "before" | "after" }) =>
        new Promise<TurnChunk>((resolve) => {
          if (query.direction === "before") {
            resolveBefore = resolve;
          } else {
            resolveTarget = resolve;
          }
        }),
    } as Pick<ConversationRepository, "getTurns">;
    const timeline = useConversationTimeline({
      sessionId: "session-1",
      repository,
      initialChunk: {
        sessionId: "session-1",
        turns: [turn(20)],
        previousCursor: "0",
        nextCursor: "2",
        revision: "revision-1",
      },
    });

    const before = timeline.loadBefore();
    const target = timeline.loadTarget("turn-40");
    resolveTarget({
      sessionId: "session-1",
      turns: [turn(40)],
      previousCursor: "1",
      nextCursor: null,
      revision: "revision-3",
    });
    await target;
    resolveBefore({
      sessionId: "session-1",
      turns: [turn(0)],
      previousCursor: null,
      nextCursor: "1",
      revision: "revision-2",
    });
    await before;

    expect(timeline.turns.value.map(({ id }) => id)).toEqual(["turn-40"]);
    expect(timeline.revision.value).toBe("revision-3");
    expect(timeline.canLoadBefore.value).toBe(true);
  });

  it("keeps newer directional data when an older overlapping refresh resolves last", async () => {
    let resolveRefresh!: (chunk: TurnChunk) => void;
    let resolveBefore!: (chunk: TurnChunk) => void;
    const repository = {
      getTurns: async (_id: string, query: { direction?: "before" | "after" }) =>
        new Promise<TurnChunk>((resolve) => {
          if (query.direction === "before") {
            resolveBefore = resolve;
          } else {
            resolveRefresh = resolve;
          }
        }),
    } as Pick<ConversationRepository, "getTurns">;
    const timeline = useConversationTimeline({
      sessionId: "session-1",
      repository,
      initialChunk: {
        sessionId: "session-1",
        turns: [turn(20)],
        previousCursor: "0",
        nextCursor: null,
        revision: "revision-1",
      },
    });

    const refresh = timeline.refresh("turn-20");
    const before = timeline.loadBefore();
    resolveBefore({
      sessionId: "session-1",
      turns: [turn(0), { ...turn(20), models: ["newer-model"] }],
      previousCursor: null,
      nextCursor: "1",
      revision: "revision-3",
    });
    await before;
    resolveRefresh({
      sessionId: "session-1",
      turns: [{ ...turn(20), models: ["older-model"] }],
      previousCursor: "0",
      nextCursor: null,
      revision: "revision-2",
    });
    await refresh;

    expect(timeline.turns.value.find(({ id }) => id === "turn-20")?.models).toEqual([
      "newer-model",
    ]);
    expect(timeline.revision.value).toBe("revision-3");
    expect(timeline.canLoadBefore.value).toBe(false);
  });
});
