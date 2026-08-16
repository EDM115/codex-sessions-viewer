import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { CustomRecord } from "pagefind";

import type { ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
import { getCachedSession, updateCachedSessionRichContent } from "../cache/conversationStore.ts";
import { openCacheDatabase } from "../cache/database.ts";
import { SessionCacheUpdater } from "../cache/sourceManifest.ts";
import { loadServerViewerConfig } from "../core/config.ts";
import type { ViewerPaths } from "../core/paths.ts";
import { discoverSources } from "../ingestion/discoverSources.ts";
import { readGlobalState } from "../metadata/globalState.ts";
import { readSessionIndex, type SessionIndexEntry } from "../metadata/sessionIndex.ts";
import { snapshotStateDatabase, type StateMetadataSnapshot } from "../metadata/stateSnapshot.ts";
import {
  attachGuardianEvidence,
  parseGuardianConversation,
  type GuardianReview,
} from "../normalization/guardianEvidence.ts";
import type { NormalizedSession } from "../normalization/normalizeSession.ts";
import {
  appendPagefindRecords,
  buildPagefindRecordSpool,
  createPagefindTurnRecords,
  type PagefindBuildOptions,
  type PagefindBuildResult,
} from "./buildPagefind.ts";
import {
  noopExportProgress,
  type ExportProgressSink,
  type ExportProgressStep,
} from "./exportProgress.ts";
import {
  createOutputStagingDirectories,
  discardOutputStagingDirectories,
  publishStagedOutput,
  serializedJson,
  writeOutputFile,
} from "./outputFiles.ts";
import {
  prepareConversationForExport,
  type PreparedConversationExport,
  type PrepareConversationExportOptions,
} from "./prepareConversation.ts";
import { writeConversationExport } from "./writeConversationExport.ts";
import {
  publishCachedContent,
  publishGeneratedExportFiles,
  reconcileStaticSessionArtifacts,
  writeStaticPayloads,
} from "./writeStaticPayloads.ts";

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
  cwd?: string | undefined;
  codexHome?: string | undefined;
  outputRoot?: string | undefined;
  generatedRoot?: string | undefined;
  offline?: boolean | undefined;
  force?: boolean | undefined;
  index?: boolean | undefined;
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
  discovery: Awaited<ReturnType<typeof discoverSources>>,
  paths: ViewerPaths,
  progress: ExportProgressSink,
): Promise<ExportMetadata> {
  const diagnostics: ViewerDiagnostic[] = [];
  let sessionIndexEntries: SessionIndexEntry[] = [];
  let stateSnapshot: StateMetadataSnapshot | null = null;
  if (discovery.metadata.sessionIndex !== null) {
    progress.status("Reading the Codex session index");
    const result = await readSessionIndex(discovery.metadata.sessionIndex);
    sessionIndexEntries = result.entries;
    diagnostics.push(...result.diagnostics);
  }
  if (discovery.metadata.globalState !== null) {
    progress.status("Reading global Codex metadata");
    const result = await readGlobalState(discovery.metadata.globalState);
    diagnostics.push(...result.diagnostics);
  }
  if (discovery.metadata.stateDatabase !== null) {
    progress.status("Creating a stable viewer-owned state snapshot");
    const result = await snapshotStateDatabase({
      sourceDatabase: discovery.metadata.stateDatabase,
      sourceWal: discovery.metadata.stateWal ?? `${discovery.metadata.stateDatabase}-wal`,
      snapshotRoot: join(paths.cacheDir, "state-snapshots"),
    });
    stateSnapshot = result.metadata;
    diagnostics.push(...result.diagnostics);
  }
  return { sessionIndexEntries, stateSnapshot, diagnostics };
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
  paths: ViewerPaths,
  offline: boolean,
  failedSessions: Set<string>,
  richContentFailures: RichContentFailure[],
  prepareConversation: ConversationPreparer,
  onPrepared: (conversation: NormalizedSession) => Promise<void>,
  onProgress: (completed: number, total: number) => void,
): Promise<{
  conversations: NormalizedSession[];
  assetIds: Set<string>;
  faviconOrigins: Set<string>;
}> {
  const conversations: NormalizedSession[] = [];
  const assetIds = new Set<string>();
  const faviconOrigins = new Set<string>();
  const guardianIds = new Set(
    database
      .prepare(
        "SELECT id FROM sessions WHERE EXISTS (SELECT 1 FROM json_each(sessions.models_json) WHERE value = 'codex-auto-review')",
      )
      .all()
      .flatMap((row) => (typeof row["id"] === "string" ? [row["id"]] : [])),
  );
  const guardianReviews = new Map<string, GuardianReview[]>();
  for (const guardianId of guardianIds) {
    const guardian = getCachedSession(database, guardianId);
    if (guardian === null) {
      continue;
    }
    const review = parseGuardianConversation(guardian);
    if (review?.parentThreadId !== null && review?.parentThreadId !== undefined) {
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
    attachGuardianEvidence(
      conversation.turns.flatMap(({ activities }) =>
        activities.filter((activity) => activity.kind === "tool"),
      ),
      guardianReviews.get(sessionId) ?? [],
    );
    let prepared: PreparedConversationExport | null = null;
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each session is prepared deterministically and failures retain the plain cached conversation.
      prepared = await prepareConversation(database, cached, {
        mediaRoot: join(paths.cacheDir, "assets"),
        faviconRoot: join(paths.cacheDir, "favicons"),
        offline,
      });
    } catch (error) {
      richContentFailures.push(richContentFailure(cached, "prepare", error));
    }
    if (prepared !== null) {
      try {
        updateCachedSessionRichContent(database, prepared.conversation);
        conversation = prepared.conversation;
        for (const id of prepared.assetIds) {
          assetIds.add(id);
        }
        for (const origin of prepared.faviconOrigins) {
          faviconOrigins.add(origin);
        }
      } catch (error) {
        richContentFailures.push(richContentFailure(cached, "cache", error));
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- Full raw events are staged before this loop releases the session object.
    await onPrepared(conversation);
    conversations.push({ summary: conversation.summary, turns: [], rawEvents: [] });
    onProgress(sessionIndex + 1, orderedSessionIds.length);
  }
  return { conversations, assetIds, faviconOrigins };
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
    cli: { codexHome: options.codexHome },
  });
  progress.step(`Resolved Codex home: ${config.settings.codexHome}`);
  progress.status("Discovering active and archived Codex sessions");
  const discovery = await discoverSources(config.settings.codexHome);
  progress.step(
    `Discovered ${discovery.rollouts.length} ${pluralize("session", discovery.rollouts.length)}`,
    discovery.diagnostics.length === 0 ? "success" : "neutral",
  );
  progress.status("Reading optional Codex metadata");
  const metadata = await loadExportMetadata(discovery, config.paths, progress);
  progress.step(
    metadata.diagnostics.length === 0
      ? "Codex metadata ready"
      : "Codex metadata ready with diagnostics",
    metadata.diagnostics.length === 0 ? "success" : "neutral",
  );
  const diagnostics = [...config.diagnostics, ...discovery.diagnostics, ...metadata.diagnostics];
  const diagnosticsBySession = new Map<string, ViewerDiagnostic[]>();
  const failedSessions = new Set<string>();
  const richContentFailures: RichContentFailure[] = [];
  const transformedSessions = new Set<string>();
  const reusedSessions = new Set<string>();
  const sessionIds = new Set<string>();
  const database = openCacheDatabase(config.paths.cacheDatabase);
  let pagefindRecordSpool: string | null = null;
  try {
    const updater = new SessionCacheUpdater(database, {
      retainLiveSources: false,
      sessionIndexEntries: metadata.sessionIndexEntries,
      stateSnapshot: metadata.stateSnapshot,
    });
    progress.statusProgress("Updating session cache", 0, discovery.rollouts.length);
    for (const [sourceIndex, source] of discovery.rollouts.entries()) {
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
      progress.statusProgress("Updating session cache", sourceIndex + 1, discovery.rollouts.length);
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
    const prepared = await prepareConversations(
      database,
      sessionIds,
      config.paths,
      options.offline === true || !config.settings.fetchFavicons,
      failedSessions,
      richContentFailures,
      options.prepareConversation ?? prepareConversationForExport,
      async (conversation) => {
        await writeConversationExport(conversation, { generatedRoot });
        await writeStaticPayloads([conversation], {
          generatedRoot,
          writeIndex: false,
          diagnosticsBySession,
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
    progress.step(
      `Prepared ${prepared.conversations.length} ${pluralize("conversation", prepared.conversations.length)}${richContentFailures.length === 0 ? "" : ` with ${richContentFailures.length} rich-content ${pluralize("fallback", richContentFailures.length)}`}`,
      failedSessions.size === 0 && richContentFailures.length === 0 ? "success" : "neutral",
    );

    const stagingWorkTotal = 4;
    progress.statusProgress("Writing the generated session index", 0, stagingWorkTotal);
    await writeStaticPayloads(prepared.conversations, {
      generatedRoot,
      writeSessions: false,
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
        discovered: discovery.rollouts.length,
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
    database.close();
    if (pagefindRecordSpool !== null) {
      await rm(pagefindRecordSpool, { force: true });
    }
  }
}
