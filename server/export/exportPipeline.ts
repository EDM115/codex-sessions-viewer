import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

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
import type { NormalizedSession } from "../normalization/normalizeSession.ts";
import {
  buildPagefind,
  type PagefindBuildOptions,
  type PagefindBuildResult,
} from "./buildPagefind.ts";
import {
  noopExportProgress,
  type ExportProgressSink,
  type ExportProgressStep,
} from "./exportProgress.ts";
import { serializedJson, writeOutputFile } from "./outputFiles.ts";
import { prepareConversationForExport } from "./prepareConversation.ts";
import { writeConversationExport } from "./writeConversationExport.ts";
import {
  publishCachedContent,
  reconcileStaticSessionArtifacts,
  writeStaticPayloads,
} from "./writeStaticPayloads.ts";

export interface StaticGenerateInput {
  outputRoot: string;
  routeManifest: string;
}

export type StaticGenerateRunner = (input: StaticGenerateInput) => Promise<void>;
export type PagefindBuilder = (
  conversations: readonly NormalizedSession[],
  outputPath: string,
  options?: PagefindBuildOptions,
) => Promise<PagefindBuildResult>;

export interface RunStaticExportOptions {
  cwd?: string | undefined;
  codexHome?: string | undefined;
  outputRoot?: string | undefined;
  generatedRoot?: string | undefined;
  offline?: boolean | undefined;
  force?: boolean | undefined;
  paths?: ViewerPaths | undefined;
  generate?: StaticGenerateRunner | undefined;
  buildSearch?: PagefindBuilder | undefined;
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
  publishedAssets: number;
  publishedFavicons: number;
  removedArtifacts: number;
  diagnosticCounts: Record<string, number>;
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
        CODEX_VIEWER_ROUTE_MANIFEST: input.routeManifest,
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
  onProgress: (completed: number, total: number) => void,
): Promise<{
  conversations: NormalizedSession[];
  assetIds: Set<string>;
  faviconOrigins: Set<string>;
}> {
  const conversations: NormalizedSession[] = [];
  const assetIds = new Set<string>();
  const faviconOrigins = new Set<string>();
  const orderedSessionIds = [...sessionIds].toSorted();
  for (const [sessionIndex, sessionId] of orderedSessionIds.entries()) {
    const cached = getCachedSession(database, sessionId);
    if (cached === null) {
      failedSessions.add(sessionId);
      onProgress(sessionIndex + 1, orderedSessionIds.length);
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each session is prepared deterministically and failures retain the plain cached conversation.
      const prepared = await prepareConversationForExport(database, cached, {
        mediaRoot: join(paths.cacheDir, "assets"),
        faviconRoot: join(paths.cacheDir, "favicons"),
        offline,
      });
      updateCachedSessionRichContent(database, prepared.conversation);
      conversations.push(prepared.conversation);
      for (const id of prepared.assetIds) {
        assetIds.add(id);
      }
      for (const origin of prepared.faviconOrigins) {
        faviconOrigins.add(origin);
      }
    } catch {
      failedSessions.add(sessionId);
      conversations.push(cached);
    }
    onProgress(sessionIndex + 1, orderedSessionIds.length);
  }
  return { conversations, assetIds, faviconOrigins };
}

