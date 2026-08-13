import { resolve } from "node:path";

import { parseExportArguments } from "../server/export/cliArguments.ts";
import { runStaticExport, type StaticExportSummary } from "../server/export/exportPipeline.ts";
import { CliExportProgress } from "../server/export/exportProgress.ts";

const HELP = `Codex Sessions Viewer static export

Usage: pnpm export [options]

Options:
  --codex-home <path>  Read sessions from this Codex home
  --output <path>      Write the generated site to this directory
  --offline            Disable remote favicon requests
  --force              Retransform every discovered session
  --help               Show this help and exit`;

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2);
  if (rawArguments.includes("--help")) {
    console.log(HELP);
    return;
  }

  const args = parseExportArguments(rawArguments);
  const progress = new CliExportProgress();
  let summary: StaticExportSummary;
  try {
    summary = await runStaticExport({
      codexHome: args.codexHome,
      outputRoot: args.output === undefined ? undefined : resolve(args.output),
      offline: args.offline,
      force: args.force,
      progress,
    });
  } catch (error) {
    progress.step("Export failed", "failure");
    throw error;
  } finally {
    progress.finish();
  }
  console.log(
    `Codex Sessions Viewer export: ${summary.sessionCount} sessions, ${summary.transformed} transformed, ${summary.reused} reused, ${summary.failed} failed.`,
  );
  console.log(`Static output: ${summary.outputRoot}`);
  console.log(
    `Pagefind: ${summary.pagefindRecords} turn records; content: ${summary.publishedAssets} assets and ${summary.publishedFavicons} favicons.`,
  );
  if (Object.keys(summary.diagnosticCounts).length > 0) {
    console.log(`Diagnostics: ${JSON.stringify(summary.diagnosticCounts)}`);
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
