import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  viewerDiagnosticCodeSchema,
  type ViewerDiagnostic,
} from "../../shared/types/diagnostics.ts";
import { loadServerViewerConfig } from "../core/config.ts";
import type { ViewerPaths } from "../core/paths.ts";
import { discoverSources } from "../ingestion/discoverSources.ts";

export interface CollectDoctorReportOptions {
  cwd?: string | undefined;
  codexHome?: string | undefined;
  paths?: ViewerPaths | undefined;
}

export interface DoctorCacheReport {
  status: "available" | "missing" | "unavailable";
  sessionCount: number;
  diagnosticCount: number;
  size: number | null;
  catalog: {
    rootCount: number;
    subagentCount: number;
    auxiliaryCount: number;
    coldCount: number;
    queuedCount: number;
    loadingCount: number;
    readyCount: number;
    failedCount: number;
  } | null;
}

export interface DoctorOfflineOutputReport {
  status: "available" | "missing" | "incomplete";
  sessionCount: number;
  missingFiles: string[];
  searchIndex: "pagefind" | "disabled" | "unknown";
}

type DoctorDiagnostic = Pick<ViewerDiagnostic, "code" | "severity" | "area" | "message" | "path">;

export interface DoctorReport {
  codexHome: string;
  codexHomeSource: string;
  activeSessions: number;
  archivedSessions: number;
  metadata: {
    sessionIndex: boolean;
    globalState: boolean;
    stateDatabase: boolean;
    stateWal: boolean;
  };
  cache: DoctorCacheReport;
  snapshotManifest: "available" | "missing" | "unavailable";
  offlineOutput: DoctorOfflineOutputReport;
  capabilities: {
    live: true;
    export: true;
    offline: boolean;
  };
  diagnostics: DoctorDiagnostic[];
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isDiagnosticSeverity(value: unknown): value is ViewerDiagnostic["severity"] {
  return value === "info" || value === "warning" || value === "error";
}

function isDiagnosticArea(value: unknown): value is ViewerDiagnostic["area"] {
  return (
    value === "config" ||
    value === "source" ||
    value === "metadata" ||
    value === "cache" ||
    value === "export"
  );
}

async function inspectViewerCache(
  path: string,
): Promise<{ report: DoctorCacheReport; diagnostics: DoctorDiagnostic[] }> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1) {
      return {
        report: {
          status: "unavailable",
          sessionCount: 0,
          diagnosticCount: 0,
          size: metadata.size,
          catalog: null,
        },
        diagnostics: [],
      };
    }
    const database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      database.enableDefensive(true);
      database.exec("PRAGMA query_only = ON");
      const sessionRow = database.prepare("SELECT COUNT(*) AS count FROM sessions").get();
      const diagnosticRow = database.prepare("SELECT COUNT(*) AS count FROM diagnostics").get();
      const hasCatalog =
        database
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_catalog'")
          .get() !== undefined;
      const catalogCounts = {
        rootCount: 0,
        subagentCount: 0,
        auxiliaryCount: 0,
        coldCount: 0,
        queuedCount: 0,
        loadingCount: 0,
        readyCount: 0,
        failedCount: 0,
      };
      if (hasCatalog) {
        for (const row of database
          .prepare(
            "SELECT session_kind, materialization_state, COUNT(*) AS count FROM session_catalog GROUP BY session_kind, materialization_state",
          )
          .all()) {
          const count = typeof row["count"] === "number" ? row["count"] : 0;
          const kind = row["session_kind"];
          const state = row["materialization_state"];
          if (kind === "root") {
            catalogCounts.rootCount += count;
          }
          if (kind === "subagent") {
            catalogCounts.subagentCount += count;
          }
          if (kind === "auxiliary") {
            catalogCounts.auxiliaryCount += count;
          }
          if (state === "cold") {
            catalogCounts.coldCount += count;
          }
          if (state === "queued") {
            catalogCounts.queuedCount += count;
          }
          if (state === "loading") {
            catalogCounts.loadingCount += count;
          }
          if (state === "ready") {
            catalogCounts.readyCount += count;
          }
          if (state === "failed") {
            catalogCounts.failedCount += count;
          }
        }
      }
      const diagnostics = database
        .prepare(
          "SELECT code, severity, area, message, path FROM diagnostics ORDER BY created_at DESC, id",
        )
        .all()
        .flatMap((row): DoctorDiagnostic[] => {
          const { code, severity, area, message, path: diagnosticPath } = row;
          const parsedCode = viewerDiagnosticCodeSchema.safeParse(code);
          if (
            !parsedCode.success ||
            !isDiagnosticSeverity(severity) ||
            !isDiagnosticArea(area) ||
            typeof message !== "string" ||
            (diagnosticPath !== null && typeof diagnosticPath !== "string")
          ) {
            return [];
          }
          return [
            {
              code: parsedCode.data,
              severity,
              area,
              message,
              path: diagnosticPath,
            },
          ];
        });
      return {
        report: {
          status: "available",
          sessionCount: typeof sessionRow?.["count"] === "number" ? sessionRow["count"] : 0,
          diagnosticCount:
            typeof diagnosticRow?.["count"] === "number" ? diagnosticRow["count"] : 0,
          size: metadata.size,
          catalog: hasCatalog ? catalogCounts : null,
        },
        diagnostics,
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return {
      report: isMissing(error)
        ? { status: "missing", sessionCount: 0, diagnosticCount: 0, size: null, catalog: null }
        : { status: "unavailable", sessionCount: 0, diagnosticCount: 0, size: null, catalog: null },
      diagnostics: [],
    };
  }
}

