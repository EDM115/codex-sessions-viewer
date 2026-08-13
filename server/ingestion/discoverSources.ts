import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  ConversationActivity,
  ConversationScope,
  MediaActivity,
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
}

export interface SourceDiscoveryResult {
  rollouts: DiscoveredRolloutSource[];
  metadata: DiscoveredMetadataSources;
  diagnostics: ViewerDiagnostic[];
}

export interface ReferencedLocalMediaSource {
  assetId: string;
  mediaType: MediaActivity["mediaType"];
  path: string;
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

      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
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

export async function discoverSources(codexHome: string): Promise<SourceDiscoveryResult> {
  const metadataPaths = {
    sessionIndex: join(codexHome, "session_index.jsonl"),
    globalState: join(codexHome, ".codex-global-state.json"),
    stateDatabase: join(codexHome, "state_5.sqlite"),
    stateWal: join(codexHome, "state_5.sqlite-wal"),
  };
  const [active, archived, sessionIndex, globalState, stateDatabase, stateWal] = await Promise.all([
    discoverRollouts(join(codexHome, "sessions"), "active"),
    discoverRollouts(join(codexHome, "archived_sessions"), "archived"),
    discoverMetadataFile(metadataPaths.sessionIndex),
    discoverMetadataFile(metadataPaths.globalState),
    discoverMetadataFile(metadataPaths.stateDatabase),
    discoverMetadataFile(metadataPaths.stateWal),
  ]);

  return {
    rollouts: [...active.rollouts, ...archived.rollouts].toSorted((left, right) =>
      left.path.localeCompare(right.path),
    ),
    metadata: {
      sessionIndex: sessionIndex.path,
      globalState: globalState.path,
      stateDatabase: stateDatabase.path,
      stateWal: stateWal.path,
    },
    diagnostics: [
      ...active.diagnostics,
      ...archived.diagnostics,
      sessionIndex.diagnostic,
      globalState.diagnostic,
      stateDatabase.diagnostic,
      stateWal.diagnostic,
    ].filter((diagnostic): diagnostic is ViewerDiagnostic => diagnostic !== null),
  };
}

export function discoverReferencedLocalMedia(
  activities: Iterable<ConversationActivity>,
): ReferencedLocalMediaSource[] {
  const references: ReferencedLocalMediaSource[] = [];

  for (const activity of activities) {
    if (activity.kind !== "media" || !activity.sourcePath) {
      continue;
    }

    references.push({
      assetId: activity.assetId,
      mediaType: activity.mediaType,
      path: activity.sourcePath,
    });
  }

  return references;
}
