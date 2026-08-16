import { describe, expect, it } from "vitest";

import {
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
  });
});
