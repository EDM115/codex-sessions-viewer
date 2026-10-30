import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { CustomRecord } from "pagefind";

import {
  catalogSession,
  readCatalogLibrary,
  storeValidatedCatalogClassification,
} from "#server/cache/catalogStore.ts";
import {
  getCachedSession,
  updateCachedSessionRichContent,
} from "#server/cache/conversationStore.ts";
import { openCacheDatabase } from "#server/cache/database.ts";
import {
  SessionCacheUpdater,
  CACHE_PARSER_VERSION,
  getSourceManifestEntry,
} from "#server/cache/sourceManifest.ts";
import { storeEmbeddedMedia } from "#server/content/extractMedia.ts";
import { prepareHistoryAttachments } from "#server/content/historyAttachments.ts";
import { LinkPreviewService } from "#server/content/linkPreviews.ts";
import { loadServerViewerConfig, resolvedTrustedMediaRoots } from "#server/core/config.ts";
import type { ViewerPaths } from "#server/core/paths.ts";
import {
  appendPagefindRecords,
  buildPagefindRecordSpool,
  createPagefindTurnRecords,
  type PagefindBuildOptions,
  type PagefindBuildResult,
} from "#server/export/buildPagefind.ts";
import {
  noopExportProgress,
  type ExportProgressSink,
  type ExportProgressStep,
} from "#server/export/exportProgress.ts";
import {
  createOutputStagingDirectories,
  discardOutputStagingDirectories,
  publishStagedOutput,
  serializedJson,
  writeOutputFile,
} from "#server/export/outputFiles.ts";
import {
  prepareConversationForExport,
  type PreparedConversationExport,
  type PrepareConversationExportOptions,
} from "#server/export/prepareConversation.ts";
import { publishLinkPreviews } from "#server/export/publishLinkPreviews.ts";
import { writeConversationExport } from "#server/export/writeConversationExport.ts";
import {
  publishCachedContent,
  publishGeneratedExportFiles,
  reconcileStaticSessionArtifacts,
  writeStaticPayloads,
} from "#server/export/writeStaticPayloads.ts";
import { completeHistoryPage } from "#server/history/completeHistory.ts";
import { readCompleteRollout } from "#server/ingestion/completeRollout.ts";
import { discoverSources } from "#server/ingestion/discoverSources.ts";
import { rolloutRefFromSource } from "#server/ingestion/rolloutIdentity.ts";
import { RolloutStore } from "#server/ingestion/rolloutStream.ts";
import { selectSessionSources } from "#server/ingestion/selectSessionSources.ts";
import {
  parseSessionMetaBytes,
  CATALOG_EVIDENCE_VERSION,
} from "#server/ingestion/sessionMetaPrefix.ts";
import { refreshLiveCatalog } from "#server/live/catalogBuilder.ts";
import {
  readCatalogMetadata,
  type CatalogMetadataSnapshot,
} from "#server/metadata/catalogMetadata.ts";
import type { SessionIndexEntry } from "#server/metadata/sessionIndex.ts";
import type { StateMetadataSnapshot } from "#server/metadata/stateSnapshot.ts";
import {
  classifyNormalizedSession,
  normalizedSessionMeta,
  isThreadVisible,
} from "#server/metadata/threadClassification.ts";
import { resolveThreadFields } from "#server/metadata/threadFields.ts";
import {
  attachGuardianEvidence,
  parseGuardianConversations,
  parseParentNativeReviews,
  parentNativeReviewAvailability,
  associateApprovalReviews,
  approvalEvidenceResult,
  type GuardianReview,
} from "#server/normalization/guardianEvidence.ts";
import type { NormalizedSession } from "#server/normalization/normalizeSession.ts";
import { resolveSubagentTopology } from "#server/normalization/subagentTopology.ts";
import { createViewerDiagnostic, type ViewerDiagnostic } from "#shared/types/diagnostics.ts";
import type { HistoryPage } from "#shared/types/history.ts";

export interface StaticGenerateInput {
  outputRoot: string;
  publicInputRoot: string;
  buildRoot: string;
  routeManifest: string;
  searchIndex: boolean;
}

