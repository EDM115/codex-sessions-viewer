import { resolve } from "node:path";

import type { RolloutRef } from "../../shared/types/conversation.ts";
import { createViewerDiagnostic, type ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import {
  selectPreferredSessionSource,
  type SessionSourceCandidate,
} from "../normalization/metadataMerge.ts";
import type { DiscoveredRolloutSource } from "./discoverSources.ts";
import {
  readStableJsonl,
  type JsonlRecord,
  type ReadStableJsonlOptions,
  type StableJsonlResult,
} from "./jsonlStream.ts";
import { parseRolloutFilename, rolloutRefFromSource } from "./rolloutIdentity.ts";
import {
  CATALOG_METADATA_MAX_BYTES,
  readSessionMetaPrefix,
  observeSessionMetaSource,
  type SessionMetaPrefixResult,
} from "./sessionMetaPrefix.ts";

const DEFAULT_PREFIX_BYTES = 4_096;
const PREFIX_READ_CONCURRENCY = 32;

export interface SelectedSessionSource {
  source: DiscoveredRolloutSource;
  prefix: SessionMetaPrefixResult;
}

export interface SessionSourceSelectionResult {
  selected: SelectedSessionSource[];
  physicalSegments: SelectedSessionSource[];
  historyGraph: RolloutRef[];
  representationChoices: {
    physicalRolloutId: string | null;
    selectedPath: string | null;
    candidates: RolloutRef[];
  }[];
  diagnostics: ViewerDiagnostic[];
  bytesRead: number;
}

export interface SessionSourceSelectionOptions {
  currentRolloutPaths?: ReadonlyMap<string, string>;
  prefixBytes?: number | undefined;
  readPrefix?: typeof readSessionMetaPrefix | undefined;
  readJsonl?:
    | ((path: string, options: ReadStableJsonlOptions) => Promise<StableJsonlResult>)
    | undefined;
}

function filenameSessionId(path: string): string | null {
  return parseRolloutFilename(path)?.stableThreadId ?? null;
}

function candidateSessionId(entry: SelectedSessionSource): string | null {
  return entry.prefix.meta?.id ?? filenameSessionId(entry.source.path);
}

function recordSessionId(records: readonly JsonlRecord[]): string | null {
  for (const { value } of records) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const payload = value["payload"];
    if (
      value["type"] === "session_meta" &&
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      typeof payload["id"] === "string"
    ) {
      return payload["id"];
    }
  }
  return null;
}

async function readPrefixes(
  sources: readonly DiscoveredRolloutSource[],
  options: SessionSourceSelectionOptions,
): Promise<SelectedSessionSource[]> {
  const results: SelectedSessionSource[] = [];
  const readPrefix = options.readPrefix ?? readSessionMetaPrefix;
  for (let index = 0; index < sources.length; index += PREFIX_READ_CONCURRENCY) {
    const batch = sources.slice(index, index + PREFIX_READ_CONCURRENCY);
    // oxlint-disable-next-line no-await-in-loop -- Bounded batches prevent hundreds of simultaneous rollout handles.
    const prefixes = await Promise.all(
      batch.map(async (source): Promise<SelectedSessionSource> => {
        try {
          return {
            source,
            prefix: source.path.endsWith(".jsonl.zst")
              ? {
                  status: "missing" as const,
                  meta: null,
                  parentThreadIdHint: null,
                  bytesRead: 0,
                  observation: await observeSessionMetaSource(source.path),
                  diagnostics: [],
                }
              : await readPrefix(source.path, options.prefixBytes ?? DEFAULT_PREFIX_BYTES, {
                  firstRecordMaxBytes: Math.max(
                    options.prefixBytes ?? DEFAULT_PREFIX_BYTES,
                    CATALOG_METADATA_MAX_BYTES,
                  ),
                }),
          };
        } catch {
          return {
            source,
            prefix: {
              status: "changed",
              meta: null,
              parentThreadIdHint: null,
              bytesRead: 0,
              observation: {
                device: 0n,
                inode: 0n,
                size: 0n,
                mtimeNs: 0n,
                ctimeNs: 0n,
                regular: false,
                symbolicLink: false,
              },
              diagnostics: [
                createViewerDiagnostic({
                  code: "source.changed_during_read",
                  severity: "warning",
                  area: "source",
                  path: source.path,
                  message:
                    "Rollout representation is unavailable during source selection, retaining the last known catalog identity.",
                }),
              ],
            },
          };
        }
      }),
    );
    results.push(...prefixes);
  }
  return results;
}

function candidateFacts(
  entry: SelectedSessionSource,
  sessionId: string,
  result: StableJsonlResult,
): SessionSourceCandidate {
  const stable = result.read.status === "stable";
  return {
    sessionId,
    path: entry.source.path,
    scope: entry.source.scope,
    mtimeMs:
      result.read.status === "stable"
        ? result.read.mtimeMs
        : Number(entry.prefix.observation.mtimeNs) / 1_000_000,
    stable,
    complete:
      stable &&
      result.state.pending.byteLength === 0 &&
      recordSessionId(result.records) === sessionId,
  };
}

