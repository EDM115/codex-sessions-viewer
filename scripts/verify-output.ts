import { resolve } from "node:path";

import {
  parseVerifyOutputArguments,
  verifyGeneratedOutput,
} from "../server/export/verifyOutput.ts";

const HELP = `Codex Sessions Viewer generated-output verification

Usage: pnpm verify:output [options]

Options:
  --output <path>  Verify this generated public directory (default: .output/public)
  --help           Show this help and exit`;

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2);
  if (rawArguments.includes("--help")) {
    console.log(HELP);
    return;
  }
  const arguments_ = parseVerifyOutputArguments(rawArguments);
  const summary = await verifyGeneratedOutput(resolve(arguments_.output));
  console.log(
    `Verified ${summary.sessionCount} sessions, ${summary.turnCount} turns, ${summary.assetCount} assets, and ${summary.faviconCount} favicons across ${summary.checkedFiles} files.`,
  );
  console.log(`Search index: ${summary.searchIndex ? "Pagefind" : "disabled"}.`);
  console.log(`Generated output: ${summary.publicRoot}`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
