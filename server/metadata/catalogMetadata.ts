import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { createViewerDiagnostic, type ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import {
  discoverMetadataSources,
  type DiscoveredMetadataSources,
} from "../ingestion/discoverSources.ts";
import { readGlobalState, type GlobalStateMetadata } from "./globalState.ts";
import type {
  SchemaCapabilities,
  StateAttachmentMetadata,
  StateProjectMetadata,
  StateReadReceiptMetadata,
  StateSectionMetadata,
  StateSpawnEdgeMetadata,
  StateThreadMetadata,
} from "./schemaCapabilities.ts";
import { readSessionIndex, type SessionIndexEntry } from "./sessionIndex.ts";
import { snapshotStateDatabase } from "./stateSnapshot.ts";

export interface CatalogMetadataSnapshot {
  codexHome: string;
  sources: DiscoveredMetadataSources;
  stateAuthority: "root" | "legacy" | "unavailable";
  threads: StateThreadMetadata[];
  threadsComplete: boolean;
  projects: StateProjectMetadata[];
  sections: StateSectionMetadata[];
  spawnEdges: StateSpawnEdgeMetadata[];
  attachments: StateAttachmentMetadata[];
  readReceipts: StateReadReceiptMetadata[];
  globalState: GlobalStateMetadata;
  sessionIndex: SessionIndexEntry[];
  capabilities: SchemaCapabilities | null;
  generations: { state: string | null; globalState: string | null; sessionIndex: string | null };
  freshness: {
    state: "fresh" | "retained" | "unavailable";
    globalState: "fresh" | "partial" | "unavailable";
    sessionIndex: "fresh" | "partial" | "unavailable";
    observedAt: string;
  };
  diagnostics: ViewerDiagnostic[];
}

export async function readCatalogMetadata(
  codexHome: string,
  snapshotRoot: string,
  signal?: AbortSignal,
): Promise<CatalogMetadataSnapshot> {
  signal?.throwIfAborted();
  const discovery = await discoverMetadataSources(codexHome);
  signal?.throwIfAborted();
  const { metadata: sources } = discovery;
  const diagnostics = [...discovery.diagnostics];
  const homePath = resolve(codexHome);
  const homeIdentity = createHash("sha256")
    .update(process.platform === "win32" ? homePath.toLowerCase() : homePath)
    .digest("hex");
  const stateRoot = join(snapshotRoot, "state", homeIdentity);
  let originatingAuthority: "root" | "legacy" = "root";
  let stateDatabase = join(codexHome, "state_5.sqlite");
  let state = await snapshotStateDatabase({
    sourceDatabase: stateDatabase,
    sourceWal: `${stateDatabase}-wal`,
    snapshotRoot: join(stateRoot, originatingAuthority),
  });
  signal?.throwIfAborted();
  if (state.status === "unavailable" && !sources.stateDatabase) {
    originatingAuthority = "legacy";
    stateDatabase = join(codexHome, "sqlite", "state_5.sqlite");
    state = await snapshotStateDatabase({
      sourceDatabase: stateDatabase,
      sourceWal: `${stateDatabase}-wal`,
      snapshotRoot: join(stateRoot, originatingAuthority),
    });
  }
  const stateAuthority = state.status === "unavailable" ? "unavailable" : originatingAuthority;
  signal?.throwIfAborted();
  if (sources.stateDatabase || sources.legacyStateDatabase || state.status === "retained") {
    diagnostics.push(...state.diagnostics);
  }
  async function optionalRead<T>(
    path: string | null,
    reader: (path: string) => Promise<T>,
  ): Promise<T | null> {
    if (!path) {
      return null;
    }
    try {
      return await reader(path);
    } catch {
      diagnostics.push(
        createViewerDiagnostic({
          code: "metadata.snapshot_invalid",
          severity: "warning",
          area: "metadata",
          message: "Optional Codex metadata could not be read.",
          path,
        }),
      );
      return null;
    }
  }
  const [global, index] = await Promise.all([
    optionalRead(sources.globalState, readGlobalState),
    optionalRead(sources.sessionIndex, readSessionIndex),
  ]);
  signal?.throwIfAborted();
  diagnostics.push(...(global?.diagnostics ?? []), ...(index?.diagnostics ?? []));
  for (const detail of state.metadata?.capabilities?.diagnostics ?? []) {
    diagnostics.push(
      createViewerDiagnostic({
        code: "metadata.snapshot_invalid",
        severity: "warning",
        area: "metadata",
        message: "Optional native metadata is unavailable or unsupported.",
        ...(stateDatabase ? { path: stateDatabase } : {}),
        details: { ...detail },
      }),
    );
  }
  return {
    codexHome: homePath,
    sources,
    stateAuthority,
    threads: state.metadata?.threads ?? [],
    threadsComplete: state.metadata?.threadsComplete === true,
    projects: state.metadata?.projects ?? [],
    sections: state.metadata?.sections ?? [],
    spawnEdges: state.metadata?.spawnEdges ?? [],
    attachments: state.metadata?.attachments ?? [],
    readReceipts: state.metadata?.readReceipts ?? [],
    globalState: global?.metadata ?? { projects: [], pinnedThreadIds: [] },
    sessionIndex: index?.entries ?? [],
    capabilities: state.metadata?.capabilities ?? null,
    generations: {
      state: state.generationPath,
      globalState: global?.generation ?? null,
      sessionIndex: index?.generation ?? null,
    },
    freshness: {
      state:
        state.status === "created"
          ? "fresh"
          : state.status === "retained"
            ? "retained"
            : "unavailable",
      globalState: global?.generation
        ? global.diagnostics.length
          ? "partial"
          : "fresh"
        : "unavailable",
      sessionIndex: index?.generation
        ? index.diagnostics.length || index.pending.length
          ? "partial"
          : "fresh"
        : "unavailable",
      observedAt: new Date().toISOString(),
    },
    diagnostics,
  };
}
