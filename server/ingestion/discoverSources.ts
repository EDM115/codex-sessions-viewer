import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  ConversationActivity,
  ConversationScope,
  MediaActivity,
  MediaReference,
} from "../../shared/types/conversation.ts";
import { createViewerDiagnostic, type ViewerDiagnostic } from "../../shared/types/diagnostics.ts";

export interface DiscoveredRolloutSource {
  path: string;
  scope: ConversationScope;
}

export interface DiscoveredMetadataSources {
  sessionIndex: string | null;
  globalState: string | null;
  stateDatabase: string | null;
  stateWal: string | null;
  legacyStateDatabase?: string;
  legacyStateWal?: string;
}

export interface SourceDiscoveryResult {
  rollouts: DiscoveredRolloutSource[];
  metadata: DiscoveredMetadataSources;
  diagnostics: ViewerDiagnostic[];
}

export interface ReferencedMediaSource {
  assetId: string;
  mediaType: MediaActivity["mediaType"];
  reference: Exclude<MediaReference, { kind: "asset" }>;
}

interface RolloutDiscoveryResult {
  rollouts: DiscoveredRolloutSource[];
  diagnostics: ViewerDiagnostic[];
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function unreadableSource(path: string): ViewerDiagnostic {
  return createViewerDiagnostic({
    code: "codex_home.unreadable",
    severity: "warning",
    area: "source",
    message: "A Codex source path could not be read.",
    path,
  });
}

async function discoverRollouts(
  directory: string,
  scope: ConversationScope,
): Promise<RolloutDiscoveryResult> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    return isMissing(error)
      ? { rollouts: [], diagnostics: [] }
      : { rollouts: [], diagnostics: [unreadableSource(directory)] };
  }

  const discovered = await Promise.all(
    entries.map(async (entry): Promise<RolloutDiscoveryResult> => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return discoverRollouts(path, scope);
      }

      if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst"))) {
        return { rollouts: [{ path, scope }], diagnostics: [] };
      }

      return { rollouts: [], diagnostics: [] };
    }),
  );

  return {
    rollouts: discovered.flatMap(({ rollouts }) => rollouts),
    diagnostics: discovered.flatMap(({ diagnostics }) => diagnostics),
  };
}

async function discoverMetadataFile(
  path: string,
): Promise<{ path: string | null; diagnostic: ViewerDiagnostic | null }> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink()
      ? { path, diagnostic: null }
      : { path: null, diagnostic: null };
  } catch (error) {
    return isMissing(error)
      ? { path: null, diagnostic: null }
      : { path: null, diagnostic: unreadableSource(path) };
  }
}

export async function discoverMetadataSources(
  codexHome: string,
): Promise<Pick<SourceDiscoveryResult, "metadata" | "diagnostics">> {
  const paths: [keyof DiscoveredMetadataSources, string][] = [
    ["sessionIndex", join(codexHome, "session_index.jsonl")],
    ["globalState", join(codexHome, ".codex-global-state.json")],
    ["stateDatabase", join(codexHome, "state_5.sqlite")],
    ["stateWal", join(codexHome, "state_5.sqlite-wal")],
    ["legacyStateDatabase", join(codexHome, "sqlite", "state_5.sqlite")],
    ["legacyStateWal", join(codexHome, "sqlite", "state_5.sqlite-wal")],
  ];
  const files = await Promise.all(
    paths.map(async ([key, path]) => Object.assign({ key }, await discoverMetadataFile(path))),
  );
  const metadata: DiscoveredMetadataSources = {
    sessionIndex: null,
    globalState: null,
    stateDatabase: null,
    stateWal: null,
  };
  for (const file of files) {
    if (file.key === "legacyStateDatabase" || file.key === "legacyStateWal") {
      if (file.path) {
        metadata[file.key] = file.path;
      }
    } else {
      metadata[file.key] = file.path;
    }
  }
  return {
    metadata,
    diagnostics: files.flatMap((file) => (file.diagnostic ? [file.diagnostic] : [])),
  };
}

export async function discoverSources(codexHome: string): Promise<SourceDiscoveryResult> {
  const [active, archived, metadata] = await Promise.all([
    discoverRollouts(join(codexHome, "sessions"), "active"),
    discoverRollouts(join(codexHome, "archived_sessions"), "archived"),
    discoverMetadataSources(codexHome),
  ]);
  return {
    rollouts: [...active.rollouts, ...archived.rollouts].toSorted((left, right) =>
      left.path.localeCompare(right.path),
    ),
    metadata: metadata.metadata,
    diagnostics: [...active.diagnostics, ...archived.diagnostics, ...metadata.diagnostics],
  };
}
export function discoverReferencedMedia(
  activities: Iterable<ConversationActivity>,
): ReferencedMediaSource[] {
  const references: ReferencedMediaSource[] = [];

  for (const activity of activities) {
    if (activity.kind !== "media" || activity.reference.kind === "asset") {
      continue;
    }

    references.push({
      assetId: activity.assetId,
      mediaType: activity.mediaType,
      reference: activity.reference,
    });
  }

  return references;
}