export type StaticGenerateRunner = (input: StaticGenerateInput) => Promise<void>;
export type PagefindBuilder = (
  records: readonly CustomRecord[],
  outputPath: string,
  options?: PagefindBuildOptions,
) => Promise<PagefindBuildResult>;
export type ConversationPreparer = (
  database: DatabaseSync,
  source: NormalizedSession,
  options: PrepareConversationExportOptions,
) => Promise<PreparedConversationExport>;

export interface RichContentFailure {
  sessionId: string;
  title: string;
  sourcePath: string;
  stage: "prepare" | "cache";
  errorName: string;
  errorMessage: string;
}

export interface RunStaticExportOptions {
  enrichPreviews?: boolean | undefined;
  cwd?: string | undefined;
  codexHome?: string | undefined;
  outputRoot?: string | undefined;
  generatedRoot?: string | undefined;
  offline?: boolean | undefined;
  force?: boolean | undefined;
  index?: boolean | undefined;
  trustedMediaRoots?: string[] | undefined;
  paths?: ViewerPaths | undefined;
  generate?: StaticGenerateRunner | undefined;
  buildSearch?: PagefindBuilder | undefined;
  prepareConversation?: ConversationPreparer | undefined;
  progress?: ExportProgressSink | undefined;
}

export interface StaticExportSummary {
  codexHome: string;
  outputRoot: string;
  discovered: number;
  transformed: number;
  reused: number;
  failed: number;
  cacheHits: number;
  sessionCount: number;
  pagefindRecords: number;
  searchIndex: boolean;
  publishedAssets: number;
  publishedFavicons: number;
  removedArtifacts: number;
  diagnosticCounts: Record<string, number>;
  richContentFailures: RichContentFailure[];
}

interface ExportMetadata {
  catalogMetadata: CatalogMetadataSnapshot;
  sessionIndexEntries: SessionIndexEntry[];
  stateSnapshot: StateMetadataSnapshot | null;
  diagnostics: ViewerDiagnostic[];
}

const EXPORT_PROGRESS_STEPS: readonly ExportProgressStep[] = [
  { weight: 1 }, // Resolve viewer configuration and Codex home.
  { weight: 2 }, // Recursively discover active and archived session sources.
  { weight: 2 }, // Read metadata and create a stable viewer-owned state snapshot.
  { weight: 32 }, // Hash, parse, normalize, and cache each discovered rollout.
  { weight: 20 }, // Prepare cached rich content, local media, and favicons per session.
  { weight: 8 }, // Stage private Markdown, payloads, content, and routes.
  { weight: 16 }, // Build and prerender the Nuxt static application.
  { weight: 8 }, // Publish downloadable Markdown, payloads, and referenced content.
  { weight: 12 }, // Build one offline Pagefind record per conversation turn.
];

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

function diagnosticCounts(diagnostics: readonly ViewerDiagnostic[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    counts[diagnostic.code] = (counts[diagnostic.code] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function addSessionDiagnostics(
  target: Map<string, ViewerDiagnostic[]>,
  sessionId: string | null,
  diagnostics: readonly ViewerDiagnostic[],
): void {
  if (sessionId === null || diagnostics.length === 0) {
    return;
  }
  target.set(sessionId, [...(target.get(sessionId) ?? []), ...diagnostics]);
}

async function loadExportMetadata(
  codexHome: string,
  paths: ViewerPaths,
  progress: ExportProgressSink,
): Promise<ExportMetadata> {
  progress.status("Reading the metadata catalog through a viewer-owned snapshot");
  const catalogMetadata = await readCatalogMetadata(
    codexHome,
    join(paths.cacheDir, "catalog-snapshots"),
  );
  return {
    catalogMetadata,
    sessionIndexEntries: catalogMetadata.sessionIndex,
    stateSnapshot:
      catalogMetadata.stateAuthority === "unavailable"
        ? null
        : {
            threads: catalogMetadata.threads,
            threadsComplete: catalogMetadata.threadsComplete,
            sections: catalogMetadata.sections,
            spawnEdges: catalogMetadata.spawnEdges,
            projects: catalogMetadata.projects,
            attachments: catalogMetadata.attachments,
            readReceipts: catalogMetadata.readReceipts,
            ...(catalogMetadata.capabilities ? { capabilities: catalogMetadata.capabilities } : {}),
          },
    diagnostics: catalogMetadata.diagnostics,
  };
}

async function defaultGenerateRunner(cwd: string, input: StaticGenerateInput): Promise<void> {
  const pnpmEntrypoint = process.env["npm_execpath"]?.trim();
  const javascriptEntrypoint = pnpmEntrypoint !== undefined && /\.[cm]?js$/iu.test(pnpmEntrypoint);
  const command = javascriptEntrypoint
    ? process.execPath
    : (pnpmEntrypoint ?? (process.platform === "win32" ? "pnpm.cmd" : "pnpm"));
  const args = javascriptEntrypoint
    ? [pnpmEntrypoint, "exec", "nuxt", "generate"]
    : ["exec", "nuxt", "generate"];
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        CODEX_VIEWER_MODE: "static",
        CODEX_VIEWER_OUTPUT: input.outputRoot,
        CODEX_VIEWER_PUBLIC_INPUT: input.publicInputRoot,
        CODEX_VIEWER_BUILD_OUTPUT: input.buildRoot,
        CODEX_VIEWER_ROUTE_MANIFEST: input.routeManifest,
        CODEX_VIEWER_PAGEFIND: input.searchIndex ? "1" : "0",
      },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectProcess);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveProcess();
        return;
      }
      rejectProcess(
        new Error(
          `Nuxt generate failed${signal === null ? ` with exit code ${String(code)}` : ` after signal ${signal}`}.`,
        ),
      );
    });
  });
}

