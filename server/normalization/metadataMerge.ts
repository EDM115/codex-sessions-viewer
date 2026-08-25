import type { ConversationScope } from "../../shared/types/conversation.ts";
import { createViewerDiagnostic, type ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import type { SessionIndexEntry } from "../metadata/sessionIndex.ts";
import type { StateMetadataSnapshot, StateThreadMetadata } from "../metadata/stateSnapshot.ts";

export interface SessionMetadataMergeInput {
  sessionId: string;
  sourcePath: string;
  scope: ConversationScope;
  firstUserPreview: string;
  rolloutModels: string[];
  rolloutReasoningEfforts: string[];
  rolloutCwd?: string | null | undefined;
  rolloutGitBranch?: string | null | undefined;
  rolloutGitSha?: string | null | undefined;
  rolloutGitOriginUrl?: string | null | undefined;
  rolloutParentThreadId?: string | null | undefined;
  sessionIndexEntries: SessionIndexEntry[];
  stateSnapshot: StateMetadataSnapshot | null;
}

export interface MergedSessionMetadata {
  title: string;
  scope: ConversationScope;
  sourcePath: string;
  cwd: string | null;
  gitBranch: string | null;
  gitSha: string | null;
  gitOriginUrl: string | null;
  models: string[];
  reasoningEfforts: string[];
  pinned: boolean;
  sectionName: string | null;
  parentThreadId: string | null;
  childThreadIds: string[];
}

export interface SessionSourceCandidate {
  sessionId: string;
  path: string;
  scope: ConversationScope;
  mtimeMs: number;
  stable: boolean;
  complete: boolean;
}

export interface PreferredSessionSourceResult {
  selected: SessionSourceCandidate | null;
  diagnostics: ViewerDiagnostic[];
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function snapshotThread(
  stateSnapshot: StateMetadataSnapshot | null,
  sessionId: string,
): StateThreadMetadata | null {
  return stateSnapshot?.threads.find(({ id }) => id === sessionId) ?? null;
}

export function mergeSessionMetadata(input: SessionMetadataMergeInput): MergedSessionMetadata {
  const thread = snapshotThread(input.stateSnapshot, input.sessionId);
  const index = input.sessionIndexEntries
    .filter(({ id }) => id === input.sessionId)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .find(({ threadName }) => nonEmpty(threadName) !== null);
  const sectionName =
    thread?.sectionId === null || thread?.sectionId === undefined
      ? null
      : (input.stateSnapshot?.sections.find(({ id }) => id === thread.sectionId)?.name ?? null);
  const parentThreadId =
    input.stateSnapshot?.spawnEdges.find(({ childThreadId }) => childThreadId === input.sessionId)
      ?.parentThreadId ?? null;
  const childThreadIds =
    input.stateSnapshot?.spawnEdges
      .filter(({ parentThreadId: parent }) => parent === input.sessionId)
      .map(({ childThreadId }) => childThreadId)
      .toSorted() ?? [];
  const rolloutModels = uniqueNonEmpty(input.rolloutModels);
  const rolloutReasoningEfforts = uniqueNonEmpty(input.rolloutReasoningEfforts);

  return {
    title:
      nonEmpty(thread?.name) ??
      nonEmpty(index?.threadName) ??
      nonEmpty(thread?.title) ??
      nonEmpty(input.firstUserPreview) ??
      input.sessionId,
    scope: input.scope,
    sourcePath: input.sourcePath,
    cwd: nonEmpty(input.rolloutCwd) ?? nonEmpty(thread?.cwd),
    gitBranch: nonEmpty(input.rolloutGitBranch) ?? nonEmpty(thread?.gitBranch),
    gitSha: nonEmpty(input.rolloutGitSha) ?? nonEmpty(thread?.gitSha),
    gitOriginUrl: nonEmpty(input.rolloutGitOriginUrl) ?? nonEmpty(thread?.gitOriginUrl),
    models:
      rolloutModels.length > 0
        ? rolloutModels
        : thread?.model === null || thread?.model === undefined
          ? []
          : [thread.model],
    reasoningEfforts:
      rolloutReasoningEfforts.length > 0
        ? rolloutReasoningEfforts
        : thread?.reasoningEffort === null || thread?.reasoningEffort === undefined
          ? []
          : [thread.reasoningEffort],
    pinned: thread?.pinned ?? false,
    sectionName: nonEmpty(sectionName),
    parentThreadId: nonEmpty(input.rolloutParentThreadId) ?? parentThreadId,
    childThreadIds,
  };
}

export function selectPreferredSessionSource(
  candidates: readonly SessionSourceCandidate[],
): PreferredSessionSourceResult {
  if (candidates.length === 0) {
    return { selected: null, diagnostics: [] };
  }
  const sessionId = candidates[0]!.sessionId;
  const eligible = candidates
    .filter(({ stable, complete }) => stable && complete)
    .toSorted(
      (left, right) =>
        right.mtimeMs - left.mtimeMs ||
        normalize(left.path)
          .toLocaleLowerCase()
          .localeCompare(normalize(right.path).toLocaleLowerCase()),
    );
  const selected = eligible[0] ?? null;
  if (candidates.length === 1) {
    return { selected, diagnostics: [] };
  }

  const selectedPath = selected?.path ?? candidates[0]!.path;
  return {
    selected,
    diagnostics: [
      createViewerDiagnostic({
        code: "source.duplicate_session",
        severity: "warning",
        area: "source",
        message:
          selected === null
            ? "Duplicate session sources are still changing and will be reconciled again."
            : "Duplicate session sources were found; the newest stable complete source was selected.",
        path: selectedPath,
        sessionId,
        details: {
          candidateCount: candidates.length,
          selectedPath: selected?.path ?? null,
        },
      }),
    ],
  };
}
import { normalize } from "node:path";
