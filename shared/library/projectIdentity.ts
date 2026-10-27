import { createHash } from "node:crypto";

import type { CatalogMetadataSnapshot } from "../../server/metadata/catalogMetadata.ts";
import type { CatalogProject, ResolvedThreadMembership } from "../types/library.ts";

export interface ConversationProjectSource {
  cwd: string | null;
  gitOriginUrl: string | null;
}

export interface CodexProjectDefinition {
  id: string;
  name: string;
  rootPaths: string[];
}

export interface ResolvedConversationProject {
  id: string;
  name: string;
  source: "codex" | "git" | "cwd" | "none";
  hint: string | null;
}

interface ProjectRootCandidate {
  project: CodexProjectDefinition;
  rootPath: string;
  comparisonPath: string;
}

function isWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/iu.test(value) || /^[\\/]{2}/u.test(value);
}

function normalizedComparisonPath(value: string): string {
  const windows = isWindowsPath(value);
  const unc = /^[\\/]{2}/u.test(value);
  const normalized = (unc ? "\\" : "") + value.replace(/[\\/]+/gu, windows ? "\\" : "/");
  const rootLength = isWindowsPath(normalized) && /^[a-z]:\\$/iu.test(normalized) ? 3 : 1;
  const trimmed = normalized.length > rootLength ? normalized.replace(/[\\/]+$/gu, "") : normalized;
  return isWindowsPath(trimmed) ? trimmed.toLocaleLowerCase("en-US") : trimmed;
}

export type MembershipMetadataSources = Pick<
  CatalogMetadataSnapshot,
  "threads" | "projects" | "globalState"
>;

export function catalogProjects(metadata: MembershipMetadataSources): CatalogProject[] {
  const projects: CatalogProject[] = metadata.projects.map((project) => ({
    id: project.id,
    name: project.name,
    rootPaths: project.roots
      .toSorted((a, b) => a.position - b.position || a.path.localeCompare(b.path))
      .map((root) => root.path),
    hostId: null,
    source: "native",
    position: project.position ?? null,
    recencyAt: project.updatedAtMs ?? null,
  }));
  const nativeIds = new Set(projects.map((project) => project.id));
  for (const project of metadata.globalState.projects) {
    const destinations = Object.values(
      metadata.globalState.projectIdByLegacyIdByHost ?? {},
    ).flatMap((map) => (map[project.id] ? [map[project.id]!] : []));
    if (nativeIds.has(project.id) || destinations.length) {
      continue;
    }
    projects.push({
      id: project.id,
      name: project.name,
      rootPaths: project.rootPaths,
      hostId: null,
      source: "legacy",
      position: null,
      recencyAt: project.updatedAt ?? null,
    });
  }
  return projects;
}

export function resolveThreadMembership(
  threadId: string,
  metadata: CatalogMetadataSnapshot,
): ResolvedThreadMembership {
  return resolveThreadMembershipFromSources(threadId, metadata);
}

