import { describe, expect, it } from "vitest";

import {
  classifySessionStructure,
  enrichSubagentActivities,
  resolveSubagentTopology,
} from "../../../server/normalization/subagentTopology.ts";
import type { SubagentActivity } from "../../../shared/types/conversation.ts";

function activity(overrides: Partial<SubagentActivity> = {}): SubagentActivity {
  return {
    id: "agent-activity",
    turnId: "turn-1",
    createdAt: null,
    rawEventIds: [],
    kind: "subagent",
    status: "running",
    agentId: "/root/review/research",
    parentThreadId: null,
    childThreadId: null,
    description: "Subagent started",
    ...overrides,
  };
}

describe("subagent topology", () => {
  it("keeps rollout parent authority, treats SQLite source as optional fallback and does not guess from bare hints", () => {
    const fallbackSource = JSON.stringify({
      subagent: { thread_spawn: { parent_thread_id: "stale-parent", agent_path: "/root/stale" } },
    });
    expect(classifySessionStructure({ source: null, fallbackSource })).toMatchObject({
      kind: "subagent",
      parentThreadId: "stale-parent",
    });
    expect(
      classifySessionStructure({
        source: { subagent: { thread_spawn: { parent_thread_id: "nested-parent" } } },
        parentThreadId: "rollout-parent",
        fallbackSource,
      }),
    ).toMatchObject({ kind: "subagent", parentThreadId: "rollout-parent" });
    expect(classifySessionStructure({ source: "cli", fallbackSource })).toMatchObject({
      kind: "root",
      parentThreadId: null,
    });
    expect(
      classifySessionStructure({ source: null, parentThreadIdHint: "hint-only" }),
    ).toMatchObject({ kind: "root", parentThreadId: null });
    expect(
      classifySessionStructure({
        source: null,
        parentThreadIdHint: "hint-only",
        threadModel: "codex-auto-review",
      }),
    ).toMatchObject({ kind: "auxiliary", parentThreadId: "hint-only" });
    expect(
      classifySessionStructure({
        source: null,
        fallbackSource: JSON.stringify({ subagent: { other: "guardian" } }),
      }),
    ).toMatchObject({ kind: "auxiliary" });
  });

  it("resolves nested ancestry and rejects cyclic breadcrumb chains", () => {
    const topology = resolveSubagentTopology([
      { id: "root", parentThreadId: null, agentPath: "/root", agentNickname: null },
      { id: "child", parentThreadId: "root", agentPath: "/root/review", agentNickname: "Fermat" },
      {
        id: "grandchild",
        parentThreadId: "child",
        agentPath: "/root/review/research",
        agentNickname: "Noether",
      },
      { id: "cycle-a", parentThreadId: "cycle-b", agentPath: null, agentNickname: null },
      { id: "cycle-b", parentThreadId: "cycle-a", agentPath: null, agentNickname: null },
    ]);

    expect(topology.get("grandchild")).toMatchObject({
      ancestorIds: ["root", "child"],
      depth: 2,
      cycle: false,
    });
    expect(topology.get("cycle-a")).toMatchObject({ ancestorIds: [], depth: 0, cycle: true });
  });

  it("links path-only started and updated activities to one child conversation", () => {
    const nodes = [
      {
        id: "grandchild",
        parentThreadId: "child",
        agentPath: "/root/review/research",
        agentNickname: "Noether",
      },
    ];
    const started = activity();
    const updated = activity({
      id: "agent-update",
      status: "succeeded",
      description: "Subagent completed",
    });

    expect(enrichSubagentActivities([started, updated], nodes)).toBe(2);
    expect(started).toMatchObject({
      parentThreadId: "child",
      childThreadId: "grandchild",
      description: "Noether · Subagent started",
    });
    expect(updated).toMatchObject({ childThreadId: "grandchild", status: "succeeded" });

    const ambiguous = activity();
    const explicit = activity({ childThreadId: "grandchild" });
    const reusedPath = [
      {
        ...nodes[0]!,
        id: "unrelated-child",
        parentThreadId: "unrelated-parent",
        agentNickname: "Other",
      },
      ...nodes,
    ];
    enrichSubagentActivities([ambiguous, explicit], reusedPath);
    expect(ambiguous).toMatchObject({
      childThreadId: null,
      parentThreadId: null,
      description: "Subagent started",
    });
    expect(explicit).toMatchObject({
      childThreadId: "grandchild",
      parentThreadId: "child",
      description: "Noether · Subagent started",
    });
  });
});