async function inspectSnapshotManifest(path: string): Promise<DoctorReport["snapshotManifest"]> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1) {
      return "unavailable";
    }
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && "generationPath" in parsed
      ? "available"
      : "unavailable";
  } catch (error) {
    return isMissing(error) ? "missing" : "unavailable";
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

interface OfflineSessionEntry {
  id: string;
  scope: "active" | "archived";
}

function offlineSessionEntries(value: unknown): OfflineSessionEntry[] | null {
  if (value === null || typeof value !== "object" || !("sessions" in value)) {
    return null;
  }
  const sessions = value.sessions;
  if (!Array.isArray(sessions)) {
    return null;
  }
  const entries: OfflineSessionEntry[] = [];
  for (const session of sessions) {
    if (
      session === null ||
      typeof session !== "object" ||
      !("id" in session) ||
      typeof session.id !== "string" ||
      !/^[\w.-]+$/.test(session.id) ||
      !("scope" in session) ||
      (session.scope !== "active" && session.scope !== "archived")
    ) {
      return null;
    }
    entries.push({ id: session.id, scope: session.scope });
  }
  return entries;
}

async function inspectOfflineOutput(publicRoot: string): Promise<DoctorOfflineOutputReport> {
  if (!(await directoryExists(publicRoot))) {
    return { status: "missing", sessionCount: 0, missingFiles: [], searchIndex: "unknown" };
  }
  const missingFiles: string[] = [];
  const requireFile = async (relativePath: string): Promise<void> => {
    if (!(await regularFileExists(join(publicRoot, ...relativePath.split("/"))))) {
      missingFiles.push(relativePath);
    }
  };
  await requireFile("index.html");
  let searchIndex: DoctorOfflineOutputReport["searchIndex"] = "unknown";
  try {
    const manifest = JSON.parse(
      await readFile(join(publicRoot, "payloads", "export.json"), "utf8"),
    ) as unknown;
    if (
      manifest !== null &&
      typeof manifest === "object" &&
      "version" in manifest &&
      manifest.version === 1 &&
      "pagefind" in manifest &&
      typeof manifest.pagefind === "boolean"
    ) {
      searchIndex = manifest.pagefind ? "pagefind" : "disabled";
    }
  } catch {
    // Report the required export manifest below.
  }
  if (searchIndex === "unknown") {
    missingFiles.push("payloads/export.json");
  } else if (searchIndex === "pagefind") {
    await requireFile("pagefind/pagefind.js");
  }

  const indexPath = join(publicRoot, "payloads", "sessions", "index.json");
  let sessions: OfflineSessionEntry[] | null = null;
  try {
    sessions = offlineSessionEntries(JSON.parse(await readFile(indexPath, "utf8")) as unknown);
  } catch {
    // Report the required index below.
  }
  if (sessions === null) {
    missingFiles.push("payloads/sessions/index.json");
    return { status: "incomplete", sessionCount: 0, missingFiles, searchIndex };
  }

  await Promise.all(
    sessions.map(async ({ id, scope }) => {
      const base = `payloads/sessions/${id}`;
      await Promise.all([
        requireFile(`${base}/summary.json`),
        requireFile(`downloads/${scope}/${id}.md`),
      ]);
      const navigatorPath = join(publicRoot, "payloads", "sessions", id, "navigator.json");
      let chunkCount: number | null = null;
      try {
        const navigator = JSON.parse(await readFile(navigatorPath, "utf8")) as unknown;
        if (
          navigator !== null &&
          typeof navigator === "object" &&
          "chunkSize" in navigator &&
          typeof navigator.chunkSize === "number" &&
          Number.isSafeInteger(navigator.chunkSize) &&
          navigator.chunkSize > 0 &&
          "chunkCount" in navigator &&
          typeof navigator.chunkCount === "number" &&
          Number.isSafeInteger(navigator.chunkCount) &&
          navigator.chunkCount >= 0 &&
          "items" in navigator &&
          Array.isArray(navigator.items)
        ) {
          chunkCount = navigator.chunkCount;
        }
      } catch {
        // Report the required navigator below.
      }
      if (chunkCount === null) {
        missingFiles.push(`${base}/navigator.json`);
        return;
      }
      await Promise.all(
        Array.from({ length: chunkCount }, async (_, index) =>
          Promise.all([
            requireFile(`${base}/turn-${index}.json`),
            requireFile(`${base}/inspector-${index}.json`),
          ]),
        ),
      );
    }),
  );
  return {
    status: missingFiles.length === 0 ? "available" : "incomplete",
    sessionCount: sessions.length,
    missingFiles: missingFiles.toSorted(),
    searchIndex,
  };
}

export async function collectDoctorReport(
  options: CollectDoctorReportOptions = {},
): Promise<DoctorReport> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const config = await loadServerViewerConfig({
    paths: options.paths,
    cli: { codexHome: options.codexHome },
  });
  const discovery = await discoverSources(config.settings.codexHome);
  const cache = await inspectViewerCache(config.paths.cacheDatabase);
  const offlineOutput = await inspectOfflineOutput(join(cwd, ".output", "public"));
  return {
    codexHome: config.settings.codexHome,
    codexHomeSource: config.codexHomeSource,
    activeSessions: discovery.rollouts.filter(({ scope }) => scope === "active").length,
    archivedSessions: discovery.rollouts.filter(({ scope }) => scope === "archived").length,
    metadata: {
      sessionIndex: discovery.metadata.sessionIndex !== null,
      globalState: discovery.metadata.globalState !== null,
      stateDatabase: discovery.metadata.stateDatabase !== null,
      stateWal: discovery.metadata.stateWal !== null,
    },
    cache: cache.report,
    snapshotManifest: await inspectSnapshotManifest(
      join(config.paths.cacheDir, "state-snapshots", "current.json"),
    ),
    offlineOutput,
    capabilities: {
      live: true,
      export: true,
      offline: offlineOutput.status === "available",
    },
    diagnostics: [...config.diagnostics, ...discovery.diagnostics, ...cache.diagnostics].map(
      ({ code, severity, area, message, path }) => ({ code, severity, area, message, path }),
    ),
  };
}
