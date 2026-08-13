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
    `Viewer cache: ${report.cache.status}; ${report.cache.sessionCount} sessions and ${report.cache.diagnosticCount} parser diagnostics.`,
  );
  console.log(
    `State snapshot: ${report.snapshotManifest}; offline output ${report.capabilities.offline ? "available" : "missing"}.`,
  );
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
