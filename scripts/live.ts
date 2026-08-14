import { spawn } from "node:child_process";

import { loadServerViewerConfig } from "../server/core/config.ts";

const HOST = "127.0.0.1";
const HELP = `Codex Sessions Viewer live server

Usage: pnpm live [options]

Options:
  --codex-home <path>  Read sessions from this Codex home
  -p, --port <number>  Listen on this loopback port
  --help               Show this help and exit`;

interface LiveArguments {
  codexHome?: string | undefined;
  port?: number | undefined;
}

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function portValue(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function parseArguments(args: readonly string[]): LiveArguments {
  const parsed: LiveArguments = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--codex-home") {
      parsed.codexHome = optionValue(args, index, argument);
      index += 1;
    } else if (argument.startsWith("--codex-home=")) {
      parsed.codexHome = argument.slice("--codex-home=".length);
    } else if (argument === "--port" || argument === "-p") {
      parsed.port = portValue(optionValue(args, index, argument));
      index += 1;
    } else if (argument.startsWith("--port=")) {
      parsed.port = portValue(argument.slice("--port=".length));
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (parsed.codexHome === "") {
    throw new Error("--codex-home requires a value");
  }
  return parsed;
}

async function runNuxt(codexHome: string, port: number): Promise<void> {
  const pnpmEntrypoint = process.env["npm_execpath"]?.trim();
  const javascriptEntrypoint = pnpmEntrypoint !== undefined && /\.[cm]?js$/iu.test(pnpmEntrypoint);
  const command = javascriptEntrypoint
    ? process.execPath
    : (pnpmEntrypoint ?? (process.platform === "win32" ? "pnpm.cmd" : "pnpm"));
  const args = javascriptEntrypoint
    ? [pnpmEntrypoint, "exec", "nuxt", "dev", "--host", HOST, "--port", String(port)]
    : ["exec", "nuxt", "dev", "--host", HOST, "--port", String(port)];
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_VIEWER_MODE: "live",
        CODEX_VIEWER_CODEX_HOME: codexHome,
        CODEX_VIEWER_PORT: String(port),
      },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectProcess);
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") {
        resolveProcess();
        return;
      }
      rejectProcess(
        new Error(
          `Nuxt live server stopped${signal === null ? ` with exit code ${String(code)}` : ` after signal ${signal}`}.`,
        ),
      );
    });
  });
}

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2);
  if (rawArguments.includes("--help")) {
    console.log(HELP);
    return;
  }
  const parsedArguments = parseArguments(rawArguments);
  const config = await loadServerViewerConfig({ cli: parsedArguments });
  if (config.onboardingRequired) {
    throw new Error(
      config.diagnostics.find(({ code }) => code.startsWith("codex_home."))?.message ??
        "The selected Codex home is unavailable.",
    );
  }
  console.log(`Starting Codex Sessions Viewer on http://${HOST}:${config.settings.port}`);
  console.log(`Reading ${config.settings.codexHome} in read-only mode.`);
  await runNuxt(config.settings.codexHome, config.settings.port);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