export async function runStaticExport(
  options: RunStaticExportOptions = {},
): Promise<StaticExportSummary> {
  const progress = options.progress ?? noopExportProgress;
  progress.setSteps(EXPORT_PROGRESS_STEPS);
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
  const transformedSessions = new Set<string>();
  const reusedSessions = new Set<string>();
  const sessionIds = new Set<string>();
  const database = openCacheDatabase(config.paths.cacheDatabase);
  try {
    const updater = new SessionCacheUpdater(database, {
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
    const prepared = await prepareConversations(
      database,
      sessionIds,
      config.paths,
      options.offline === true || !config.settings.fetchFavicons,
      failedSessions,
      (completed, total) => progress.statusProgress("Preparing conversations", completed, total),
    );
    progress.step(
      `Prepared ${prepared.conversations.length} ${pluralize("conversation", prepared.conversations.length)}`,
      failedSessions.size === 0 ? "success" : "neutral",
    );

    const stagingWorkTotal = prepared.conversations.length + 4;
    progress.statusProgress("Writing generated Markdown", 0, stagingWorkTotal);
    for (const [conversationIndex, conversation] of prepared.conversations.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- Markdown files are staged before the public directory is regenerated.
      await writeConversationExport(conversation, { generatedRoot });
      progress.statusProgress(
        "Writing generated Markdown",
        conversationIndex + 1,
        stagingWorkTotal,
      );
    }
    progress.statusProgress(
      "Writing generated static payloads",
      prepared.conversations.length,
      stagingWorkTotal,
    );
    await writeStaticPayloads(prepared.conversations, {
      generatedRoot,
      diagnosticsBySession,
    });
    progress.statusProgress(
      "Publishing generated assets and favicons",
      prepared.conversations.length + 1,
      stagingWorkTotal,
    );
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
    progress.statusProgress(
      "Reconciling proven stale generated artifacts",
      prepared.conversations.length + 2,
      stagingWorkTotal,
    );
    const removed = await reconcileStaticSessionArtifacts(generatedRoot, expectedScopes, {
      completeReconciliation,
    });
    progress.statusProgress(
      "Writing the session route manifest",
      prepared.conversations.length + 3,
      stagingWorkTotal,
    );
    const routeManifest = join(generatedRoot, "routes.json");
    const routes = prepared.conversations
      .map(({ summary }) => `/session/${encodeURIComponent(summary.id)}`)
      .toSorted();
    await writeOutputFile(generatedRoot, ["routes.json"], serializedJson({ version: 1, routes }));
    progress.statusProgress("Generated export staging ready", stagingWorkTotal, stagingWorkTotal);
    progress.step(`Staged ${prepared.conversations.length} conversations for static generation`);

    progress.status("Generating the Nuxt static site");
    progress.suspend();
    try {
      await (options.generate ?? ((input) => defaultGenerateRunner(cwd, input)))({
        outputRoot,
        routeManifest,
      });
    } finally {
      progress.resume();
    }
    progress.step("Generated the Nuxt static site");

    const publicationWorkTotal = prepared.conversations.length + 2;
    progress.statusProgress("Publishing downloadable Markdown", 0, publicationWorkTotal);
    for (const [conversationIndex, conversation] of prepared.conversations.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- Downloads are mirrored only after Nuxt has finalized its public directory.
      await writeConversationExport(conversation, { generatedRoot, publicRoot: outputRoot });
      progress.statusProgress(
        "Publishing downloadable Markdown",
        conversationIndex + 1,
        publicationWorkTotal,
      );
    }
    progress.statusProgress(
      "Publishing static conversation payloads",
      prepared.conversations.length,
      publicationWorkTotal,
    );
    await writeStaticPayloads(prepared.conversations, {
      generatedRoot,
      publicRoot: outputRoot,
      diagnosticsBySession,
    });
    progress.statusProgress(
      "Publishing referenced assets and favicons",
      prepared.conversations.length + 1,
      publicationWorkTotal,
    );
    const published = await publishCachedContent(database, {
      generatedRoot,
      publicRoot: outputRoot,
      assetIds: prepared.assetIds,
      faviconOrigins: prepared.faviconOrigins,
    });
    progress.statusProgress(
      "Published the offline data repository",
      publicationWorkTotal,
      publicationWorkTotal,
    );
    progress.step(
      `Published ${prepared.conversations.length} conversations, ${published.assetCount} assets, and ${published.faviconCount} favicons`,
    );

    const pagefindRecordCount = prepared.conversations.reduce(
      (total, conversation) => total + conversation.turns.length,
      0,
    );
    progress.statusProgress("Building the offline search index", 0, pagefindRecordCount);
    const pagefind = await (options.buildSearch ?? buildPagefind)(
      prepared.conversations,
      join(outputRoot, "pagefind"),
      {
        onRecordProgress: (completed, total) =>
          progress.statusProgress("Building the offline search index", completed, total),
      },
    );
    progress.step(`Built the offline search index with ${pagefind.recordCount} turn records`);
    return {
      codexHome: config.settings.codexHome,
      outputRoot,
      discovered: discovery.rollouts.length,
      transformed: transformedSessions.size,
      reused: reusedSessions.size,
      failed: failedSessions.size,
      cacheHits: reusedSessions.size,
      sessionCount: prepared.conversations.length,
      pagefindRecords: pagefind.recordCount,
      publishedAssets: published.assetCount,
      publishedFavicons: published.faviconCount,
      removedArtifacts: removed.length,
      diagnosticCounts: diagnosticCounts(diagnostics),
    };
  } finally {
    database.close();
  }
}
