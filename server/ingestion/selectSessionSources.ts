import { basename, extname, resolve } from "node:path";

import type { ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
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
import {
  CATALOG_METADATA_MAX_BYTES,
  readSessionMetaPrefix,
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
  diagnostics: ViewerDiagnostic[];
  bytesRead: number;
}

export interface SessionSourceSelectionOptions {
  prefixBytes?: number | undefined;
  readPrefix?: typeof readSessionMetaPrefix | undefined;
  readJsonl?:
    | ((path: string, options: ReadStableJsonlOptions) => Promise<StableJsonlResult>)
    | undefined;
}

function filenameSessionId(path: string): string | null {
  const name = basename(path, extname(path));
  return (
    name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu)?.[0] ??
    null
  );
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
      batch.map(async (source) => ({
        source,
        prefix: await readPrefix(source.path, options.prefixBytes ?? DEFAULT_PREFIX_BYTES, {
          firstRecordMaxBytes: Math.max(
            options.prefixBytes ?? DEFAULT_PREFIX_BYTES,
            CATALOG_METADATA_MAX_BYTES,
          ),
        }),
      })),
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
    const key = sessionId === null ? `path:${resolve(entry.source.path)}` : `session:${sessionId}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  const selected: SelectedSessionSource[] = [];
  const readJsonl = options.readJsonl ?? readStableJsonl;
  for (const group of groups.values()) {
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

  return {
    selected: selected.toSorted((left, right) => left.source.path.localeCompare(right.source.path)),
    diagnostics,
    bytesRead,
  };
}