export async function selectSessionSources(
  sources: readonly DiscoveredRolloutSource[],
  options: SessionSourceSelectionOptions = {},
): Promise<SessionSourceSelectionResult> {
  const prefixed = await readPrefixes(sources, options);
  const diagnostics = prefixed.flatMap(({ prefix }) => prefix.diagnostics);
  let bytesRead = prefixed.reduce((total, { prefix }) => total + prefix.bytesRead, 0);
  const groups = new Map<string, SelectedSessionSource[]>();
  for (const entry of prefixed) {
    const sessionId = candidateSessionId(entry);
    const physicalId = parseRolloutFilename(entry.source.path)?.physicalRolloutId ?? sessionId;
    const key =
      physicalId === null ? `path:${resolve(entry.source.path)}` : `physical:${physicalId}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  const selected: SelectedSessionSource[] = [];
  const readJsonl = options.readJsonl ?? readStableJsonl;
  for (const representations of groups.values()) {
    const available = representations.filter(
      (entry) =>
        entry.prefix.observation.regular &&
        !entry.prefix.observation.symbolicLink &&
        entry.prefix.status !== "changed",
    );
    const plain = available.filter(
      (entry) => entry.source.path.endsWith(".jsonl") && entry.prefix.status === "found",
    );
    const group = plain.length > 0 ? plain : available;
    if (group.length === 0) {
      continue;
    }
    if (group.length === 1) {
      selected.push(group[0]!);
      continue;
    }
    const sessionId = candidateSessionId(group[0]!);
    if (sessionId === null) {
      selected.push(...group);
      continue;
    }
    const candidates: SessionSourceCandidate[] = [];
    for (const entry of group) {
      if (entry.source.path.endsWith(".jsonl.zst")) {
        candidates.push({
          sessionId,
          path: entry.source.path,
          scope: entry.source.scope,
          mtimeMs: Number(entry.prefix.observation.mtimeNs) / 1_000_000,
          stable: true,
          complete: false,
        });
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- Full stable reads are serialized and limited to rare duplicate groups.
      const result = await readJsonl(entry.source.path, { start: 0 });
      if (result.read.status === "stable") {
        bytesRead += result.read.bytesRead;
      }
      candidates.push(candidateFacts(entry, sessionId, result));
    }
    const preferred = selectPreferredSessionSource(candidates);
    diagnostics.push(...preferred.diagnostics);
    if (preferred.selected !== null) {
      const winner = group.find(({ source }) => source.path === preferred.selected?.path);
      if (winner !== undefined) {
        selected.push(winner);
      }
    }
  }

  const physicalSegments = selected.toSorted((left, right) =>
    left.source.path.localeCompare(right.source.path),
  );
  const historyGraph = physicalSegments.map((entry) =>
    rolloutRefFromSource(entry.source.path, entry.prefix.meta),
  );
  const physicalOwners = new Map(
    historyGraph.map((ref) => [ref.physicalRolloutId, ref.stableThreadId]),
  );
  const bases = new Set(
    historyGraph.flatMap((ref) =>
      ref.historyBase !== null &&
      physicalOwners.get(ref.historyBase.physicalRolloutId) === ref.stableThreadId
        ? [ref.historyBase.physicalRolloutId]
        : [],
    ),
  );
  const leaves = physicalSegments.filter(
    (_, index) => !bases.has(historyGraph[index]!.physicalRolloutId!),
  );
  const logical = new Map<string, SelectedSessionSource>();
  for (const [id, path] of options.currentRolloutPaths ?? []) {
    const physicalId = parseRolloutFilename(path)?.physicalRolloutId;
    const current = physicalSegments.find(
      (entry, index) =>
        historyGraph[index]!.stableThreadId === id &&
        (resolve(entry.source.path) === resolve(path) ||
          (physicalId !== undefined && historyGraph[index]!.physicalRolloutId === physicalId)),
    );
    if (current !== undefined) {
      logical.set(id, current);
    }
  }
  for (const entry of leaves) {
    const id = candidateSessionId(entry) ?? entry.source.path;
    if (options.currentRolloutPaths?.has(id)) {
      continue;
    }
    if (logical.has(id)) {
      diagnostics.push(
        createViewerDiagnostic({
          code: "source.duplicate_session",
          severity: "warning",
          area: "source",
          message:
            "Distinct physical histories share a stable thread ID without a current-rollout reference, all segments remain available in the history graph.",
          path: entry.source.path,
        }),
      );
    } else {
      logical.set(id, entry);
    }
  }
  return {
    selected: [...logical.values()],
    physicalSegments,
    historyGraph,
    representationChoices: [...groups.values()].map((group) => {
      const candidates = group.map((entry) =>
        rolloutRefFromSource(entry.source.path, entry.prefix.meta),
      );
      const physicalRolloutId = candidates[0]!.physicalRolloutId;
      const selectedPath =
        historyGraph.find((ref) => ref.physicalRolloutId === physicalRolloutId)?.sourcePath ?? null;
      return { physicalRolloutId, selectedPath, candidates };
    }),
    diagnostics,
    bytesRead,
  };
}
