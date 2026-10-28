import type { CatalogMetadataSnapshot } from "../../../server/metadata/catalogMetadata.ts";
import type { StateThreadMetadata } from "../../../server/metadata/schemaCapabilities.ts";

export function metadata(
  overrides: Partial<CatalogMetadataSnapshot> = {},
): CatalogMetadataSnapshot {
  return {
    codexHome: "/fixture",
    sources: { stateDatabase: null, stateWal: null, sessionIndex: null, globalState: null },
    stateAuthority: "root",
    threads: [],
    threadsComplete: true,
    projects: [],
    sections: [],
    spawnEdges: [],
    attachments: [],
    readReceipts: [],
    globalState: { projects: [], pinnedThreadIds: [] },
    sessionIndex: [],
    capabilities: null,
    generations: { state: null, globalState: null, sessionIndex: null },
    freshness: {
      state: "fresh",
      globalState: "fresh",
      sessionIndex: "unavailable",
      observedAt: "2026-10-27T00:00:00.000Z",
    },
    diagnostics: [],
    ...overrides,
  };
}
export function thread(
  id: string,
  overrides: Partial<StateThreadMetadata> = {},
): StateThreadMetadata {
  return {
    id,
    cwd: "C:/Work",
    rolloutPath: "",
    createdAt: 1,
    updatedAt: 2,
    source: "cli",
    modelProvider: "openai",
    title: id,
    tokensUsed: 0,
    archived: false,
    archivedAt: null,
    gitSha: null,
    gitBranch: null,
    gitOriginUrl: null,
    firstUserMessage: "",
    model: null,
    reasoningEffort: null,
    name: null,
    pinned: false,
    sectionId: null,
    ...overrides,
  };
}