// Compatibility callers supply only metadata fields they actually observed
export function resolveThreadMembershipFromSources(
  threadId: string,
  metadata: MembershipMetadataSources,
): ResolvedThreadMembership {
  const global = metadata.globalState;
  const thread = metadata.threads.find((row) => row.id === threadId);
  const projects = catalogProjects(metadata);
  const nativeIds = new Set(metadata.projects.map((project) => project.id));
  const hostId = global.threadProjectMembershipHostIds?.[threadId] ?? null;
  const result = (
    projectId: string | null,
    source: ResolvedThreadMembership["source"],
    diagnostics: string[] = [],
  ): ResolvedThreadMembership => ({ projectId, source, hostId, diagnostics });
  const workspace = global.workspaceStates?.[threadId];
  if (global.projectlessThreadIds?.includes(threadId) || workspace?.project === null) {
    return result(null, "explicit-projectless");
  }
  const diagnostics: string[] = [];
  if (thread?.projectId) {
    if (nativeIds.has(thread.projectId)) {
      return result(thread.projectId, "native");
    }
    diagnostics.push("dangling-native-project");
  }
  const assignment = global.threadProjectAssignments?.[threadId] ?? workspace?.project;
  if (assignment) {
    const mappings = global.projectIdByLegacyIdByHost ?? {};
    const possible = hostId
      ? [mappings[hostId]?.[assignment.projectId]].filter((id): id is string => !!id)
      : [];
    if (!hostId && Object.values(mappings).some((map) => assignment.projectId in map)) {
      return result(null, "unresolved", [...diagnostics, "unknown-membership-host"]);
    }
    if (possible.length) {
      return nativeIds.has(possible[0]!)
        ? result(possible[0]!, "legacy-assignment", diagnostics)
        : result(null, "unresolved", [...diagnostics, "dangling-legacy-migration"]);
    }
    if (
      assignment.projectKind === "local" &&
      projects.some((project) => project.id === assignment.projectId && project.source === "legacy")
    ) {
      return result(assignment.projectId, "legacy-assignment", diagnostics);
    }
    return result(null, "unresolved", [...diagnostics, "dangling-legacy-assignment"]);
  }
  if (diagnostics.length) {
    return result(null, "unresolved", diagnostics);
  }
  const cwd = thread?.cwd ?? workspace?.applied?.cwd;
  if (!cwd) {
    return result(null, "none");
  }
  const comparison = normalizedComparisonPath(cwd);
  const matches = global.projects
    .flatMap((project) =>
      project.rootPaths.flatMap((root) => {
        const path = normalizedComparisonPath(root);
        return isPathWithin(comparison, path) ? [{ project, length: path.length }] : [];
      }),
    )
    .toSorted((a, b) => b.length - a.length);
  const longest = matches.filter((match) => match.length === matches[0]?.length);
  const ids = [...new Set(longest.map((match) => match.project.id))];
  if (ids.length > 1) {
    return result(null, "unresolved", ["ambiguous-legacy-root"]);
  }
  if (ids.length === 1) {
    const legacyId = ids[0]!;
    const mapped = hostId ? global.projectIdByLegacyIdByHost?.[hostId]?.[legacyId] : undefined;
    if (mapped) {
      return nativeIds.has(mapped)
        ? result(mapped, "legacy-root")
        : result(null, "unresolved", ["dangling-legacy-migration"]);
    }
    if (projects.some((project) => project.id === legacyId && project.source === "legacy")) {
      return result(legacyId, "legacy-root");
    }
    return result(null, "unresolved", ["unknown-membership-host"]);
  }
  return result(null, "none");
}

// Explicit adapter for older summary/repository consumers, synthetic Git/cwd groups stay opt-in
export function membershipProject(
  membership: ResolvedThreadMembership,
  projects: readonly CatalogProject[],
): ResolvedConversationProject {
  const project = projects.find((candidate) => candidate.id === membership.projectId);
  return project
    ? { id: project.id, name: project.name, source: "codex", hint: project.rootPaths[0] ?? null }
    : { id: "none", name: "Recents", source: "none", hint: null };
}

function isPathWithin(candidate: string, root: string): boolean {
  if (candidate === root) {
    return true;
  }
  const separator = isWindowsPath(root) ? "\\" : "/";
  return candidate.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);
}

function stableFallbackId(source: "git" | "cwd", value: string): string {
  return `${source}:${createHash("sha256").update(value).digest("hex")}`;
}

function portableBasename(value: string): string {
  const normalized = value.replace(/[\\/]+$/gu, "");
  return normalized.split(/[\\/]/u).at(-1) || normalized;
}

function gitProjectName(origin: string): string {
  return portableBasename(origin).replace(/\.git$/iu, "") || "Git project";
}

export function resolveConversationProject(
  source: ConversationProjectSource,
  projects: readonly CodexProjectDefinition[],
): ResolvedConversationProject {
  const cwdComparison = source.cwd ? normalizedComparisonPath(source.cwd) : null;
  const candidates: ProjectRootCandidate[] = [];

  if (cwdComparison) {
    for (const project of projects) {
      for (const rootPath of project.rootPaths) {
        const comparisonPath = normalizedComparisonPath(rootPath);
        if (isPathWithin(cwdComparison, comparisonPath)) {
          candidates.push({ project, rootPath, comparisonPath });
        }
      }
    }
  }

  const match = candidates.toSorted(
    (left, right) =>
      right.comparisonPath.length - left.comparisonPath.length ||
      left.project.id.localeCompare(right.project.id),
  )[0];
  if (match) {
    return {
      id: `codex:${match.project.id}`,
      name: match.project.name,
      source: "codex",
      hint: match.rootPath,
    };
  }

  if (source.gitOriginUrl) {
    return {
      id: stableFallbackId("git", source.gitOriginUrl),
      name: gitProjectName(source.gitOriginUrl),
      source: "git",
      hint: source.gitOriginUrl,
    };
  }

  if (source.cwd) {
    return {
      id: stableFallbackId("cwd", normalizedComparisonPath(source.cwd)),
      name: portableBasename(source.cwd) || "Working directory",
      source: "cwd",
      hint: source.cwd,
    };
  }

  return { id: "none", name: "No project", source: "none", hint: null };
}
