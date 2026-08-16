import { parseDoctorArguments } from "../server/export/cliArguments.ts";
import { collectDoctorReport } from "../server/export/doctorReport.ts";

const HELP = `Codex Sessions Viewer diagnostics

Usage: pnpm run doctor [options]

Options:
  --codex-home <path>  Inspect this Codex home
  --help               Show this help and exit`;

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2);
  if (rawArguments.includes("--help")) {
    console.log(HELP);
    return;
  }

  const report = await collectDoctorReport(parseDoctorArguments(rawArguments));
  console.log(`Codex home (${report.codexHomeSource}): ${report.codexHome}`);
  console.log(`Sessions: ${report.activeSessions} active, ${report.archivedSessions} archived.`);
  console.log(
    `Metadata: session index ${report.metadata.sessionIndex ? "available" : "missing"}, global state ${report.metadata.globalState ? "available" : "missing"}, state database ${report.metadata.stateDatabase ? "available" : "missing"}.`,
  );
  console.log(
    `Normalized payloads: ${report.cache.status}; ${report.cache.sessionCount} sessions and ${report.cache.diagnosticCount} parser diagnostics.`,
  );
  console.log(
    report.cache.catalog === null
      ? "Viewer catalog: unavailable."
      : `Viewer catalog: ${report.cache.catalog.rootCount} roots, ${report.cache.catalog.subagentCount} subagents, ${report.cache.catalog.auxiliaryCount} auxiliaries; ${report.cache.catalog.readyCount} ready, ${report.cache.catalog.coldCount} cold, ${report.cache.catalog.queuedCount} queued, ${report.cache.catalog.loadingCount} loading, ${report.cache.catalog.failedCount} failed.`,
  );
  console.log(
    `State snapshot: ${report.snapshotManifest}; offline output ${report.offlineOutput.status} (${report.offlineOutput.sessionCount} sessions, search ${report.offlineOutput.searchIndex}).`,
  );
  if (report.offlineOutput.missingFiles.length > 0) {
    const shown = report.offlineOutput.missingFiles.slice(0, 20);
    console.log(`Offline output missing: ${shown.join(", ")}`);
    if (shown.length < report.offlineOutput.missingFiles.length) {
      console.log(
        `Offline output has ${report.offlineOutput.missingFiles.length - shown.length} more missing files.`,
      );
    }
  }
  for (const diagnostic of report.diagnostics) {
    console.log(
      `[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}${diagnostic.path === null ? "" : ` (${diagnostic.path})`}`,
    );
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
