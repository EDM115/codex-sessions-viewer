import { createHash } from "node:crypto";

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
  return /^[a-z]:[\\/]/iu.test(value) || value.startsWith("\\\\");
}

function normalizedComparisonPath(value: string): string {
  const normalized = value.replace(/[\\/]+/gu, isWindowsPath(value) ? "\\" : "/");
  const rootLength = isWindowsPath(normalized) && /^[a-z]:\\$/iu.test(normalized) ? 3 : 1;
  const trimmed = normalized.length > rootLength ? normalized.replace(/[\\/]+$/gu, "") : normalized;
  return isWindowsPath(trimmed) ? trimmed.toLocaleLowerCase("en-US") : trimmed;
}

function isPathWithin(candidate: string, root: string): boolean {
  if (candidate === root) {
    return true;
  }
  const separator = isWindowsPath(root) ? "\\" : "/";
  return candidate.startsWith(`${root}${separator}`);
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