async function prepareConversations(
  database: DatabaseSync,
  sessionIds: ReadonlySet<string>,
  stateSnapshot: StateMetadataSnapshot | null,
  sessionIndexEntries: readonly SessionIndexEntry[],
  paths: ViewerPaths,
  offline: boolean,
  trustedMediaRoots: readonly string[],
  failedSessions: Set<string>,
  richContentFailures: RichContentFailure[],
  prepareConversation: ConversationPreparer,
  onPrepared: (conversation: NormalizedSession) => Promise<void>,
  onProgress: (completed: number, total: number) => void,
): Promise<{
  conversations: NormalizedSession[];
  assetIds: Set<string>;
  faviconOrigins: Set<string>;
  previewUrls: Set<string>;
}> {
  const conversations: NormalizedSession[] = [];
  const assetIds = new Set<string>();
  const faviconOrigins = new Set<string>();
  const previewUrls = new Set<string>();
  const native = new Map((stateSnapshot?.threads ?? []).map((thread) => [thread.id, thread]));
  const indexNames = new Map(sessionIndexEntries.map((entry) => [entry.id, entry]));
  const classifications = new Map(
    [...sessionIds].flatMap((id) => {
      const session = getCachedSession(database, id);
      if (session === null) {
        return [];
      }
      return [
        [
          id,
          classifyNormalizedSession(session, native.get(id), {
            spawnParentThreadIds: (stateSnapshot?.spawnEdges ?? [])
              .filter((edge) => edge.childThreadId === id)
              .map((edge) => edge.parentThreadId),
          }),
        ] as const,
      ];
    }),
  );
  const topology = resolveSubagentTopology(
    [...classifications].map(([id, classification]) => ({
      id,
      parentThreadId: isThreadVisible(classification, "child")
        ? classification.parentThreadId
        : null,
      agentPath: classification.agentPath,
      agentNickname: classification.agentNickname,
    })),
  );
  for (const [id, node] of topology) {
    if (!node.cycle) {
      continue;
    }
    const classification = classifications.get(id)!;
    classification.visibility = "unresolved";
    classification.reasons.push("parent-cycle");
  }
  for (const [id, classification] of classifications) {
    const cached = getCachedSession(database, id);
    const catalog = catalogSession(database, id);
    const manifest = catalog?.summary.sourcePath
      ? getSourceManifestEntry(database, catalog.summary.sourcePath)
      : null;
    if (!cached || !catalog?.summary.sourcePath || !manifest || manifest.sessionId !== id) {
      continue;
    }
    const meta = parseSessionMetaBytes(
      catalog.summary.sourcePath,
      Buffer.from(
        JSON.stringify({ type: "session_meta", payload: normalizedSessionMeta(cached) }) + "\n",
      ),
    ).meta;
    storeValidatedCatalogClassification(
      database,
      id,
      {
        version: CATALOG_EVIDENCE_VERSION,
        origin: "materialized",
        status: meta ? "found" : "missing",
        meta,
        parentThreadIdHint: classification.parentThreadId,
        classification,
        freshness: "verified",
        validatedSha256: manifest.fingerprint.sha256,
      },
      { sourceRevision: catalog.sourceRevision, sourcePath: catalog.summary.sourcePath },
    );
  }
  const guardianIds = new Set(
    [...classifications]
      .filter(([, classification]) => !isThreadVisible(classification))
      .map(([id]) => id),
  );
  const guardianReviews = new Map<string, GuardianReview[]>();
  for (const guardianId of guardianIds) {
    const guardian = getCachedSession(database, guardianId);
    if (guardian === null) {
      continue;
    }
    for (const review of parseGuardianConversations(guardian)) {
      if (review.parentThreadId === null) {
        continue;
      }
      guardianReviews.set(review.parentThreadId, [
        ...(guardianReviews.get(review.parentThreadId) ?? []),
        review,
      ]);
    }
  }
  const orderedSessionIds = [...sessionIds].filter((id) => !guardianIds.has(id)).toSorted();
  for (const [sessionIndex, sessionId] of orderedSessionIds.entries()) {
    const cached = getCachedSession(database, sessionId);
    if (cached === null) {
      failedSessions.add(sessionId);
      onProgress(sessionIndex + 1, orderedSessionIds.length);
      continue;
    }
    let conversation = cached;
    conversation.classification = classifications.get(sessionId)!;
    const fields = resolveThreadFields({
      id: sessionId,
      thread: native.get(sessionId),
      index: indexNames.get(sessionId),
      knownTitle: catalogSession(database, sessionId)?.summary.title ?? cached.summary.title,
      createdAt: cached.summary.createdAt,
      updatedAt: cached.summary.updatedAt,
      historyMode: conversation.classification.historyMode,
    });
    conversation.summary = {
      ...conversation.summary,
      title: fields.title,
      createdAt: fields.createdAt ?? conversation.summary.createdAt,
      updatedAt: fields.updatedAt ?? conversation.summary.updatedAt,
      parentThreadId: isThreadVisible(conversation.classification, "child")
        ? conversation.classification.parentThreadId
        : null,
      childThreadIds: [...classifications]
        .filter(
          ([, classification]) =>
            isThreadVisible(classification, "child") && classification.parentThreadId === sessionId,
        )
        .map(([id]) => id)
        .toSorted(),
    };
    const reviews = [
      ...parseParentNativeReviews(conversation),
      ...(guardianReviews.get(sessionId) ?? []),
    ];
    conversation.approvalEvidence = approvalEvidenceResult(
      sessionId,
      associateApprovalReviews(
        conversation.turns.flatMap((turn) =>
          turn.activities.filter((activity) => activity.kind === "tool"),
        ),
        reviews,
        { sessionId },
      ),
      {
        availability: parentNativeReviewAvailability(conversation),
        historyEpoch: null,
        contentRevision: createHash("sha256")
          .update(
            JSON.stringify(
              conversation.rawEvents.map((event) => [
                event.id,
                event.identity ?? null,
                event.logicalVisibility ?? "unresolved",
              ]),
            ),
          )
          .digest("hex"),
        coverage: null,
      },
    );
    attachGuardianEvidence(
      conversation.turns.flatMap(({ activities }) =>
        activities.filter((activity) => activity.kind === "tool"),
      ),
      reviews,
      { sessionId },
    );
    let prepared: PreparedConversationExport | null = null;
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each session is prepared deterministically and failures retain the plain cached conversation.
      prepared = await prepareConversation(database, cached, {
        mediaRoot: join(paths.cacheDir, "assets"),
        faviconRoot: join(paths.cacheDir, "favicons"),
        offline,
        trustedMediaRoots,
      });
    } catch (error) {
      richContentFailures.push(richContentFailure(cached, "prepare", error));
    }
    if (prepared !== null) {
      try {
        updateCachedSessionRichContent(database, prepared.conversation);
        conversation = {
          ...prepared.conversation,
          classification: cached.classification!,
          approvalEvidence: cached.approvalEvidence!,
        };
        for (const id of prepared.assetIds) {
          assetIds.add(id);
        }
        for (const origin of prepared.faviconOrigins) {
          faviconOrigins.add(origin);
        }
        for (const url of prepared.previewUrls ?? []) {
          previewUrls.add(url);
        }
      } catch (error) {
        richContentFailures.push(richContentFailure(cached, "cache", error));
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- Full raw events are staged before this loop releases the session object.
    await onPrepared(conversation);
    conversations.push({
      summary: conversation.summary,
      turns: [],
      rawEvents: [],
      classification: conversation.classification!,
    });
    onProgress(sessionIndex + 1, orderedSessionIds.length);
  }
  return { conversations, assetIds, faviconOrigins, previewUrls };
}

function richContentFailure(
  conversation: NormalizedSession,
  stage: RichContentFailure["stage"],
  error: unknown,
): RichContentFailure {
  return {
    sessionId: conversation.summary.id,
    title: conversation.summary.title,
    sourcePath: conversation.summary.sourcePath,
    stage,
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

export async function runStaticExport(
  options: RunStaticExportOptions = {},
): Promise<StaticExportSummary> {
  const progress = options.progress ?? noopExportProgress;
  const searchIndex = options.index !== false;
  progress.setSteps(searchIndex ? EXPORT_PROGRESS_STEPS : EXPORT_PROGRESS_STEPS.slice(0, -1));
  const cwd = resolve(options.cwd ?? process.cwd());
  const generatedRoot = resolve(options.generatedRoot ?? join(cwd, ".generated"));
  const outputRoot = resolve(options.outputRoot ?? join(cwd, ".output", "public"));
  progress.status("Resolving viewer configuration and Codex home");
  const config = await loadServerViewerConfig({
    paths: options.paths,
    cli: { codexHome: options.codexHome, trustedMediaRoots: options.trustedMediaRoots },
  });
  progress.step(`Resolved Codex home: ${config.settings.codexHome}`);
  progress.status("Discovering active and archived Codex sessions");
  const discovery = await discoverSources(config.settings.codexHome);
  const metadata = await loadExportMetadata(config.settings.codexHome, config.paths, progress);
  const sourceSelection = await selectSessionSources(discovery.rollouts, {
    currentRolloutPaths: new Map(
      (metadata.stateSnapshot?.threads ?? []).map((thread) => [thread.id, thread.rolloutPath]),
    ),
  });
  const selectedSources = sourceSelection.selected.map(({ source }) => source);
  progress.step(
    `Discovered ${selectedSources.length} ${pluralize("session", selectedSources.length)}`,
    discovery.diagnostics.length === 0 && sourceSelection.diagnostics.length === 0
      ? "success"
      : "neutral",
  );
  progress.status("Reading optional Codex metadata");
  progress.step(
    metadata.diagnostics.length === 0
      ? "Codex metadata ready"
      : "Codex metadata ready with diagnostics",
    metadata.diagnostics.length === 0 ? "success" : "neutral",
  );
  const diagnostics = [
    ...config.diagnostics,
    ...discovery.diagnostics,
    ...sourceSelection.diagnostics,
    ...metadata.diagnostics,
  ];
  const diagnosticsBySession = new Map<string, ViewerDiagnostic[]>();
  const failedSessions = new Set<string>();
  const richContentFailures: RichContentFailure[] = [];
  const transformedSessions = new Set<string>();
  const reusedSessions = new Set<string>();
  const sessionIds = new Set<string>();
  const database = openCacheDatabase(config.paths.cacheDatabase);
  const rolloutStore = new RolloutStore({
    cacheDirectory: join(config.paths.cacheDir, "decoded-rollouts"),
  });
  let pagefindRecordSpool: string | null = null;
  try {
    await refreshLiveCatalog({
      database,
      discovery,
      sessionIndexEntries: metadata.sessionIndexEntries,
      globalState: metadata.catalogMetadata.globalState,
      stateSnapshot: metadata.stateSnapshot,
      catalogMetadata: metadata.catalogMetadata,
    });
    await refreshLiveCatalog({
      database,
      discovery: { ...discovery, rollouts: selectedSources },
      sessionIndexEntries: metadata.sessionIndexEntries,
      globalState: metadata.catalogMetadata.globalState,
      stateSnapshot: metadata.stateSnapshot,
      recoveryBatch: true,
    });
    const updater = new SessionCacheUpdater(database, {
      openRollout: (ref, signal) => rolloutStore.open(ref, signal),
      retainLiveSources: false,
      sessionIndexEntries: metadata.sessionIndexEntries,
      stateSnapshot: metadata.stateSnapshot,
    });
    progress.statusProgress("Updating session cache", 0, selectedSources.length);
    for (const [sourceIndex, source] of selectedSources.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- Source updates are intentionally serialized around one SQLite cache and stable-read state.
      const result = await updater.update(source, { force: options.force });
      if (result.status === "updated") {
        transformedSessions.add(result.sessionId);
        reusedSessions.delete(result.sessionId);
        sessionIds.add(result.sessionId);
        diagnostics.push(...result.diagnostics);
        addSessionDiagnostics(diagnosticsBySession, result.sessionId, result.diagnostics);
      } else if (result.status === "unchanged") {
        if (result.sessionId !== null) {
          if (!transformedSessions.has(result.sessionId)) {
            reusedSessions.add(result.sessionId);
          }
          sessionIds.add(result.sessionId);
        }
      } else {
        diagnostics.push(...result.diagnostics);
        if (result.retainedSessionId !== null) {
          failedSessions.add(result.retainedSessionId);
          sessionIds.add(result.retainedSessionId);
          addSessionDiagnostics(diagnosticsBySession, result.retainedSessionId, result.diagnostics);
        } else {
          failedSessions.add(`source:${source.path}`);
        }
      }
      progress.statusProgress("Updating session cache", sourceIndex + 1, selectedSources.length);
    }
    progress.step(
      `Session cache ready: ${transformedSessions.size} transformed, ${reusedSessions.size} reused, ${failedSessions.size} failed`,
      failedSessions.size === 0 ? "success" : "neutral",
    );

    progress.statusProgress("Preparing conversations", 0, sessionIds.size);
    let pagefindSpoolPath: string | null = null;
    if (searchIndex) {
      const spoolName = `pagefind-records-${randomUUID()}.jsonl`;
      await writeOutputFile(generatedRoot, [spoolName], "");
      pagefindSpoolPath = join(generatedRoot, spoolName);
      pagefindRecordSpool = pagefindSpoolPath;
    }
    const pagefindRecords: CustomRecord[] | null =
      searchIndex && options.buildSearch !== undefined ? [] : null;
    let pagefindRecordCount = 0;
    const historyAssetIds = new Set<string>();
    const prepared = await prepareConversations(
      database,
      sessionIds,
      metadata.stateSnapshot,
      metadata.sessionIndexEntries,
      config.paths,
      options.offline === true || !config.settings.fetchFavicons,
      resolvedTrustedMediaRoots(config.settings),
      failedSessions,
      richContentFailures,
      options.prepareConversation ?? prepareConversationForExport,
      async (conversation) => {
        let history: HistoryPage | undefined;
        let historySources;
        try {
          const ref =
            sourceSelection.historyGraph.find(
              (candidate) => candidate.sourcePath === conversation.summary.sourcePath,
            ) ?? rolloutRefFromSource(conversation.summary.sourcePath, null);
          const complete = await readCompleteRollout(
            ref,
            {
              async resolve(physical) {
                const matches = sourceSelection.historyGraph.filter(
                  (candidate) => candidate.physicalRolloutId === physical,
                );
                const plain = matches.filter(
                  (candidate) => candidate.representation === "plain-jsonl",
                );
                const selected = plain.length ? plain : matches;
                return selected.length === 1 ? selected[0]! : null;
              },
            },
            (source, signal) => rolloutStore.open(source, signal),
            CACHE_PARSER_VERSION,
          );
          history = completeHistoryPage(complete);
          historySources = complete.segments.map(({ generation }) => generation);
          if (history.coverage.status !== "complete") {
            throw new Error("history.unsupported_records");
          }
        } catch (error) {
          const diagnostic = createViewerDiagnostic({
            code: "source.invalid_jsonl",
            severity: "warning",
            area: "export",
            sessionId: conversation.summary.id,
            message:
              "Saved history is incomplete or contains unsupported records, inspect the retained source evidence before treating it as complete.",
            details: { reason: error instanceof Error ? error.message : "history.export_failed" },
          });
          diagnostics.push(diagnostic);
          addSessionDiagnostics(diagnosticsBySession, conversation.summary.id, [diagnostic]);
          conversation.summary.diagnosticCount = diagnosticsBySession.get(
            conversation.summary.id,
          )!.length;
        }
        await writeConversationExport(conversation, { generatedRoot });
        await writeStaticPayloads([conversation], {
          generatedRoot,
          writeIndex: false,
          diagnosticsBySession,
          historyMedia: {
            cacheScope: JSON.stringify([
              config.paths.cacheDir,
              conversation.summary.id,
              conversation.summary.revision,
            ]),
            async storeEmbeddedMedia(sources) {
              const stored = await storeEmbeddedMedia(database, sources, {
                assetRoot: join(config.paths.cacheDir, "assets"),
                sessionId: conversation.summary.id,
              });
              for (const source of stored) {
                historyAssetIds.add(source.assetId);
              }
            },
            async prepareAttachments(attachments) {
              const nodes = await prepareHistoryAttachments(database, attachments, {
                assetRoot: join(config.paths.cacheDir, "assets"),
                sessionId: conversation.summary.id,
                trustedMediaRoots: resolvedTrustedMediaRoots(config.settings),
              });
              for (const node of nodes) {
                if (node.assetId) {
                  historyAssetIds.add(node.assetId);
                }
              }
              return nodes;
            },
          },
          ...(history
            ? {
                histories: new Map([[conversation.summary.id, history]]),
                historySources: new Map([[conversation.summary.id, historySources ?? []]]),
              }
            : {}),
        });
        if (pagefindSpoolPath !== null) {
          const records = createPagefindTurnRecords([conversation]);
          pagefindRecordCount += records.length;
          await appendPagefindRecords(pagefindSpoolPath, records);
          pagefindRecords?.push(...records);
        }
      },
      (completed, total) => progress.statusProgress("Preparing conversations", completed, total),
    );
    for (const assetId of historyAssetIds) {
      prepared.assetIds.add(assetId);
    }
    progress.step(
      `Prepared ${prepared.conversations.length} ${pluralize("conversation", prepared.conversations.length)}${richContentFailures.length === 0 ? "" : ` with ${richContentFailures.length} rich-content ${pluralize("fallback", richContentFailures.length)}`}`,
      failedSessions.size === 0 && richContentFailures.length === 0 ? "success" : "neutral",
    );

    const stagingWorkTotal = 4;
    if (options.enrichPreviews && !options.offline) {
      const previews = new LinkPreviewService(database, join(config.paths.cacheDir, "previews"), {
        enabled: true,
      });
      try {
        for (const url of prepared.previewUrls) {
          // oxlint-disable-next-line no-await-in-loop -- Optional explicit export enrichment is bounded and never runs in offline mode
          await previews.resolve(url).catch(() => undefined);
        }
      } finally {
        await previews.close();
      }
    }
    const previewPublication = {
      cacheRoot: join(config.paths.cacheDir, "previews"),
      generatedRoot,
      urls: prepared.previewUrls,
    };
    await publishLinkPreviews(database, previewPublication);
    progress.statusProgress("Writing the generated session index", 0, stagingWorkTotal);
    await writeStaticPayloads(prepared.conversations, {
      generatedRoot,
      writeSessions: false,
      catalog: readCatalogLibrary(database)!,
    });
    await writeOutputFile(
      generatedRoot,
      ["payloads", "export.json"],
      serializedJson({ version: 1, pagefind: searchIndex }),
    );
    progress.statusProgress("Publishing generated assets and favicons", 1, stagingWorkTotal);
    await publishCachedContent(database, {
      generatedRoot,
      assetIds: prepared.assetIds,
      faviconOrigins: prepared.faviconOrigins,
    });
    const expectedScopes = new Map(
      prepared.conversations.map(({ summary }) => [summary.id, summary.scope]),
    );
    const completeReconciliation =
      !config.onboardingRequired &&
      !discovery.diagnostics.some(
        ({ area, code }) => area === "source" && code === "codex_home.unreadable",
      );
    progress.statusProgress("Reconciling proven stale generated artifacts", 2, stagingWorkTotal);
    const removed = await reconcileStaticSessionArtifacts(generatedRoot, expectedScopes, {
      completeReconciliation,
    });
    progress.statusProgress("Writing the session route manifest", 3, stagingWorkTotal);
    const routeManifest = join(generatedRoot, "routes.json");
    const routes = prepared.conversations
      .map(({ summary }) => `/session/${encodeURIComponent(summary.id)}`)
      .toSorted();
    await writeOutputFile(generatedRoot, ["routes.json"], serializedJson({ version: 1, routes }));
    progress.statusProgress("Generated export staging ready", stagingWorkTotal, stagingWorkTotal);
    progress.step(`Staged ${prepared.conversations.length} conversations for static generation`);

    const outputStaging = await createOutputStagingDirectories(outputRoot);
    try {
      progress.status("Preparing isolated prerender data");
      await publishGeneratedExportFiles(generatedRoot, outputStaging.publicInputRoot);
      await publishLinkPreviews(database, {
        ...previewPublication,
        publicRoot: outputStaging.publicInputRoot,
      });
      await publishCachedContent(database, {
        generatedRoot,
        publicRoot: outputStaging.publicInputRoot,
        assetIds: prepared.assetIds,
        faviconOrigins: prepared.faviconOrigins,
      });
      progress.status("Generating the Nuxt static site in isolated staging");
      progress.suspend();
      try {
        await (options.generate ?? ((input) => defaultGenerateRunner(cwd, input)))({
          outputRoot: outputStaging.publicRoot,
          publicInputRoot: outputStaging.publicInputRoot,
          buildRoot: outputStaging.buildRoot,
          routeManifest,
          searchIndex,
        });
      } finally {
        progress.resume();
      }
      progress.step("Generated the Nuxt static site in isolated staging");

      const publicationWorkTotal = 2;
      progress.statusProgress("Mirroring generated conversations", 0, publicationWorkTotal);
      await publishGeneratedExportFiles(generatedRoot, outputStaging.publicRoot);
      await publishLinkPreviews(database, {
        ...previewPublication,
        publicRoot: outputStaging.publicRoot,
      });
      progress.statusProgress("Preparing referenced assets and favicons", 1, publicationWorkTotal);
      const published = await publishCachedContent(database, {
        generatedRoot,
        publicRoot: outputStaging.publicRoot,
        assetIds: prepared.assetIds,
        faviconOrigins: prepared.faviconOrigins,
      });
      progress.statusProgress(
        "Prepared the offline data repository",
        publicationWorkTotal,
        publicationWorkTotal,
      );
      progress.step(
        `Prepared ${prepared.conversations.length} conversations, ${published.assetCount} assets, and ${published.faviconCount} favicons for publication`,
      );

      let publishedPagefindRecords = 0;
      if (searchIndex) {
        if (pagefindSpoolPath === null) {
          throw new Error("Pagefind record spool was not created.");
        }
        progress.statusProgress("Building the offline search index", 0, pagefindRecordCount);
        const pagefindOptions: PagefindBuildOptions = {
          onRecordProgress: (completed, total) =>
            progress.statusProgress("Building the offline search index", completed, total),
          onWriteStart: () => progress.status("Finalizing the offline search index"),
        };
        const pagefind =
          options.buildSearch === undefined
            ? await buildPagefindRecordSpool(
                pagefindSpoolPath,
                pagefindRecordCount,
                join(outputStaging.publicRoot, "pagefind"),
                pagefindOptions,
              )
            : await options.buildSearch(
                pagefindRecords ?? [],
                join(outputStaging.publicRoot, "pagefind"),
                pagefindOptions,
              );
        publishedPagefindRecords = pagefind.recordCount;
      } else {
        progress.step("Skipped the offline search index (--no-index)");
      }
      progress.status("Publishing the complete offline site");
      await publishStagedOutput(outputStaging.publicRoot, outputRoot);
      progress.step(
        searchIndex
          ? `Published the complete offline site with ${publishedPagefindRecords} indexed turn records`
          : "Published the complete offline site without a search index",
      );
      return {
        codexHome: config.settings.codexHome,
        outputRoot,
        discovered: selectedSources.length,
        transformed: transformedSessions.size,
        reused: reusedSessions.size,
        failed: failedSessions.size,
        cacheHits: reusedSessions.size,
        sessionCount: prepared.conversations.length,
        pagefindRecords: publishedPagefindRecords,
        searchIndex,
        publishedAssets: published.assetCount,
        publishedFavicons: published.faviconCount,
        removedArtifacts: removed.length,
        diagnosticCounts: diagnosticCounts(diagnostics),
        richContentFailures,
      };
    } finally {
      await discardOutputStagingDirectories(outputStaging);
    }
  } finally {
    await rolloutStore.close();
    database.close();
    if (pagefindRecordSpool !== null) {
      await rm(pagefindRecordSpool, { force: true });
    }
  }
}
