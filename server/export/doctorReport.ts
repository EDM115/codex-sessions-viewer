import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ViewerDiagnostic } from "../../shared/types/diagnostics.ts";
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
}

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
  capabilities: {
    live: true;
    export: true;
    offline: boolean;
  };
  diagnostics: Array<Pick<ViewerDiagnostic, "code" | "severity" | "area" | "message" | "path">>;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function inspectViewerCache(path: string): Promise<DoctorCacheReport> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1) {
      return { status: "unavailable", sessionCount: 0, diagnosticCount: 0, size: metadata.size };
    }
    const database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      database.enableDefensive(true);
      database.exec("PRAGMA query_only = ON");
      const sessionRow = database.prepare("SELECT COUNT(*) AS count FROM sessions").get();
      const diagnosticRow = database.prepare("SELECT COUNT(*) AS count FROM diagnostics").get();
      return {
        status: "available",
        sessionCount: typeof sessionRow?.["count"] === "number" ? sessionRow["count"] : 0,
        diagnosticCount: typeof diagnosticRow?.["count"] === "number" ? diagnosticRow["count"] : 0,
        size: metadata.size,
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return isMissing(error)
      ? { status: "missing", sessionCount: 0, diagnosticCount: 0, size: null }
      : { status: "unavailable", sessionCount: 0, diagnosticCount: 0, size: null };
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

export async function collectDoctorReport(
  options: CollectDoctorReportOptions = {},
): Promise<DoctorReport> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const config = await loadServerViewerConfig({
    paths: options.paths,
    cli: { codexHome: options.codexHome },
  });
  const discovery = await discoverSources(config.settings.codexHome);
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
    cache: await inspectViewerCache(config.paths.cacheDatabase),
    snapshotManifest: await inspectSnapshotManifest(
      join(config.paths.cacheDir, "state-snapshots", "current.json"),
    ),
    capabilities: {
      live: true,
      export: true,
      offline: await directoryExists(join(cwd, ".output", "public")),
    },
    diagnostics: [...config.diagnostics, ...discovery.diagnostics].map(
      ({ code, severity, area, message, path }) => ({ code, severity, area, message, path }),
    ),
  };
}
