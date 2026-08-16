import type { SubagentActivity } from "../../shared/types/conversation.ts";

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
