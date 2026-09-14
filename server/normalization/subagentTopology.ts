import {
  jsonValueSchema,
  type JsonValue,
  type SubagentActivity,
} from "../../shared/types/conversation.ts";

export interface SessionStructure {
  kind: "root" | "subagent" | "auxiliary";
  parentThreadId: string | null;
  agentPath: string | null;
  agentNickname: string | null;
  agentDepth: number | null;
}

function record(value: JsonValue | null | undefined): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function text(recordValue: Record<string, JsonValue> | null, key: string): string | null {
  const value = recordValue?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Rollout declarations outrank optional state. Fork lineage is not a delegated-child edge. */
export function classifySessionStructure(options: {
  source: JsonValue | null;
  parentThreadId?: string | null | undefined;
  threadModel?: string | null | undefined;
  fallbackSource?: string | null | undefined;
  parentThreadIdHint?: string | null | undefined;
}): SessionStructure {
  let source = options.source;
  if (source === null && options.fallbackSource) {
    try {
      const parsed = jsonValueSchema.safeParse(JSON.parse(options.fallbackSource));
      source = parsed.success ? parsed.data : null;
    } catch {
      // Optional SQLite source strings may be legacy plain text or incomplete.
    }
  }
  const subagent = record(record(source)?.["subagent"]);
  const spawn = record(subagent?.["thread_spawn"]);
  const parent =
    options.parentThreadId ?? text(spawn, "parent_thread_id") ?? text(subagent, "parent_thread_id");
  if (text(subagent, "other") === "guardian" || options.threadModel === "codex-auto-review") {
    return {
      kind: "auxiliary",
      parentThreadId: parent ?? options.parentThreadIdHint ?? null,
      agentPath: null,
      agentNickname: null,
      agentDepth: null,
    };
  }
  const depth = spawn?.["depth"];
  return {
    kind: spawn !== null || parent !== null ? "subagent" : "root",
    parentThreadId: parent,
    agentPath: text(spawn, "agent_path"),
    agentNickname: text(spawn, "agent_nickname"),
    agentDepth:
      typeof depth === "number" && Number.isSafeInteger(depth) && depth >= 0 ? depth : null,
  };
}

export interface SubagentTopologyNode {
  id: string;
  parentThreadId: string | null;
  agentPath: string | null;
  agentNickname: string | null;
}

export interface ResolvedSubagentTopologyNode extends SubagentTopologyNode {
  ancestorIds: string[];
  cycle: boolean;
  depth: number;
}

export function resolveSubagentTopology(
  nodes: readonly SubagentTopologyNode[],
): Map<string, ResolvedSubagentTopologyNode> {
  const source = new Map(nodes.map((node) => [node.id, node]));
  const resolved = new Map<string, ResolvedSubagentTopologyNode>();
  for (const node of nodes) {
    const ancestors: string[] = [];
    const seen = new Set([node.id]);
    let parentId = node.parentThreadId;
    let cycle = false;
    while (parentId !== null) {
      if (seen.has(parentId)) {
        cycle = true;
        break;
      }
      seen.add(parentId);
      ancestors.unshift(parentId);
      parentId = source.get(parentId)?.parentThreadId ?? null;
    }
    resolved.set(node.id, {
      ...node,
      ancestorIds: cycle ? [] : ancestors,
      cycle,
      depth: cycle ? 0 : ancestors.length,
    });
  }
  return resolved;
}

export function enrichSubagentActivities(
  activities: readonly SubagentActivity[],
  nodes: readonly SubagentTopologyNode[],
): number {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byPath = new Map<string, SubagentTopologyNode[]>();
  for (const node of nodes) {
    if (node.agentPath !== null) {
      byPath.set(node.agentPath, [...(byPath.get(node.agentPath) ?? []), node]);
    }
  }
  let enriched = 0;
  for (const activity of activities) {
    const explicit = activity.childThreadId === null ? null : byId.get(activity.childThreadId);
    const pathCandidates = activity.agentId === null ? [] : (byPath.get(activity.agentId) ?? []);
    const node = explicit ?? (pathCandidates.length === 1 ? pathCandidates[0] : undefined);
    if (node === undefined || node === null) {
      continue;
    }
    activity.childThreadId = node.id;
    activity.parentThreadId = node.parentThreadId;
    if (node.agentNickname !== null && !activity.description.includes(node.agentNickname)) {
      activity.description = `${node.agentNickname} · ${activity.description}`;
    }
    enriched += 1;
  }
  return enriched;
}
